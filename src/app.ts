import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import multipart from '@fastify/multipart';
import rateLimit from '@fastify/rate-limit';
import Fastify, { type FastifyInstance, type FastifyServerOptions } from 'fastify';
import { sql } from 'kysely';
import { authRoutes } from './auth/routes.js';
import type { AuthContext } from './auth/session.js';
import type { ChainReader } from './chain/types.js';
import type { Config } from './config.js';
import type { DB } from './db/index.js';
import type { SecretBox } from './lib/crypto.js';
import { HttpError } from './lib/errors.js';
import { arbitrationRoutes } from './modules/arbitration.js';
import { draftRoutes } from './modules/drafts/routes.js';
import { escrowRoutes } from './modules/escrows.js';
import { evidenceRoutes } from './modules/evidence.js';
import { messageRoutes } from './modules/messages.js';
import { notificationRoutes } from './modules/notifications.js';
import { userRoutes } from './modules/users.js';
import { vaultRoutes } from './modules/vault.js';
import type { Mailer } from './notifications/mailer.js';
import type { BlobStorage } from './storage/blob-storage.js';

/**
 * Everything the API needs. Note what is absent: no signing key. The API process
 * cannot submit a transaction (ARCHITECTURE §3, "never signs").
 */
export interface AppDeps {
  config: Config;
  db: DB;
  chain: ChainReader;
  mailer: Mailer;
  storage: BlobStorage;
  secretBox: SecretBox;
  now: () => Date;
}

declare module 'fastify' {
  interface FastifyInstance {
    deps: AppDeps;
  }
  interface FastifyRequest {
    auth: AuthContext | null;
  }
}

export async function buildApp(
  deps: AppDeps,
  opts: { logger?: FastifyServerOptions['logger']; rateLimit?: boolean } = {},
): Promise<FastifyInstance> {
  const app = Fastify({
    logger: opts.logger ?? {
      level: deps.config.LOG_LEVEL,
      redact: ['req.headers.authorization', 'req.headers.cookie'],
    },
    trustProxy: true,
    bodyLimit: 256 * 1024,
  });

  app.decorate('deps', deps);
  app.decorateRequest('auth', null);

  await app.register(helmet);
  await app.register(cors, {
    origin: deps.config.CORS_ORIGINS.length > 0 ? deps.config.CORS_ORIGINS : [deps.config.PUBLIC_WEB_URL],
  });
  if (opts.rateLimit !== false) await app.register(rateLimit, { max: 300, timeWindow: '1 minute' });
  await app.register(multipart, { limits: { fileSize: deps.config.EVIDENCE_MAX_BYTES, files: 1, fields: 4 } });

  app.setErrorHandler((err: Error & { statusCode?: number; code?: string }, req, reply) => {
    if (err instanceof HttpError) {
      return reply.code(err.statusCode).send({ error: { code: err.code, message: err.message, details: err.details } });
    }
    if (typeof err.statusCode === 'number' && err.statusCode < 500) {
      return reply.code(err.statusCode).send({ error: { code: err.code ?? 'BAD_REQUEST', message: err.message } });
    }
    req.log.error({ err }, 'unhandled error');
    return reply.code(500).send({ error: { code: 'INTERNAL', message: 'Internal server error' } });
  });
  app.setNotFoundHandler((_req, reply) => reply.code(404).send({ error: { code: 'NOT_FOUND', message: 'Route not found' } }));

  app.get('/healthz', async (req, reply) => {
    try {
      await sql`select 1`.execute(deps.db);
      return { status: 'ok' };
    } catch (err) {
      req.log.warn({ err: String(err) }, 'health check: database unreachable');
      return reply.code(503).send({ status: 'unavailable', database: 'unreachable' });
    }
  });

  /** What a client needs to build `Factory::create` against this deployment. */
  app.get('/meta', async () => ({
    network: deps.config.STELLAR_NETWORK_PASSPHRASE,
    rpcUrl: deps.config.SOROBAN_RPC_URL,
    factoryContractId: deps.config.FACTORY_CONTRACT_ID || null,
    rails: deps.config.RAILS,
    windowBounds: { minSeconds: 3600, maxSeconds: 365 * 24 * 3600 },
    deliveryCode: { length: 16, alphabet: 'crockford-base32', entropyBits: 80 },
  }));

  await app.register(authRoutes);
  await app.register(userRoutes);
  await app.register(draftRoutes);
  await app.register(messageRoutes);
  await app.register(vaultRoutes);
  await app.register(evidenceRoutes);
  await app.register(notificationRoutes);
  await app.register(escrowRoutes);
  await app.register(arbitrationRoutes);

  return app;
}
