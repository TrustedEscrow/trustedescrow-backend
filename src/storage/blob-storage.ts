import { DeleteObjectCommand, GetObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { createReadStream } from 'node:fs';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { dirname, resolve, sep } from 'node:path';
import type { Readable } from 'node:stream';
import type { Config } from '../config.js';

/** Dispute evidence blobs (photos, documents). */
export interface BlobStorage {
  put(key: string, data: Buffer): Promise<void>;
  read(key: string): Promise<Readable>;
  delete(key: string): Promise<void>;
}

/** Local disk. Doesn't survive a redeploy or scale across instances — fine for development, not production. */
export class LocalBlobStorage implements BlobStorage {
  private readonly root: string;

  constructor(root: string) {
    this.root = resolve(root);
  }

  private path(key: string): string {
    const p = resolve(this.root, key);
    if (!p.startsWith(this.root + sep)) throw new Error('storage key escapes root');
    return p;
  }

  async put(key: string, data: Buffer): Promise<void> {
    const p = this.path(key);
    await mkdir(dirname(p), { recursive: true });
    await writeFile(p, data, { flag: 'wx' });
  }

  async read(key: string): Promise<Readable> {
    return createReadStream(this.path(key));
  }

  async delete(key: string): Promise<void> {
    await rm(this.path(key), { force: true });
  }
}

/**
 * Any S3-compatible object store: real AWS S3 (omit `endpoint`), or a compatible
 * provider (R2, MinIO, etc.) via `endpoint` and, for providers that need
 * virtual-hosted-style disabled, `forcePathStyle`.
 */
export class S3BlobStorage implements BlobStorage {
  private readonly client: S3Client;

  constructor(
    private readonly bucket: string,
    opts: { region: string; endpoint?: string; accessKeyId?: string; secretAccessKey?: string; forcePathStyle?: boolean },
  ) {
    this.client = new S3Client({
      region: opts.region,
      ...(opts.endpoint ? { endpoint: opts.endpoint } : {}),
      ...(opts.forcePathStyle ? { forcePathStyle: true } : {}),
      ...(opts.accessKeyId && opts.secretAccessKey
        ? { credentials: { accessKeyId: opts.accessKeyId, secretAccessKey: opts.secretAccessKey } }
        : {}),
    });
  }

  async put(key: string, data: Buffer): Promise<void> {
    await this.client.send(new PutObjectCommand({ Bucket: this.bucket, Key: key, Body: data }));
  }

  async read(key: string): Promise<Readable> {
    const res = await this.client.send(new GetObjectCommand({ Bucket: this.bucket, Key: key }));
    return res.Body as Readable;
  }

  async delete(key: string): Promise<void> {
    await this.client.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: key }));
  }
}

export function createBlobStorage(config: Config): BlobStorage {
  if (config.EVIDENCE_STORAGE_DRIVER === 's3') {
    if (!config.EVIDENCE_S3_BUCKET) throw new Error('EVIDENCE_STORAGE_DRIVER=s3 requires EVIDENCE_S3_BUCKET');
    return new S3BlobStorage(config.EVIDENCE_S3_BUCKET, {
      region: config.EVIDENCE_S3_REGION,
      endpoint: config.EVIDENCE_S3_ENDPOINT || undefined,
      accessKeyId: config.EVIDENCE_S3_ACCESS_KEY_ID || undefined,
      secretAccessKey: config.EVIDENCE_S3_SECRET_ACCESS_KEY || undefined,
      forcePathStyle: config.EVIDENCE_S3_FORCE_PATH_STYLE,
    });
  }
  return new LocalBlobStorage(config.EVIDENCE_STORAGE_DIR);
}
