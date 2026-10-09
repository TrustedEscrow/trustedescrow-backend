import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTestContext, type TestContext } from './helpers.js';

const WEB = 'https://trustedescrow-frontend-eta.vercel.app';

let ctx: TestContext;
beforeEach(async () => {
  ctx = await createTestContext({ CORS_ORIGINS: WEB });
});
afterEach(async () => {
  await ctx.app.close();
  await ctx.db.destroy();
});

const preflight = (method: string, url = '/drafts/abc/vault') =>
  ctx.app.inject({
    method: 'OPTIONS',
    url,
    headers: {
      origin: WEB,
      'access-control-request-method': method,
      'access-control-request-headers': 'content-type,authorization',
    },
  });

/** Every `app.<method>(` across the source tree, which is what CORS has to cover. */
async function methodsUsedByRoutes(): Promise<Set<string>> {
  const found = new Set<string>();
  const walk = async (dir: string): Promise<void> => {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) await walk(path);
      else if (entry.name.endsWith('.ts')) {
        const src = await readFile(path, 'utf8');
        for (const m of src.matchAll(/\bapp\.(get|post|put|patch|delete)\s*\(/g)) found.add(m[1]!.toUpperCase());
      }
    }
  };
  await walk('src');
  return found;
}

describe('CORS', () => {
  // The bug this guards: @fastify/cors defaults to GET,HEAD,POST, so a PUT
  // preflight answered 204 while omitting PUT from allow-methods. The browser
  // then refuses to send the request, the client reports a network error, and
  // the vault write behind escrow creation fails with nothing in the API log.
  it('advertises every method the routes actually use', async () => {
    const res = await preflight('PUT');
    expect(res.statusCode).toBe(204);
    const allowed = new Set(
      (res.headers['access-control-allow-methods'] as string).split(',').map((m) => m.trim().toUpperCase()),
    );
    for (const method of await methodsUsedByRoutes()) {
      expect(allowed, `CORS does not allow ${method}, which some route serves`).toContain(method);
    }
  });

  it('allows a preflight for the vault write that escrow creation depends on', async () => {
    const res = await preflight('PUT');
    expect(res.statusCode).toBe(204);
    expect(res.headers['access-control-allow-origin']).toBe(WEB);
    expect(res.headers['access-control-allow-headers']).toMatch(/authorization/i);
  });

  it.each(['GET', 'POST', 'PUT', 'PATCH', 'DELETE'])('permits %s from the configured origin', async (method) => {
    const res = await preflight(method);
    expect((res.headers['access-control-allow-methods'] as string).toUpperCase()).toContain(method);
  });

  it('still refuses an origin that is not configured', async () => {
    const res = await ctx.app.inject({
      method: 'OPTIONS',
      url: '/drafts/abc/vault',
      headers: { origin: 'https://evil.example.com', 'access-control-request-method': 'PUT' },
    });
    expect(res.headers['access-control-allow-origin']).toBeUndefined();
  });

  it('reflects the allowed origin on a plain request, not a wildcard', async () => {
    const res = await ctx.app.inject({ method: 'GET', url: '/healthz', headers: { origin: WEB } });
    expect(res.headers['access-control-allow-origin']).toBe(WEB);
    expect(res.headers['access-control-allow-origin']).not.toBe('*');
  });
});
