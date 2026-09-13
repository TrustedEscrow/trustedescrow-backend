import { randomBytes } from 'node:crypto';
import { Address, Keypair, xdr } from '@stellar/stellar-sdk';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ChainEvent, EscrowSnapshot } from '../src/chain/types.js';
import { Indexer, IndexerGapError } from '../src/indexer/indexer.js';
import {
  codeHashHex,
  contractAddress,
  createTestContext,
  FACTORY,
  login,
  randomCode,
  snapshotFor,
  termsInput,
  type TestContext,
} from './helpers.js';

const silent = { info: () => {}, warn: () => {}, error: () => {} };
const sym = (s: string) => xdr.ScVal.scvSymbol(s);
let seq = 0;

function event(ledger: number, contractId: string, topic: xdr.ScVal[], value: xdr.ScVal = xdr.ScVal.scvVoid()): ChainEvent {
  seq += 1;
  return {
    id: `${String(ledger * 4096).padStart(19, '0')}-${String(seq).padStart(10, '0')}`,
    txHash: randomBytes(32).toString('hex'),
    ledger,
    contractId,
    topic,
    value,
    inSuccessfulContractCall: true,
  };
}

let ctx: TestContext;
beforeEach(async () => {
  ctx = await createTestContext();
});
afterEach(async () => {
  await ctx.app.close();
  await ctx.db.destroy();
});

function indexer(overrides: Partial<TestContext['config']> = {}) {
  return new Indexer({ db: ctx.db, chain: ctx.chain, config: { ...ctx.config, INDEXER_START_LEDGER: 900, ...overrides }, now: ctx.clock.now, log: silent });
}

async function agreedDraft() {
  const buyer = Keypair.random();
  const seller = Keypair.random();
  const b = await login(ctx.app, buyer);
  const created = (
    await ctx.app.inject({ method: 'POST', url: '/drafts', headers: b.headers, payload: { role: 'buyer', counterpartyAddress: seller.publicKey(), terms: termsInput(ctx.clock) } })
  ).json();
  const s = await login(ctx.app, seller);
  await ctx.app.inject({ method: 'POST', url: `/drafts/${created.id}/accept`, headers: s.headers, payload: { revision: 1 } });
  return { buyer, seller, s, draftId: created.id as string, terms: created.terms, termsHash: created.termsHash as string };
}

describe('indexer', () => {
  it('indexes factory and escrow events, auto-links the draft and schedules notifications', async () => {
    const d = await agreedDraft();
    const escrow = contractAddress(60);
    const now = ctx.clock.now();
    const funded: EscrowSnapshot = snapshotFor(escrow, d.terms, d.termsHash, codeHashHex(randomCode()), {
      state: 'Funded',
      fundedAt: now,
      deliveryDeadline: new Date(now.getTime() + 3 * 86400_000),
    });
    ctx.chain.escrows.set(escrow, funded);
    ctx.chain.events = [
      event(950, FACTORY, [sym('escrow'), new Address(d.buyer.publicKey()).toScVal(), new Address(d.seller.publicKey()).toScVal()], new Address(escrow).toScVal()),
      event(960, escrow, [sym('funded')]),
      event(970, contractAddress(99), [sym('funded')]),
    ];

    const ix = indexer();
    expect(await ix.tick()).toEqual({ events: 2, lastProcessedLedger: 1000 });
    expect(ctx.chain.getEscrowCalls).toBe(1);

    const row = await ctx.db.selectFrom('escrows').selectAll().where('contract_id', '=', escrow).executeTakeFirstOrThrow();
    expect(row).toMatchObject({ state: 'Funded', draft_id: d.draftId, created_ledger: 950, buyer_address: d.buyer.publicKey() });
    const draft = await ctx.db.selectFrom('drafts').selectAll().where('id', '=', d.draftId).executeTakeFirstOrThrow();
    expect(draft).toMatchObject({ status: 'linked', escrow_contract_id: escrow });

    const kinds = (await ctx.db.selectFrom('notifications').select('kind').where('escrow_contract_id', '=', escrow).execute()).map((n) => n.kind);
    expect(kinds.sort()).toEqual(['delivery_deadline_24h', 'funded']);

    // Replaying the same range is a no-op.
    await ctx.db.updateTable('indexer_state').set({ last_processed_ledger: 900 }).execute();
    expect((await ix.tick()).events).toBe(0);
    expect(await ctx.db.selectFrom('chain_events').select('event_id').execute()).toHaveLength(2);

    // Proof submitted: buyer is told, the seller's delivery reminder is cancelled.
    ctx.chain.escrows.set(escrow, {
      ...funded,
      state: 'Delivered',
      proof: { kind: 'Tracking', uri: 'https://track.example/1', hash: 'ab'.repeat(32), submittedAt: now },
      receiptDeadline: new Date(now.getTime() + 2 * 86400_000),
    });
    ctx.chain.events.push(event(1005, escrow, [sym('proof')]));
    ctx.chain.latestLedger = 1010;
    await ix.tick();
    const notes = await ctx.db.selectFrom('notifications').select(['kind', 'cancelled_at']).where('escrow_contract_id', '=', escrow).execute();
    expect(notes.find((n) => n.kind === 'proof_submitted')).toBeDefined();
    expect(notes.find((n) => n.kind === 'delivery_deadline_24h')?.cancelled_at).not.toBeNull();
  });

  it('pages through more events than fit in one response', async () => {
    const d = await agreedDraft();
    const escrow = contractAddress(61);
    ctx.chain.escrows.set(escrow, snapshotFor(escrow, d.terms, d.termsHash, codeHashHex(randomCode())));
    ctx.chain.events = [
      event(910, FACTORY, [sym('escrow')], new Address(escrow).toScVal()),
      ...[920, 930, 940, 950].map((l) => event(l, escrow, [sym('funded')])),
    ];
    const res = await indexer({ INDEXER_PAGE_LIMIT: 2 }).tick();
    expect(res.events).toBe(5);
  });

  it('starts at head when no start ledger is configured', async () => {
    ctx.chain.events = [event(950, FACTORY, [sym('escrow')], new Address(contractAddress(62)).toScVal())];
    expect(await indexer({ INDEXER_START_LEDGER: 0 }).tick()).toEqual({ events: 0, lastProcessedLedger: 1000 });
  });

  it('halts loudly when the resume point is outside RPC retention', async () => {
    await ctx.db.insertInto('indexer_state').values({ name: 'main', last_processed_ledger: 50, status: 'ok' }).execute();
    const ix = indexer();
    await expect(ix.tick()).rejects.toBeInstanceOf(IndexerGapError);
    const state = await ctx.db.selectFrom('indexer_state').selectAll().executeTakeFirstOrThrow();
    expect(state.status).toBe('gap');
    await expect(ix.tick()).rejects.toThrow(/reconcile/);
  });
});
