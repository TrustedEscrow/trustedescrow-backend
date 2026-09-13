import { randomBytes } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { parse } from '../http/validation.js';
import { audit } from '../lib/audit.js';
import { newToken, sha256Hex } from '../lib/crypto.js';
import { badRequest, unauthorized } from '../lib/errors.js';
import { isAccountAddress, verifySignedMessage } from '../lib/stellar.js';
import { auth, authenticate, authenticatePending } from './session.js';
import { isTwoFactorEnabled, verifySecondFactor } from './two-factor.js';

const PENDING_SESSION_TTL_MS = 10 * 60 * 1000;
const authRateLimit = { rateLimit: { max: 20, timeWindow: '1 minute' } };

const ChallengeBody = z.object({
  address: z.string().refine(isAccountAddress, 'must be a Stellar account address (G…)'),
});
const LoginBody = z.object({
  challengeId: z.uuid(),
  signature: z.string().min(1).max(256),
  /** Random identifier the client generates once and keeps in local storage. */
  deviceId: z.string().min(16).max(128),
  deviceLabel: z.string().max(100).optional(),
});
const CodeBody = z.object({ code: z.string().min(6).max(20) });
const StepUpBody = z.union([
  CodeBody,
  z.object({ challengeId: z.uuid(), signature: z.string().min(1).max(256) }),
]);

export async function authRoutes(app: FastifyInstance): Promise<void> {
  const { db, config } = app.deps;
  const now = () => app.deps.now();

  async function createChallenge(address: string, purpose: 'login' | 'step_up') {
    const issued = now();
    const expires = new Date(issued.getTime() + config.AUTH_CHALLENGE_TTL_SECONDS * 1000);
    const nonce = randomBytes(16).toString('hex');
    const message = [
      `${config.AUTH_DOMAIN} wants you to ${purpose === 'login' ? 'sign in' : 're-authenticate'} with your Stellar account:`,
      address,
      '',
      'This signature does not authorise any transaction.',
      '',
      `Purpose: ${purpose}`,
      `Network: ${config.STELLAR_NETWORK_PASSPHRASE}`,
      `Nonce: ${nonce}`,
      `Issued At: ${issued.toISOString()}`,
      `Expiration Time: ${expires.toISOString()}`,
    ].join('\n');
    const row = await db
      .insertInto('auth_challenges')
      .values({ address, purpose, message, expires_at: expires })
      .returning(['id', 'message', 'expires_at'])
      .executeTakeFirstOrThrow();
    return { challengeId: row.id, message: row.message, expiresAt: row.expires_at };
  }

  /** Verifies and burns a challenge. Single use, even on a bad signature. */
  async function consumeChallenge(id: string, purpose: 'login' | 'step_up', signature: string, expectedAddress?: string) {
    const ch = await db
      .updateTable('auth_challenges')
      .set({ used_at: now() })
      .where('id', '=', id)
      .where('purpose', '=', purpose)
      .where('used_at', 'is', null)
      .where('expires_at', '>', now())
      .returningAll()
      .executeTakeFirst();
    if (!ch) throw unauthorized('Challenge is invalid, used or expired');
    if (expectedAddress && ch.address !== expectedAddress) throw unauthorized('Challenge was issued for a different account');
    if (!verifySignedMessage(ch.address, ch.message, signature)) throw unauthorized('Signature verification failed');
    return ch;
  }

  app.post('/auth/challenge', { config: authRateLimit }, async (req) => {
    const { address } = parse(ChallengeBody, req.body);
    return createChallenge(address, 'login');
  });

  /**
   * Sign in with a SEP-53 signature over the challenge. A device the user hasn't
   * verified with 2FA gets a `pending_2fa` session until POST /auth/2fa succeeds.
   */
  app.post('/auth/login', { config: authRateLimit }, async (req, reply) => {
    const body = parse(LoginBody, req.body);
    const ch = await consumeChallenge(body.challengeId, 'login', body.signature);
    const t = now();

    await db
      .insertInto('users')
      .values({ address: ch.address, payout_address: ch.address })
      .onConflict((oc) => oc.column('address').doNothing())
      .execute();
    const user = await db.selectFrom('users').selectAll().where('address', '=', ch.address).executeTakeFirstOrThrow();

    const device = await db
      .insertInto('devices')
      .values({ user_id: user.id, device_key_hash: sha256Hex(body.deviceId), label: body.deviceLabel ?? null })
      .onConflict((oc) => oc.columns(['user_id', 'device_key_hash']).doUpdateSet({ last_seen_at: t }))
      .returningAll()
      .executeTakeFirstOrThrow();

    const twoFactor = isTwoFactorEnabled(user);
    const status = twoFactor && !device.trusted_at ? 'pending_2fa' : 'active';
    if (!twoFactor && !device.trusted_at) {
      await db.updateTable('devices').set({ trusted_at: t }).where('id', '=', device.id).execute();
    }

    const token = newToken();
    const expiresAt = new Date(t.getTime() + (status === 'active' ? config.SESSION_TTL_SECONDS * 1000 : PENDING_SESSION_TTL_MS));
    await db
      .insertInto('sessions')
      .values({
        user_id: user.id,
        device_id: device.id,
        token_hash: sha256Hex(token),
        status,
        ip: req.ip,
        user_agent: req.headers['user-agent']?.slice(0, 300) ?? null,
        expires_at: expiresAt,
      })
      .execute();
    await audit(db, req, user.id, 'auth.login', device.id, { status, newDevice: !device.trusted_at });

    reply.code(201);
    return { token, status, requiresTwoFactor: status === 'pending_2fa', expiresAt };
  });

  /** Completes a new-device login. */
  app.post('/auth/2fa', { preHandler: authenticatePending, config: authRateLimit }, async (req) => {
    const { user, session } = auth(req);
    const { code } = parse(CodeBody, req.body);
    if (session.status !== 'pending_2fa') throw badRequest('NOT_PENDING', 'Session does not need 2FA');
    if (!(await verifySecondFactor(app.deps, user, code))) {
      await audit(db, req, user.id, 'auth.2fa_failed', session.device_id);
      throw unauthorized('Invalid code');
    }
    const t = now();
    const expiresAt = new Date(t.getTime() + config.SESSION_TTL_SECONDS * 1000);
    await db.updateTable('sessions').set({ status: 'active', step_up_at: t, expires_at: expiresAt }).where('id', '=', session.id).execute();
    await db.updateTable('devices').set({ trusted_at: t }).where('id', '=', session.device_id).execute();
    await audit(db, req, user.id, 'auth.device_trusted', session.device_id);
    return { status: 'active', expiresAt };
  });

  /** For users without 2FA, step-up is a fresh wallet signature. */
  app.post('/auth/step-up/challenge', { preHandler: authenticate, config: authRateLimit }, async (req) => {
    return createChallenge(auth(req).user.address, 'step_up');
  });

  app.post('/auth/step-up', { preHandler: authenticate, config: authRateLimit }, async (req) => {
    const { user, session } = auth(req);
    const body = parse(StepUpBody, req.body);
    if (isTwoFactorEnabled(user)) {
      if (!('code' in body)) throw badRequest('TWO_FACTOR_CODE_REQUIRED', 'This account has 2FA enabled; step up with your authenticator code');
      if (!(await verifySecondFactor(app.deps, user, body.code))) {
        await audit(db, req, user.id, 'auth.step_up_failed');
        throw unauthorized('Invalid code');
      }
    } else {
      if (!('challengeId' in body)) throw badRequest('SIGNATURE_REQUIRED', 'Step up by signing a step-up challenge with your wallet');
      await consumeChallenge(body.challengeId, 'step_up', body.signature, user.address);
    }
    const t = now();
    await db.updateTable('sessions').set({ step_up_at: t }).where('id', '=', session.id).execute();
    await audit(db, req, user.id, 'auth.step_up');
    return { stepUpUntil: new Date(t.getTime() + config.STEP_UP_TTL_SECONDS * 1000) };
  });

  app.post('/auth/logout', { preHandler: authenticatePending }, async (req, reply) => {
    await db.updateTable('sessions').set({ revoked_at: now() }).where('id', '=', auth(req).session.id).execute();
    reply.code(204);
  });
}
