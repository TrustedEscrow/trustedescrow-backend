import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';
import { LocalBlobStorage } from '../src/storage/blob-storage.js';

const send = vi.fn();
const ctorCalls: unknown[] = [];

vi.mock('@aws-sdk/client-s3', () => ({
  S3Client: class {
    constructor(opts: unknown) {
      ctorCalls.push(opts);
    }
    send = send;
  },
  PutObjectCommand: class {
    constructor(public input: unknown) {}
  },
  GetObjectCommand: class {
    constructor(public input: unknown) {}
  },
  DeleteObjectCommand: class {
    constructor(public input: unknown) {}
  },
}));

describe('LocalBlobStorage', () => {
  it('round-trips a blob and refuses to read outside its root', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'te-blob-'));
    const storage = new LocalBlobStorage(dir);
    const data = Buffer.from('evidence bytes');
    await storage.put('a/b', data);

    const stream = await storage.read('a/b');
    const chunks: Buffer[] = [];
    for await (const chunk of stream) chunks.push(chunk as Buffer);
    expect(Buffer.concat(chunks)).toEqual(data);

    await expect(storage.put('../../escape', data)).rejects.toThrow('storage key escapes root');

    await storage.delete('a/b');
    const missing = await storage.read('a/b');
    await expect(new Promise((resolve, reject) => missing.on('error', reject).on('data', resolve))).rejects.toThrow();
  });
});

describe('S3BlobStorage', () => {
  it('sends Bucket/Key/Body on put, and passes provider options to the client', async () => {
    const { S3BlobStorage } = await import('../src/storage/blob-storage.js');
    send.mockResolvedValueOnce({});
    const storage = new S3BlobStorage('evidence-bucket', {
      region: 'auto',
      endpoint: 'https://s3.example.com',
      accessKeyId: 'AKIA...',
      secretAccessKey: 'secret',
      forcePathStyle: true,
    });

    const ctorOpts = ctorCalls.at(-1) as { endpoint?: string; forcePathStyle?: boolean; credentials?: object };
    expect(ctorOpts.endpoint).toBe('https://s3.example.com');
    expect(ctorOpts.forcePathStyle).toBe(true);
    expect(ctorOpts.credentials).toEqual({ accessKeyId: 'AKIA...', secretAccessKey: 'secret' });

    await storage.put('evidence/1', Buffer.from('x'));
    const putCommand = send.mock.calls.at(-1)![0] as { input: { Bucket: string; Key: string; Body: Buffer } };
    expect(putCommand.input).toMatchObject({ Bucket: 'evidence-bucket', Key: 'evidence/1' });
  });

  it('returns the response body as a stream on read, and sends Bucket/Key on delete', async () => {
    const { S3BlobStorage } = await import('../src/storage/blob-storage.js');
    const storage = new S3BlobStorage('evidence-bucket', { region: 'auto' });
    const body = Readable.from([Buffer.from('x')]);
    send.mockResolvedValueOnce({ Body: body });
    const stream = await storage.read('evidence/1');
    expect(stream).toBe(body);

    send.mockResolvedValueOnce({});
    await storage.delete('evidence/1');
    const deleteCommand = send.mock.calls.at(-1)![0] as { input: { Bucket: string; Key: string } };
    expect(deleteCommand.input).toEqual({ Bucket: 'evidence-bucket', Key: 'evidence/1' });
  });

  it('omits endpoint/forcePathStyle/credentials entirely for plain AWS S3 with no explicit keys', async () => {
    const { S3BlobStorage } = await import('../src/storage/blob-storage.js');
    new S3BlobStorage('bucket', { region: 'us-east-1' });
    const ctorOpts = ctorCalls.at(-1) as Record<string, unknown>;
    expect(ctorOpts).toEqual({ region: 'us-east-1' });
  });
});
