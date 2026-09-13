import type { FastifyRequest } from 'fastify';
import type { AppDeps } from '../app.js';
import type { Session, User } from '../db/schema.js';
import { sha256Hex } from '../lib/crypto.js';
import { HttpError, forbidden, unauthorized } from '../lib/errors.js';

export interface AuthContext {
  user: User;
  session: Session;
  isArbitrator: boolean;
}

export function bearerToken(req: FastifyRequest): string | null {
  const h = req.headers.authorization;
  if (!h) return null;
  const m = /^Bearer\s+(\S+)$/i.exec(h);
  return m?.[1] ?? null;
}

export async function loadSession(deps: AppDeps, token: string): Promise<AuthContext | null> {
  const now = deps.now();
  const session = await deps.db
    .selectFrom('sessions')
    .selectAll()
    .where('token_hash', '=', sha256Hex(token))
    .where('revoked_at', 'is', null)
    .where('expires_at', '>', now)
    .executeTakeFirst();
  if (!session) return null;
  const user = await deps.db.selectFrom('users').selectAll().where('id', '=', session.user_id).executeTakeFirst();
  if (!user) return null;
  return { user, session, isArbitrator: deps.config.ARBITRATOR_ADDRESSES.includes(user.address) };
}

function guard(allowPending: boolean) {
  return async (req: FastifyRequest): Promise<void> => {
    const token = bearerToken(req);
    if (!token) throw unauthorized();
    const ctx = await loadSession(req.server.deps, token);
    if (!ctx) throw unauthorized('Invalid or expired session');
    if (ctx.session.status === 'pending_2fa' && !allowPending) {
      throw forbidden('Two-factor verification required for this device', 'TWO_FACTOR_REQUIRED');
    }
    req.auth = ctx;
  };
}

/** Fully authenticated session. */
export const authenticate = guard(false);
/** Also admits a session still waiting on new-device 2FA. */
export const authenticatePending = guard(true);

export function auth(req: FastifyRequest): AuthContext {
  if (!req.auth) throw unauthorized();
  return req.auth;
}

/**
 * 2FA gate for backend-mediated sensitive actions (ARCHITECTURE §6 "2FA"): changing the
 * payout address, revealing the delivery code ciphertext, opening a dispute case.
 * It protects the session; it does not and cannot gate on-chain calls.
 */
export async function requireStepUp(req: FastifyRequest): Promise<void> {
  const { session } = auth(req);
  const ttlMs = req.server.deps.config.STEP_UP_TTL_SECONDS * 1000;
  const at = session.step_up_at;
  if (!at || req.server.deps.now().getTime() - at.getTime() > ttlMs) {
    throw new HttpError(403, 'STEP_UP_REQUIRED', 'Re-authenticate with your second factor to continue');
  }
}

export async function requireArbitrator(req: FastifyRequest): Promise<void> {
  if (!auth(req).isArbitrator) throw forbidden('Arbitrator role required');
}
