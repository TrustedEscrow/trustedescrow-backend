import { randomBytes } from 'node:crypto';
import type { Kysely } from 'kysely';
import type { AppDeps } from '../app.js';
import type { Database, User } from '../db/schema.js';
import { sha256Hex } from '../lib/crypto.js';
import { HttpError } from '../lib/errors.js';
import { verifyTotp } from '../lib/totp.js';

const MAX_FAILURES = 5;
const LOCKOUT_MS = 15 * 60 * 1000;
const BACKUP_CODE_COUNT = 10;
const BACKUP_ALPHABET = '0123456789abcdefghjkmnpqrstvwxyz';

export const totpAad = (userId: string) => `totp:${userId}`;

export function isTwoFactorEnabled(user: Pick<User, 'totp_enabled_at'>): boolean {
  return user.totp_enabled_at !== null;
}

function normaliseBackupCode(code: string): string {
  return code.toLowerCase().replace(/[\s-]/g, '');
}

/** Ten single-use recovery codes, returned once and stored only as hashes. */
export async function issueBackupCodes(db: Kysely<Database>, userId: string): Promise<string[]> {
  const codes = Array.from({ length: BACKUP_CODE_COUNT }, () => {
    const bytes = randomBytes(10);
    const raw = [...bytes].map((b) => BACKUP_ALPHABET[b & 31]).join('');
    return `${raw.slice(0, 5)}-${raw.slice(5)}`;
  });
  await db.deleteFrom('backup_codes').where('user_id', '=', userId).execute();
  await db
    .insertInto('backup_codes')
    .values(codes.map((c) => ({ user_id: userId, code_hash: sha256Hex(normaliseBackupCode(c)) })))
    .execute();
  return codes;
}

/**
 * Verifies a TOTP or backup code for a user with 2FA enabled. TOTP replay is blocked by
 * advancing `totp_last_step` with a conditional update; repeated failures lock 2FA
 * for fifteen minutes.
 */
export async function verifySecondFactor(deps: AppDeps, user: User, code: string): Promise<boolean> {
  const now = deps.now();
  if (!user.totp_secret_sealed || !user.totp_enabled_at) return false;
  if (user.totp_locked_until && user.totp_locked_until > now) {
    throw new HttpError(429, 'TWO_FACTOR_LOCKED', 'Too many failed attempts; try again later');
  }

  let ok = false;
  const trimmed = code.trim();
  if (/^\d{6}$/.test(trimmed)) {
    const secret = deps.secretBox.open(user.totp_secret_sealed, totpAad(user.id));
    const step = verifyTotp(secret, trimmed, user.totp_last_step, now.getTime());
    if (step !== null) {
      const res = await deps.db
        .updateTable('users')
        .set({ totp_last_step: step, totp_failed_attempts: 0, totp_locked_until: null })
        .where('id', '=', user.id)
        .where((eb) => eb.or([eb('totp_last_step', 'is', null), eb('totp_last_step', '<', step)]))
        .executeTakeFirst();
      ok = Number(res.numUpdatedRows) === 1;
    }
  } else {
    const res = await deps.db
      .updateTable('backup_codes')
      .set({ used_at: now })
      .where('user_id', '=', user.id)
      .where('code_hash', '=', sha256Hex(normaliseBackupCode(trimmed)))
      .where('used_at', 'is', null)
      .executeTakeFirst();
    ok = Number(res.numUpdatedRows) === 1;
    if (ok) {
      await deps.db.updateTable('users').set({ totp_failed_attempts: 0, totp_locked_until: null }).where('id', '=', user.id).execute();
    }
  }

  if (!ok) {
    const failures = user.totp_failed_attempts + 1;
    await deps.db
      .updateTable('users')
      .set(
        failures >= MAX_FAILURES
          ? { totp_failed_attempts: 0, totp_locked_until: new Date(now.getTime() + LOCKOUT_MS) }
          : { totp_failed_attempts: failures },
      )
      .where('id', '=', user.id)
      .execute();
  }
  return ok;
}
