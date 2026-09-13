import { scValToNative, xdr } from '@stellar/stellar-sdk';
import type { rpc } from '@stellar/stellar-sdk';
import type { ChainClient, ChainEvent } from '../chain/types.js';
import type { Config } from '../config.js';
import type { DB } from '../db/index.js';
import { json } from '../db/index.js';
import { isContractAddress } from '../lib/stellar.js';
import { recordSnapshot } from './escrow-cache.js';

/**
 * Read cache indexer (ARCHITECTURE §6 "Read cache").
 *
 * Polls Soroban RPC `getEvents` for the factory's `escrow` event and each escrow's
 * lifecycle events. Event payloads are used only to learn *which* escrow changed; the
 * new state is always read back from contract storage, so the cache never depends on
 * event layout for anything but the escrow address.
 *
 * - `last_processed_ledger` is persisted; a restart resumes from it, not from head.
 * - Writes are idempotent on `(tx_hash, event_index)`.
 * - If the resume point has fallen out of the RPC's retention window, the indexer marks
 *   a gap and refuses to continue until an operator runs `npm run reconcile`.
 */

export const INDEXER_NAME = 'main';
export const ESCROW_EVENT_NAMES = ['funded', 'proof', 'disputed', 'released', 'refunded', 'cancelled'] as const;
const FACTORY_EVENT_NAME = 'escrow';
/** Ledgers scanned per tick (~14 hours at 5s ledgers). */
const MAX_RANGE = 10_000;

export class IndexerGapError extends Error {}

const symbol = (s: string) => xdr.ScVal.scvSymbol(s).toXDR('base64');

export function eventFilters(factoryContractId: string): rpc.Api.EventFilter[] {
  // getEvents accepts at most five topic filters per event filter.
  const escrowFilters: rpc.Api.EventFilter[] = [];
  for (let i = 0; i < ESCROW_EVENT_NAMES.length; i += 5) {
    escrowFilters.push({ type: 'contract', topics: ESCROW_EVENT_NAMES.slice(i, i + 5).map((n) => [symbol(n), '**']) });
  }
  return [{ type: 'contract', contractIds: [factoryContractId] }, ...escrowFilters];
}

export function eventName(e: ChainEvent): string | null {
  const t = e.topic[0];
  if (!t) return null;
  try {
    const v = scValToNative(t);
    return typeof v === 'string' ? v : null;
  } catch {
    return null;
  }
}

/** Event index within the transaction, from the RPC event id `<toid>-<index>`. */
export function eventIndex(id: string): number {
  const idx = Number(id.split('-')[1]);
  if (!Number.isInteger(idx)) throw new Error(`unexpected event id ${id}`);
  return idx;
}

/** Finds the deployed escrow's address in the factory event's data, whatever its shape. */
export function findContractAddress(v: unknown): string | null {
  if (typeof v === 'string') return isContractAddress(v) ? v : null;
  if (Array.isArray(v)) {
    for (const x of v) {
      const found = findContractAddress(x);
      if (found) return found;
    }
    return null;
  }
  if (v && typeof v === 'object' && !(v instanceof Uint8Array)) {
    return findContractAddress(Object.values(v as Record<string, unknown>));
  }
  return null;
}

function safeNative(v: xdr.ScVal): unknown {
  try {
    return JSON.parse(JSON.stringify(scValToNative(v), (_k, x) => (typeof x === 'bigint' ? x.toString() : x instanceof Uint8Array ? Buffer.from(x).toString('hex') : x)));
  } catch {
    return v.toXDR('base64');
  }
}

export interface IndexerDeps {
  db: DB;
  chain: ChainClient;
  config: Pick<Config, 'FACTORY_CONTRACT_ID' | 'INDEXER_START_LEDGER' | 'INDEXER_PAGE_LIMIT' | 'ARBITRATOR_ADDRESSES'>;
  now: () => Date;
  log: { info: (o: object, m: string) => void; warn: (o: object, m: string) => void; error: (o: object, m: string) => void };
}

export class Indexer {
  private readonly filters: rpc.Api.EventFilter[];

  constructor(private readonly deps: IndexerDeps) {
    if (!deps.config.FACTORY_CONTRACT_ID) throw new Error('FACTORY_CONTRACT_ID is required to run the indexer');
    this.filters = eventFilters(deps.config.FACTORY_CONTRACT_ID);
  }

  private async state(latestLedger: number) {
    const { db, config, log } = this.deps;
    const row = await db.selectFrom('indexer_state').selectAll().where('name', '=', INDEXER_NAME).executeTakeFirst();
    if (row) return row;
    const start = config.INDEXER_START_LEDGER > 0 ? config.INDEXER_START_LEDGER - 1 : latestLedger;
    if (config.INDEXER_START_LEDGER === 0) {
      log.warn({ latestLedger }, 'INDEXER_START_LEDGER not set; starting at the current ledger and skipping history');
    }
    await db
      .insertInto('indexer_state')
      .values({ name: INDEXER_NAME, last_processed_ledger: start, status: 'ok' })
      .onConflict((oc) => oc.column('name').doNothing())
      .execute();
    return db.selectFrom('indexer_state').selectAll().where('name', '=', INDEXER_NAME).executeTakeFirstOrThrow();
  }

  /** Processes one window of ledgers. Returns the number of new events stored. */
  async tick(): Promise<{ events: number; lastProcessedLedger: number }> {
    const { db, chain, config, log, now } = this.deps;
    const health = await chain.getHealth();
    const state = await this.state(health.latestLedger);
    if (state.status === 'gap') {
      throw new IndexerGapError(`indexer halted on a gap: ${state.error ?? 'unknown'}; run \`npm run reconcile\``);
    }

    const start = state.last_processed_ledger + 1;
    if (start > health.latestLedger) return { events: 0, lastProcessedLedger: state.last_processed_ledger };
    if (start < health.oldestLedger) {
      const error = `resume ledger ${start} is older than the RPC's oldest retained ledger ${health.oldestLedger}; events in between cannot be fetched`;
      await db.updateTable('indexer_state').set({ status: 'gap', error, updated_at: now() }).where('name', '=', INDEXER_NAME).execute();
      log.error({ start, oldestLedger: health.oldestLedger }, 'indexer gap exceeds RPC retention; operator reconciliation required');
      throw new IndexerGapError(error);
    }

    const end = Math.min(health.latestLedger + 1, start + MAX_RANGE); // exclusive
    const limit = config.INDEXER_PAGE_LIMIT;
    let stored = 0;
    let page = await chain.getEvents({ startLedger: start, endLedger: end, filters: this.filters, limit });
    for (;;) {
      const inRange = page.events.filter((e) => e.ledger < end);
      stored += await this.processEvents(inRange);
      if (page.events.length < limit || inRange.length < page.events.length) break;
      page = await chain.getEvents({ cursor: page.cursor, filters: this.filters, limit });
    }

    await db
      .updateTable('indexer_state')
      .set({ last_processed_ledger: end - 1, error: null, updated_at: now() })
      .where('name', '=', INDEXER_NAME)
      .execute();
    if (stored > 0) log.info({ events: stored, from: start, to: end - 1 }, 'indexed events');
    return { events: stored, lastProcessedLedger: end - 1 };
  }

  /** Refreshes every escrow touched by these events once, then records the events. */
  private async processEvents(events: ChainEvent[]): Promise<number> {
    const { db, chain, config, now } = this.deps;
    const fresh: ChainEvent[] = [];
    for (const e of events) {
      if (!e.inSuccessfulContractCall) continue;
      const seen = await db
        .selectFrom('chain_events')
        .select('event_id')
        .where('tx_hash', '=', e.txHash)
        .where('event_index', '=', eventIndex(e.id))
        .executeTakeFirst();
      if (!seen) fresh.push(e);
    }
    if (fresh.length === 0) return 0;

    const created = new Map<string, { ledger: number; txHash: string }>();
    const relevant: { event: ChainEvent; escrow: string }[] = [];
    for (const e of fresh) {
      const name = eventName(e);
      if (e.contractId === config.FACTORY_CONTRACT_ID) {
        if (name !== FACTORY_EVENT_NAME) continue;
        const escrow = findContractAddress(scValToNative(e.value));
        if (!escrow) continue;
        created.set(escrow, { ledger: e.ledger, txHash: e.txHash });
        relevant.push({ event: e, escrow });
      } else if (name && (ESCROW_EVENT_NAMES as readonly string[]).includes(name)) {
        relevant.push({ event: e, escrow: e.contractId });
      }
    }

    // Only escrows from our factory are tracked; same-named events from other contracts are ignored.
    const touched = [...new Set(relevant.map((r) => r.escrow))];
    const known = new Set(
      touched.length
        ? (await db.selectFrom('escrows').select('contract_id').where('contract_id', 'in', touched).execute()).map((r) => r.contract_id)
        : [],
    );
    const isOurs = (escrow: string) => created.has(escrow) || known.has(escrow);
    const ours = relevant.filter((r) => isOurs(r.escrow)).map((r) => r.event);

    for (const contractId of touched) {
      if (!isOurs(contractId)) continue;
      const origin = created.get(contractId);
      const snapshot = await chain.getEscrow(contractId);
      await recordSnapshot(db, snapshot, {
        now: now(),
        arbitratorAddresses: config.ARBITRATOR_ADDRESSES,
        ...(origin ? { created: { buyer: snapshot.buyer, seller: snapshot.seller, ledger: origin.ledger, txHash: origin.txHash } } : {}),
      });
    }

    if (ours.length === 0) return 0;
    await db
      .insertInto('chain_events')
      .values(
        ours.map((e) => ({
          tx_hash: e.txHash,
          event_index: eventIndex(e.id),
          event_id: e.id,
          ledger: e.ledger,
          contract_id: e.contractId,
          name: eventName(e) ?? '',
          topics: json(e.topic.map(safeNative)),
          value: json(safeNative(e.value)),
        })),
      )
      .onConflict((oc) => oc.columns(['tx_hash', 'event_index']).doNothing())
      .execute();
    return ours.length;
  }
}
