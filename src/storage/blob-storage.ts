import { createReadStream } from 'node:fs';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { dirname, resolve, sep } from 'node:path';
import type { Readable } from 'node:stream';

/** Dispute evidence blobs (photos, documents). Swap for an object store in production. */
export interface BlobStorage {
  put(key: string, data: Buffer): Promise<void>;
  read(key: string): Readable;
  delete(key: string): Promise<void>;
}

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

  read(key: string): Readable {
    return createReadStream(this.path(key));
  }

  async delete(key: string): Promise<void> {
    await rm(this.path(key), { force: true });
  }
}
