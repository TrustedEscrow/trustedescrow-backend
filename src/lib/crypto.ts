import { createCipheriv, createDecipheriv, createHash, randomBytes, timingSafeEqual } from 'node:crypto';

/**
 * Server-side encryption for secrets the server legitimately needs to read back
 * (TOTP seeds). This key has nothing to do with delivery codes: the vault stores
 * client-encrypted ciphertext the server has no key for.
 */
export class SecretBox {
  private readonly key: Buffer;

  constructor(base64Key: string) {
    this.key = Buffer.from(base64Key, 'base64');
    if (this.key.length !== 32) throw new Error('SecretBox key must be 32 bytes');
  }

  seal(plaintext: Buffer, aad = ''): string {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.key, iv);
    cipher.setAAD(Buffer.from(aad, 'utf8'));
    const ct = Buffer.concat([cipher.update(plaintext), cipher.final()]);
    return ['v1', iv.toString('base64'), ct.toString('base64'), cipher.getAuthTag().toString('base64')].join('.');
  }

  open(sealed: string, aad = ''): Buffer {
    const [version, iv, ct, tag] = sealed.split('.');
    if (version !== 'v1' || !iv || !ct || !tag) throw new Error('SecretBox: malformed sealed value');
    const decipher = createDecipheriv('aes-256-gcm', this.key, Buffer.from(iv, 'base64'));
    decipher.setAAD(Buffer.from(aad, 'utf8'));
    decipher.setAuthTag(Buffer.from(tag, 'base64'));
    return Buffer.concat([decipher.update(Buffer.from(ct, 'base64')), decipher.final()]);
  }
}

/** Opaque bearer tokens are stored only as their SHA-256. */
export function newToken(bytes = 32): string {
  return randomBytes(bytes).toString('base64url');
}

export function sha256Hex(data: string | Uint8Array): string {
  return createHash('sha256').update(data).digest('hex');
}

export function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}
