import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { canonicalJson, termsHashHex } from '../src/lib/canonical-json.js';
import { SecretBox } from '../src/lib/crypto.js';
import { codeHashHex, containsDeliveryCode, isCanonicalCode, normaliseCode } from '../src/lib/delivery-code.js';
import { totpAt, verifyTotp } from '../src/lib/totp.js';
import { EnvelopeInput, envelopeProblem } from '../src/modules/vault-envelope.js';
import { grouped, randomCode } from './helpers.js';

describe('canonicalJson (RFC 8785)', () => {
  it('sorts keys recursively with no whitespace', () => {
    expect(canonicalJson({ b: 1, a: [true, null, 'x'], c: { z: 1, y: 2 } })).toBe('{"a":[true,null,"x"],"b":1,"c":{"y":2,"z":1}}');
  });

  it('hashes independently of key insertion order', () => {
    expect(termsHashHex({ a: 1, b: { d: 2, c: 3 } })).toBe(termsHashHex({ b: { c: 3, d: 2 }, a: 1 }));
  });

  it('orders keys by UTF-16 code unit', () => {
    expect(canonicalJson({ é: 1, z: 2, Z: 3 })).toBe('{"Z":3,"z":2,"é":1}');
  });

  it('uses ECMAScript number serialisation and rejects non-finite numbers', () => {
    expect(canonicalJson([1e21, 0.5, -0])).toBe('[1e+21,0.5,0]');
    expect(() => canonicalJson({ a: Number.POSITIVE_INFINITY })).toThrow();
  });

  it('drops undefined members, as JSON storage does', () => {
    expect(canonicalJson({ a: 1, b: undefined })).toBe('{"a":1}');
  });
});

describe('delivery code', () => {
  it('normalises case, separators and Crockford aliases', () => {
    expect(normaliseCode(' k7m2-9xqf 4tbn-r3wd ')).toBe('K7M29XQF4TBNR3WD');
    expect(normaliseCode('IOL0')).toBe('1010');
    expect(isCanonicalCode('K7M29XQF4TBNR3WD')).toBe(true);
    expect(isCanonicalCode('K7M29XQF4TBNR3WU')).toBe(false);
  });

  it('finds the code embedded in text however it is presented', () => {
    const code = randomCode();
    const hash = codeHashHex(code);
    expect(containsDeliveryCode(`my code is ${grouped(code).toLowerCase()}, ok?`, hash)).toBe(true);
    expect(containsDeliveryCode(`ref:${code}!`, hash)).toBe(true);
    expect(containsDeliveryCode(code.split('').join(' '), hash)).toBe(true);
  });

  it('never matches anything but the committed code', () => {
    const code = randomCode();
    const hash = codeHashHex(code);
    const oneOff = code.slice(0, 15) + (code[15] === '0' ? '1' : '0');
    expect(containsDeliveryCode(oneOff, hash)).toBe(false);
    expect(containsDeliveryCode(code.slice(0, 15), hash)).toBe(false);
    expect(containsDeliveryCode(randomCode(), hash)).toBe(false);
  });
});

describe('TOTP (RFC 6238 test vectors, SHA-1, truncated to 6 digits)', () => {
  const secret = Buffer.from('12345678901234567890');

  it('matches the published vectors', () => {
    expect(totpAt(secret, Math.floor(59 / 30))).toBe('287082');
    expect(totpAt(secret, Math.floor(1111111109 / 30))).toBe('081804');
    expect(totpAt(secret, Math.floor(1234567890 / 30))).toBe('005924');
  });

  it('accepts one step of drift, rejects two, and blocks replay', () => {
    const now = 1_800_000_000_000;
    const step = Math.floor(now / 30_000);
    expect(verifyTotp(secret, totpAt(secret, step - 1), null, now)).toBe(step - 1);
    expect(verifyTotp(secret, totpAt(secret, step + 1), null, now)).toBe(step + 1);
    expect(verifyTotp(secret, totpAt(secret, step - 2), null, now)).toBeNull();
    expect(verifyTotp(secret, totpAt(secret, step), step, now)).toBeNull();
  });
});

describe('SecretBox', () => {
  const box = new SecretBox(randomBytes(32).toString('base64'));

  it('round-trips and binds the associated data', () => {
    const sealed = box.seal(Buffer.from('seed'), 'totp:1');
    expect(box.open(sealed, 'totp:1').toString()).toBe('seed');
    expect(() => box.open(sealed, 'totp:2')).toThrow();
  });

  it('detects tampering', () => {
    const parts = box.seal(Buffer.from('seed')).split('.');
    const ct = Buffer.from(parts[2]!, 'base64');
    ct[0]! ^= 1;
    parts[2] = ct.toString('base64');
    expect(() => box.open(parts.join('.'))).toThrow();
  });
});

describe('vault envelope', () => {
  const code = randomCode();
  const hash = codeHashHex(code);
  const b64 = (n: number) => randomBytes(n).toString('base64');
  const envelope = (overrides: Record<string, unknown> = {}) =>
    EnvelopeInput.parse({
      credentialId: 'passkey-credential-1',
      alg: 'A256GCM',
      kdf: { name: 'webauthn-prf', salt: b64(32) },
      iv: b64(12),
      ciphertext: b64(32),
      ...overrides,
    });

  it('accepts code-sized AEAD ciphertext', () => {
    expect(envelopeProblem(envelope(), hash)).toBeNull();
    expect(envelopeProblem(envelope({ alg: 'XC20P', iv: b64(24) }), hash)).toBeNull();
  });

  it('rejects anything but exactly code plus tag', () => {
    expect(envelopeProblem(envelope({ ciphertext: b64(48) }), hash)).toMatch(/exactly 32 bytes/);
    expect(envelopeProblem(envelope({ iv: b64(16) }), hash)).toMatch(/iv/);
  });

  it('rejects the plaintext code wherever it appears', () => {
    const plaintext = Buffer.concat([Buffer.from(code, 'ascii'), randomBytes(16)]).toString('base64');
    expect(envelopeProblem(envelope({ ciphertext: plaintext }), hash)).toMatch(/plaintext/);
    expect(envelopeProblem(envelope({ credentialId: code }), hash)).toMatch(/plaintext/);
  });

  it('enforces password-KDF work factors', () => {
    const weak = { credentialId: 'pw', alg: 'A256GCM', iv: b64(12), ciphertext: b64(32) };
    expect(EnvelopeInput.safeParse({ ...weak, kdf: { name: 'pbkdf2-sha256', salt: b64(16), iterations: 10_000 } }).success).toBe(false);
    expect(
      EnvelopeInput.safeParse({ ...weak, kdf: { name: 'argon2id', salt: b64(16), memoryKiB: 1024, iterations: 3, parallelism: 1 } }).success,
    ).toBe(false);
    expect(EnvelopeInput.safeParse({ ...weak, kdf: { name: 'pbkdf2-sha256', salt: b64(16), iterations: 600_000 } }).success).toBe(true);
  });
});
