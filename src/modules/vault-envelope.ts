import { z } from 'zod';
import { bytesContainDeliveryCode, CODE_LENGTH, containsDeliveryCode } from '../lib/delivery-code.js';

/**
 * Envelope format for the encrypted code vault (ARCHITECTURE §6).
 *
 * The buyer's client encrypts the 16-byte canonical code under a key derived from the
 * buyer's own credential and uploads only this envelope. The server has no key and
 * cannot decrypt it. What the server *can* do is refuse envelopes that would weaken
 * the scheme:
 *
 * - ciphertext must be exactly code + AEAD tag (32 bytes), so nothing else can be
 *   smuggled in and plaintext can't be stored by mistake under another label;
 * - password KDFs must meet a work-factor floor, because a stolen database gives an
 *   attacker the ciphertext and the AEAD tag to test password guesses offline;
 * - no field may contain the plaintext code itself.
 */

const AEAD_TAG_BYTES = 16;
export const CIPHERTEXT_BYTES = CODE_LENGTH + AEAD_TAG_BYTES;
const NONCE_BYTES = { A256GCM: 12, XC20P: 24 } as const;

const b64 = z.string().min(1).max(512).regex(/^[A-Za-z0-9+/_-]+={0,2}$/, 'must be base64');

export const EnvelopeInput = z
  .object({
    /** Identifies which buyer credential can open this envelope (e.g. a passkey credential id). */
    credentialId: z.string().min(1).max(256).regex(/^[A-Za-z0-9._:+/=-]+$/),
    alg: z.enum(['A256GCM', 'XC20P']),
    kdf: z.discriminatedUnion('name', [
      z.object({ name: z.literal('webauthn-prf'), salt: b64 }).strict(),
      z
        .object({
          name: z.literal('argon2id'),
          salt: b64,
          memoryKiB: z.number().int().min(65536).max(4 * 1024 * 1024),
          iterations: z.number().int().min(3).max(64),
          parallelism: z.number().int().min(1).max(16),
        })
        .strict(),
      z
        .object({
          name: z.literal('pbkdf2-sha256'),
          salt: b64,
          iterations: z.number().int().min(600_000).max(10_000_000),
        })
        .strict(),
    ]),
    iv: b64,
    ciphertext: b64,
  })
  .strict();

export type EnvelopeInputT = z.output<typeof EnvelopeInput>;

/** Returns a reason to reject the envelope, or null if it is acceptable. */
export function envelopeProblem(env: EnvelopeInputT, releaseCodeHash: string): string | null {
  const iv = Buffer.from(env.iv, 'base64');
  const ct = Buffer.from(env.ciphertext, 'base64');
  const salt = Buffer.from(env.kdf.salt, 'base64');
  if (iv.length !== NONCE_BYTES[env.alg]) return `iv must be ${NONCE_BYTES[env.alg]} bytes for ${env.alg}`;
  if (ct.length !== CIPHERTEXT_BYTES) return `ciphertext must be exactly ${CIPHERTEXT_BYTES} bytes (16-byte code plus AEAD tag)`;
  if (salt.length < 16 || salt.length > 64) return 'kdf salt must be 16–64 bytes';
  if (
    bytesContainDeliveryCode(ct, releaseCodeHash) ||
    bytesContainDeliveryCode(iv, releaseCodeHash) ||
    containsDeliveryCode(JSON.stringify(env), releaseCodeHash)
  ) {
    return 'envelope contains the plaintext delivery code; encrypt on the client before uploading';
  }
  return null;
}
