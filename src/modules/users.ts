import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { auth, authenticate, requireStepUp } from '../auth/session.js';
import { isTwoFactorEnabled, issueBackupCodes, totpAad, verifySecondFactor } from '../auth/two-factor.js';
import type { User } from '../db/schema.js';
import { IdParams, StellarAddress, parse } from '../http/validation.js';
import { audit } from '../lib/audit.js';
import { newToken, sha256Hex } from '../lib/crypto.js';
import { badRequest, conflict, notFound, unauthorized } from '../lib/errors.js';
import { generateTotpSecret, otpauthUri, verifyTotp, base32Encode } from '../lib/totp.js';
import { notifyUsers } from '../notifications/store.js';

const EMAIL_TOKEN_TTL_MS = 24 * 3600 * 1000;

export function presentUser(user: User, isArbitrator: boolean) {
  return {
    id: user.id,
    address: user.address,
    payoutAddress: user.payout_address,
    displayName: user.display_name,
    email: user.email,
    emailVerified: user.email_verified_at !== null,
    twoFactorEnabled: isTwoFactorEnabled(user),
    roles: isArbitrator ? ['arbitrator'] : [],
    createdAt: user.created_at,
  };
}

export async function userRoutes(app: FastifyInstance): Promise<void> {
  const { db, config, mailer, secretBox } = app.deps;
  const now = () => app.deps.now();
  const sensitive = { preHandler: [authenticate, requireStepUp] };
  const twoFactorRateLimit = { rateLimit: { max: 10, timeWindow: '1 minute' } };

  app.get('/me', { preHandler: authenticate }, async (req) => {
    const { user, isArbitrator } = auth(req);
    return presentUser(user, isArbitrator);
  });

  app.patch('/me', { preHandler: authenticate }, async (req) => {
    const { user, isArbitrator } = auth(req);
    const body = parse(z.object({ displayName: z.string().trim().min(1).max(80).nullable() }), req.body);
    const updated = await db
      .updateTable('users')
      .set({ display_name: body.displayName, updated_at: now() })
      .where('id', '=', user.id)
      .returningAll()
      .executeTakeFirstOrThrow();
    return presentUser(updated, isArbitrator);
  });

  /**
   * The address this user is paid at when they sell. It is written into the `seller`
   * field of new draft terms, so changing it redirects future payouts: 2FA-gated,
   * audited, and the user is told.
   */
  app.put('/me/payout-address', sensitive, async (req) => {
    const { user, isArbitrator } = auth(req);
    const { address } = parse(z.object({ address: StellarAddress }), req.body);
    const updated = await db
      .updateTable('users')
      .set({ payout_address: address, updated_at: now() })
      .where('id', '=', user.id)
      .returningAll()
      .executeTakeFirstOrThrow();
    await audit(db, req, user.id, 'user.payout_address_changed', null, { from: user.payout_address, to: address });
    await notifyUsers(db, [user.id], {
      key: `payout_changed:${now().getTime()}`,
      kind: 'payout_address_changed',
      title: 'Payout address changed',
      body: `Your payout address was changed to ${address}. If this wasn't you, sign out all sessions and contact support.`,
    }, now());
    return presentUser(updated, isArbitrator);
  });

  app.put('/me/email', { preHandler: authenticate, config: twoFactorRateLimit }, async (req) => {
    const { user } = auth(req);
    const { email } = parse(z.object({ email: z.email().max(254) }), req.body);
    const token = newToken();
    await db
      .updateTable('users')
      .set({
        email: email.toLowerCase(),
        email_verified_at: null,
        email_verify_token_hash: sha256Hex(token),
        email_verify_expires_at: new Date(now().getTime() + EMAIL_TOKEN_TTL_MS),
        updated_at: now(),
      })
      .where('id', '=', user.id)
      .execute();
    await mailer.send({
      to: email,
      subject: 'Verify your email for TrustEscrow notifications',
      text: `Confirm this address to receive escrow deadline reminders:\n\n${config.PUBLIC_WEB_URL}/verify-email?token=${token}\n\nTrustEscrow will never email you a delivery code.`,
    });
    await audit(db, req, user.id, 'user.email_set');
    return { email: email.toLowerCase(), emailVerified: false };
  });

  app.post('/me/email/verify', { config: twoFactorRateLimit }, async (req) => {
    const { token } = parse(z.object({ token: z.string().min(10).max(200) }), req.body);
    const res = await db
      .updateTable('users')
      .set({ email_verified_at: now(), email_verify_token_hash: null, email_verify_expires_at: null })
      .where('email_verify_token_hash', '=', sha256Hex(token))
      .where('email_verify_expires_at', '>', now())
      .executeTakeFirst();
    if (Number(res.numUpdatedRows) !== 1) throw badRequest('INVALID_TOKEN', 'Verification link is invalid or expired');
    return { emailVerified: true };
  });

  app.get('/me/sessions', { preHandler: authenticate }, async (req) => {
    const { user, session } = auth(req);
    const rows = await db
      .selectFrom('sessions')
      .innerJoin('devices', 'devices.id', 'sessions.device_id')
      .select(['sessions.id', 'sessions.status', 'sessions.created_at', 'sessions.expires_at', 'sessions.ip', 'sessions.user_agent', 'devices.label as device_label'])
      .where('sessions.user_id', '=', user.id)
      .where('sessions.revoked_at', 'is', null)
      .where('sessions.expires_at', '>', now())
      .orderBy('sessions.created_at', 'desc')
      .execute();
    return rows.map((r) => ({ ...r, current: r.id === session.id }));
  });

  app.delete('/me/sessions/:id', { preHandler: authenticate }, async (req, reply) => {
    const { user } = auth(req);
    const { id } = parse(IdParams, req.params);
    const res = await db
      .updateTable('sessions')
      .set({ revoked_at: now() })
      .where('id', '=', id)
      .where('user_id', '=', user.id)
      .where('revoked_at', 'is', null)
      .executeTakeFirst();
    if (Number(res.numUpdatedRows) !== 1) throw notFound('Session');
    await audit(db, req, user.id, 'auth.session_revoked', id);
    reply.code(204);
  });

  app.get('/me/devices', { preHandler: authenticate }, async (req) => {
    const { user } = auth(req);
    return db
      .selectFrom('devices')
      .select(['id', 'label', 'trusted_at', 'first_seen_at', 'last_seen_at'])
      .where('user_id', '=', user.id)
      .orderBy('last_seen_at', 'desc')
      .execute();
  });

  /** Forget a device: its sessions end and its next login needs 2FA again. */
  app.delete('/me/devices/:id', sensitive, async (req, reply) => {
    const { user } = auth(req);
    const { id } = parse(IdParams, req.params);
    const res = await db.updateTable('devices').set({ trusted_at: null }).where('id', '=', id).where('user_id', '=', user.id).executeTakeFirst();
    if (Number(res.numUpdatedRows) !== 1) throw notFound('Device');
    await db.updateTable('sessions').set({ revoked_at: now() }).where('device_id', '=', id).where('revoked_at', 'is', null).execute();
    await audit(db, req, user.id, 'auth.device_forgotten', id);
    reply.code(204);
  });

  // --- 2FA enrolment -------------------------------------------------------------

  app.post('/me/2fa/setup', sensitive, async (req) => {
    const { user } = auth(req);
    if (isTwoFactorEnabled(user)) throw conflict('TWO_FACTOR_ALREADY_ENABLED', '2FA is already enabled');
    const secret = generateTotpSecret();
    await db
      .updateTable('users')
      .set({ totp_pending_secret_sealed: secretBox.seal(secret, totpAad(user.id)) })
      .where('id', '=', user.id)
      .execute();
    return { secret: base32Encode(secret), otpauthUri: otpauthUri(secret, user.address) };
  });

  /**
   * Confirms enrolment with a first code. The current device becomes the only trusted
   * one and every other session is signed out, so a stolen session can't outlive 2FA.
   */
  app.post('/me/2fa/enable', { preHandler: [authenticate, requireStepUp], config: twoFactorRateLimit }, async (req) => {
    const { user, session } = auth(req);
    const { code } = parse(z.object({ code: z.string().regex(/^\d{6}$/) }), req.body);
    if (isTwoFactorEnabled(user)) throw conflict('TWO_FACTOR_ALREADY_ENABLED', '2FA is already enabled');
    if (!user.totp_pending_secret_sealed) throw badRequest('NO_PENDING_SETUP', 'Call /me/2fa/setup first');
    const secret = secretBox.open(user.totp_pending_secret_sealed, totpAad(user.id));
    const step = verifyTotp(secret, code, null, now().getTime());
    if (step === null) throw unauthorized('Invalid code');

    const t = now();
    const backupCodes = await db.transaction().execute(async (trx) => {
      await trx
        .updateTable('users')
        .set({
          totp_secret_sealed: user.totp_pending_secret_sealed,
          totp_pending_secret_sealed: null,
          totp_enabled_at: t,
          totp_last_step: step,
          totp_failed_attempts: 0,
          updated_at: t,
        })
        .where('id', '=', user.id)
        .execute();
      await trx.updateTable('devices').set({ trusted_at: null }).where('user_id', '=', user.id).where('id', '!=', session.device_id).execute();
      await trx.updateTable('devices').set({ trusted_at: t }).where('id', '=', session.device_id).execute();
      await trx
        .updateTable('sessions')
        .set({ revoked_at: t })
        .where('user_id', '=', user.id)
        .where('id', '!=', session.id)
        .where('revoked_at', 'is', null)
        .execute();
      return issueBackupCodes(trx, user.id);
    });
    await audit(db, req, user.id, 'auth.2fa_enabled');
    return { enabled: true, backupCodes };
  });

  app.post('/me/2fa/disable', { preHandler: [authenticate, requireStepUp], config: twoFactorRateLimit }, async (req) => {
    const { user } = auth(req);
    const { code } = parse(z.object({ code: z.string().min(6).max(20) }), req.body);
    if (!isTwoFactorEnabled(user)) throw badRequest('TWO_FACTOR_NOT_ENABLED', '2FA is not enabled');
    if (!(await verifySecondFactor(app.deps, user, code))) throw unauthorized('Invalid code');
    await db
      .updateTable('users')
      .set({ totp_secret_sealed: null, totp_enabled_at: null, totp_last_step: null, updated_at: now() })
      .where('id', '=', user.id)
      .execute();
    await db.deleteFrom('backup_codes').where('user_id', '=', user.id).execute();
    await audit(db, req, user.id, 'auth.2fa_disabled');
    return { enabled: false };
  });

  app.post('/me/2fa/backup-codes', sensitive, async (req) => {
    const { user } = auth(req);
    if (!isTwoFactorEnabled(user)) throw badRequest('TWO_FACTOR_NOT_ENABLED', '2FA is not enabled');
    const backupCodes = await issueBackupCodes(db, user.id);
    await audit(db, req, user.id, 'auth.backup_codes_regenerated');
    return { backupCodes };
  });
}
