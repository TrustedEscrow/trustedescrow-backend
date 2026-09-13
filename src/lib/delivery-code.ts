import { createHash } from 'node:crypto';

/**
 * Delivery code helpers (ARCHITECTURE §4 "The delivery code").
 *
 * The backend never generates, stores or accepts a plaintext code. These helpers exist
 * for one defensive purpose: recognising a code that a client has leaked into a field
 * where it must not be (a chat message, a "ciphertext" that is really plaintext) so the
 * request can be rejected before anything is persisted. Detection is exact: a candidate
 * is only treated as a code if its hash matches the escrow's on-chain `release_code_hash`.
 */

export const CODE_LENGTH = 16;
const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const ALIASES: Record<string, string> = { I: '1', L: '1', O: '0' };

/** Canonical form: uppercase, separators and whitespace stripped, Crockford aliases mapped. */
export function normaliseCode(input: string): string {
  let out = '';
  for (const raw of input.toUpperCase()) {
    if (raw === '-' || /\s/.test(raw)) continue;
    out += ALIASES[raw] ?? raw;
  }
  return out;
}

export function isCanonicalCode(code: string): boolean {
  return code.length === CODE_LENGTH && [...code].every((c) => CROCKFORD.includes(c));
}

export function codeHashHex(canonicalCode: string): string {
  return createHash('sha256').update(canonicalCode, 'ascii').digest('hex');
}

/**
 * Every 16-character window of Crockford symbols in `text`, after removing separators,
 * whitespace and anything that can't appear in a code. Deliberately over-generates:
 * false candidates are harmless because they must also match the hash.
 */
function* candidateCodes(text: string): Generator<string> {
  const seen = new Set<string>();
  // Split on characters that can't appear inside a (possibly grouped) code.
  for (const chunk of text.toUpperCase().split(/[^0-9A-Z\s-]+/)) {
    const symbols = [...normaliseCode(chunk)].filter((c) => CROCKFORD.includes(c)).join('');
    for (let i = 0; i + CODE_LENGTH <= symbols.length; i++) {
      const candidate = symbols.slice(i, i + CODE_LENGTH);
      if (!seen.has(candidate)) {
        seen.add(candidate);
        yield candidate;
      }
    }
  }
}

/** True if `text` contains the plaintext of the code committed as `releaseCodeHashHex`. */
export function containsDeliveryCode(text: string, releaseCodeHashHex: string): boolean {
  const target = releaseCodeHashHex.toLowerCase();
  for (const candidate of candidateCodes(text)) {
    if (codeHashHex(candidate) === target) return true;
  }
  return false;
}

/** True if raw bytes (e.g. a claimed ciphertext) are, or contain, the plaintext code. */
export function bytesContainDeliveryCode(bytes: Uint8Array, releaseCodeHashHex: string): boolean {
  return containsDeliveryCode(Buffer.from(bytes).toString('latin1'), releaseCodeHashHex);
}
