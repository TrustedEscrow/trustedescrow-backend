import { z } from 'zod';

/**
 * Settlement rails the backend knows about. The backend never moves funds; it only
 * needs the token address so drafts can be validated against the factory allowlist
 * before anyone signs `Factory::create`.
 */
const RailSchema = z.object({
  id: z.string().min(1),
  tokenAddress: z.string().min(1),
  displaySymbol: z.string().min(1),
  decimals: z.number().int().min(0).max(18),
});
export type RailConfig = z.infer<typeof RailSchema>;

const csv = z
  .string()
  .default('')
  .transform((s) =>
    s
      .split(',')
      .map((x) => x.trim())
      .filter(Boolean),
  );

const bool = z
  .string()
  .default('false')
  .transform((s) => s === 'true' || s === '1');

const EnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  HOST: z.string().default('0.0.0.0'),
  PORT: z.coerce.number().int().default(3000),
  LOG_LEVEL: z.string().default('info'),
  PUBLIC_WEB_URL: z.string().url().default('http://localhost:3001'),
  CORS_ORIGINS: csv,

  DATABASE_URL: z.string().default('postgres://postgres:postgres@localhost:5432/trustescrow'),

  /** 32-byte key, base64. Encrypts server-side secrets at rest (TOTP seeds). Never used for delivery codes. */
  SERVER_ENCRYPTION_KEY: z.string().min(1),
  SESSION_TTL_SECONDS: z.coerce.number().int().positive().default(7 * 24 * 3600),
  AUTH_CHALLENGE_TTL_SECONDS: z.coerce.number().int().positive().default(300),
  /** How long a successful 2FA step-up authorises sensitive actions on a session. */
  STEP_UP_TTL_SECONDS: z.coerce.number().int().positive().default(300),
  /** Domain string embedded in login challenges so a signature can't be replayed elsewhere. */
  AUTH_DOMAIN: z.string().default('trustescrow.local'),

  STELLAR_NETWORK_PASSPHRASE: z.string().default('Test SDF Network ; September 2015'),
  SOROBAN_RPC_URL: z.string().url().default('https://soroban-testnet.stellar.org'),
  FACTORY_CONTRACT_ID: z.string().default(''),
  /** JSON array of rails, see RailSchema. */
  RAILS: z
    .string()
    .default('[]')
    .transform((s, ctx) => {
      try {
        return z.array(RailSchema).parse(JSON.parse(s));
      } catch (e) {
        ctx.addIssue({ code: 'custom', message: `RAILS must be a JSON array of rails: ${String(e)}` });
        return z.NEVER;
      }
    }),
  ARBITRATOR_ADDRESSES: csv,

  INDEXER_POLL_INTERVAL_MS: z.coerce.number().int().positive().default(5000),
  INDEXER_START_LEDGER: z.coerce.number().int().nonnegative().default(0),
  INDEXER_PAGE_LIMIT: z.coerce.number().int().positive().max(10000).default(200),

  NOTIFIER_POLL_INTERVAL_MS: z.coerce.number().int().positive().default(30000),
  EMAIL_DRIVER: z.enum(['console', 'smtp']).default('console'),
  SMTP_URL: z.string().default(''),
  EMAIL_FROM: z.string().default('TrustEscrow <no-reply@trustescrow.local>'),

  /** Optional. Only the keeper worker reads this; the API process never holds a key. */
  KEEPER_SECRET: z.string().default(''),
  KEEPER_POLL_INTERVAL_MS: z.coerce.number().int().positive().default(60000),
  /** Bump escrows whose instance TTL is within this many ledgers of expiry. */
  KEEPER_BUMP_THRESHOLD_LEDGERS: z.coerce.number().int().positive().default(17280 * 7),
  KEEPER_DRY_RUN: bool,

  EVIDENCE_STORAGE_DIR: z.string().default('./storage/evidence'),
  EVIDENCE_MAX_BYTES: z.coerce.number().int().positive().default(10 * 1024 * 1024),
});

export type Config = z.infer<typeof EnvSchema>;

export function loadConfig(env: Record<string, string | undefined> = process.env): Config {
  const parsed = EnvSchema.safeParse(env);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `  ${i.path.join('.')}: ${i.message}`).join('\n');
    throw new Error(`Invalid configuration:\n${issues}`);
  }
  const key = Buffer.from(parsed.data.SERVER_ENCRYPTION_KEY, 'base64');
  if (key.length !== 32) {
    throw new Error('SERVER_ENCRYPTION_KEY must be 32 bytes, base64-encoded');
  }
  return parsed.data;
}
