import { randomBytes } from 'node:crypto';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { Keypair, StrKey, rpc } from '@stellar/stellar-sdk';
import type { FastifyInstance } from 'fastify';
import { Kysely, PGliteDialect } from 'kysely';
import { buildApp } from '../src/app.js';
import { ChainError, type ChainClient, type ChainEvent, type EscrowSnapshot, type EventPage } from '../src/chain/types.js';
import { loadConfig, type Config } from '../src/config.js';
import type { DB } from '../src/db/index.js';
import { migrateToLatest } from '../src/db/migrate.js';
import type { Database } from '../src/db/schema.js';
import { SecretBox } from '../src/lib/crypto.js';
import { codeHashHex } from '../src/lib/delivery-code.js';
import type { MailMessage, Mailer } from '../src/notifications/mailer.js';
import { LocalBlobStorage } from '../src/storage/blob-storage.js';

export const contractAddress = (seed: number) => StrKey.encodeContract(Buffer.alloc(32, seed));
export const TOKEN = contractAddress(1);
export const FACTORY = contractAddress(2);

export class Clock {
  constructor(public t = new Date('2026-09-01T12:00:00Z').getTime()) {}
  now = () => new Date(this.t);
  advance(ms: number) {
    this.t += ms;
  }
  get seconds() {
    return Math.floor(this.t / 1000);
  }
}

export class CaptureMailer implements Mailer {
  sent: MailMessage[] = [];
  fail = false;
  async send(m: MailMessage) {
    if (this.fail) throw new Error('smtp down');
    this.sent.push(m);
  }
}

export class FakeChain implements ChainClient {
  escrows = new Map<string, EscrowSnapshot>();
  events: ChainEvent[] = [];
  latestLedger = 1000;
  oldestLedger = 100;
  liveUntil = new Map<string, number>();
  getEscrowCalls = 0;

  async getEscrow(id: string): Promise<EscrowSnapshot> {
    this.getEscrowCalls++;
    const s = this.escrows.get(id);
    if (!s) throw new ChainError(`no escrow ${id}`, 'not_found');
    return { ...s, ledger: this.latestLedger };
  }

  async getHealth() {
    return { latestLedger: this.latestLedger, oldestLedger: this.oldestLedger };
  }

  async getEvents(req: rpc.Api.GetEventsRequest): Promise<EventPage> {
    const limit = req.limit ?? 100;
    const sorted = [...this.events].sort((a, b) => (a.id < b.id ? -1 : 1));
    let matching: ChainEvent[];
    if (req.cursor !== undefined) {
      matching = sorted.filter((e) => e.id > req.cursor!);
    } else {
      if (req.startLedger < this.oldestLedger) throw new Error('startLedger before retention window');
      matching = sorted.filter((e) => e.ledger >= req.startLedger && (req.endLedger === undefined || e.ledger < req.endLedger));
    }
    const page = matching.slice(0, limit);
    return { events: page, cursor: page.at(-1)?.id ?? req.cursor ?? '', latestLedger: this.latestLedger, oldestLedger: this.oldestLedger };
  }

  async getInstanceLiveUntil(id: string) {
    return { liveUntil: this.liveUntil.get(id) ?? null, latestLedger: this.latestLedger };
  }
}

const APP_TABLES = [
  'audit_log',
  'dispute_statements',
  'evidence',
  'notifications',
  'indexer_state',
  'chain_events',
  'escrows',
  'vault_envelopes',
  'vault_entries',
  'messages',
  'draft_acceptances',
  'draft_revisions',
  'drafts',
  'backup_codes',
  'sessions',
  'devices',
  'auth_challenges',
  'users',
];

/**
 * One migrated in-memory Postgres per test file; booting and migrating PGlite costs
 * seconds, truncating costs milliseconds. Each test gets its own Kysely over a handle
 * whose close() is a no-op, so tests may call `db.destroy()` without taking the
 * shared instance down with them.
 */
let shared: Promise<PGlite> | undefined;

function sharedPglite(): Promise<PGlite> {
  shared ??= (async () => {
    const pglite = new PGlite();
    const db = new Kysely<Database>({ dialect: new PGliteDialect({ pglite: nonClosing(pglite) }) });
    await migrateToLatest(db);
    return pglite;
  })();
  return shared;
}

function nonClosing(pglite: PGlite) {
  return {
    query: pglite.query.bind(pglite),
    transaction: pglite.transaction.bind(pglite),
    close: async () => {},
    closed: false,
    get ready() {
      return pglite.ready;
    },
    get waitReady() {
      return pglite.waitReady;
    },
  };
}

export async function createTestDb(): Promise<DB> {
  const pglite = await sharedPglite();
  await pglite.query(`truncate table ${APP_TABLES.join(', ')} cascade`);
  return new Kysely<Database>({ dialect: new PGliteDialect({ pglite: nonClosing(pglite) }) });
}

export interface TestContext {
  app: FastifyInstance;
  db: DB;
  chain: FakeChain;
  clock: Clock;
  mailer: CaptureMailer;
  config: Config;
  arbitrator: Keypair;
}

export async function createTestContext(overrides: Record<string, string> = {}): Promise<TestContext> {
  const arbitrator = Keypair.random();
  const config = loadConfig({
    NODE_ENV: 'test',
    SERVER_ENCRYPTION_KEY: randomBytes(32).toString('base64'),
    RAILS: JSON.stringify([{ id: 'usdc-stellar', tokenAddress: TOKEN, displaySymbol: 'USDC', decimals: 7 }]),
    ARBITRATOR_ADDRESSES: arbitrator.publicKey(),
    FACTORY_CONTRACT_ID: FACTORY,
    EVIDENCE_STORAGE_DIR: await mkdtemp(join(tmpdir(), 'te-evidence-')),
    ...overrides,
  });
  const db = await createTestDb();
  const chain = new FakeChain();
  const clock = new Clock();
  const mailer = new CaptureMailer();
  const app = await buildApp(
    {
      config,
      db,
      chain,
      mailer,
      storage: new LocalBlobStorage(config.EVIDENCE_STORAGE_DIR),
      secretBox: new SecretBox(config.SERVER_ENCRYPTION_KEY),
      now: clock.now,
    },
    { logger: false, rateLimit: false },
  );
  return { app, db, chain, clock, mailer, config, arbitrator };
}

export interface LoginResult {
  token: string;
  status: 'active' | 'pending_2fa';
  headers: { authorization: string };
}

export async function login(app: FastifyInstance, kp: Keypair, deviceId = 'device-0000000000000001'): Promise<LoginResult> {
  const ch = await app.inject({ method: 'POST', url: '/auth/challenge', payload: { address: kp.publicKey() } });
  if (ch.statusCode !== 200) throw new Error(`challenge failed: ${ch.body}`);
  const { challengeId, message } = ch.json();
  const signature = Buffer.from(kp.signMessage(message)).toString('base64');
  const res = await app.inject({ method: 'POST', url: '/auth/login', payload: { challengeId, signature, deviceId } });
  if (res.statusCode !== 201) throw new Error(`login failed: ${res.body}`);
  const body = res.json();
  return { token: body.token, status: body.status, headers: { authorization: `Bearer ${body.token}` } };
}

/** Wallet-signature step-up for a user without 2FA. */
export async function stepUpWithWallet(app: FastifyInstance, kp: Keypair, headers: { authorization: string }) {
  const ch = await app.inject({ method: 'POST', url: '/auth/step-up/challenge', headers });
  const { challengeId, message } = ch.json();
  const signature = Buffer.from(kp.signMessage(message)).toString('base64');
  const res = await app.inject({ method: 'POST', url: '/auth/step-up', headers, payload: { challengeId, signature } });
  if (res.statusCode !== 200) throw new Error(`step-up failed: ${res.body}`);
}

const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
export function randomCode(): string {
  return [...randomBytes(16)].map((b) => CROCKFORD[b & 31]).join('');
}
export const grouped = (code: string) => code.match(/.{4}/g)!.join('-');
export { codeHashHex };

export function base32Decode(s: string): Buffer {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const c of s.replace(/=+$/, '')) {
    value = (value << 5) | alphabet.indexOf(c);
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

export function termsInput(clock: Clock, overrides: Record<string, unknown> = {}) {
  return {
    rail: 'usdc-stellar',
    amount: '1500000000',
    item: { title: 'iPhone 15, 128GB', description: 'Unlocked, boxed' },
    delivery: { method: 'shipped', proofKind: 'Tracking', carrier: 'GIG Logistics' },
    windows: { delivery: 3 * 86400, receipt: 2 * 86400, arbitration: 7 * 86400 },
    fundingDeadline: clock.seconds + 86400,
    ...overrides,
  };
}

/** A contract snapshot that commits exactly `terms` (as returned by the drafts API). */
export function snapshotFor(
  contractId: string,
  terms: { buyer: string; seller: string; token: string; amount: string; windows: { delivery: number; receipt: number; arbitration: number }; fundingDeadline: number },
  termsHash: string,
  releaseCodeHash: string,
  overrides: Partial<EscrowSnapshot> = {},
): EscrowSnapshot {
  return {
    contractId,
    buyer: terms.buyer,
    seller: terms.seller,
    arbitrator: Keypair.random().publicKey(),
    token: terms.token,
    amount: terms.amount,
    feeBps: 100,
    feeRecipient: Keypair.random().publicKey(),
    termsHash,
    releaseCodeHash,
    state: 'Created',
    createdAt: new Date('2026-09-01T12:00:00Z'),
    fundingDeadline: new Date(terms.fundingDeadline * 1000),
    deliveryWindow: terms.windows.delivery,
    receiptWindow: terms.windows.receipt,
    arbitrationWindow: terms.windows.arbitration,
    fundedAt: null,
    deliveryDeadline: null,
    receiptDeadline: null,
    proof: null,
    dispute: null,
    settlement: { status: 'Open' },
    ledger: 1000,
    ...overrides,
  };
}
