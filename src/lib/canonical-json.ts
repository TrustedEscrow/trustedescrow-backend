import { createHash } from 'node:crypto';

/**
 * RFC 8785 (JSON Canonicalization Scheme) serialisation.
 *
 * `terms_hash = sha256(canonical_json(terms))` is committed on-chain at creation and
 * recomputed by the arbitrator console during a dispute (ARCHITECTURE §7). Any drift
 * between clients here shows up as a false "terms were rewritten" warning, so the
 * rules are strict: object keys sorted by UTF-16 code unit, no whitespace, numbers
 * in ECMAScript shortest form, and non-finite numbers rejected. Amounts are carried
 * as decimal strings so no float ever enters the hash.
 */
export function canonicalJson(value: unknown): string {
  if (value === null) return 'null';
  switch (typeof value) {
    case 'boolean':
      return value ? 'true' : 'false';
    case 'number':
      if (!Number.isFinite(value)) throw new TypeError('canonicalJson: non-finite number');
      return JSON.stringify(value);
    case 'string':
      return JSON.stringify(value);
    case 'object': {
      if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
      const entries = Object.entries(value as Record<string, unknown>).filter(([, v]) => v !== undefined);
      // Default sort compares UTF-16 code units, which is what RFC 8785 requires.
      entries.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
      return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(',')}}`;
    }
    default:
      throw new TypeError(`canonicalJson: unsupported type ${typeof value}`);
  }
}

export function termsHashHex(terms: unknown): string {
  return createHash('sha256').update(canonicalJson(terms), 'utf8').digest('hex');
}
