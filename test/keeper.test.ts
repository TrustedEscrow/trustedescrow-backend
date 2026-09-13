import { Keypair, type rpc } from '@stellar/stellar-sdk';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { EscrowSnapshot } from '../src/chain/types.js';
import { recordSnapshot } from '../src/indexer/escrow-cache.js';
import { dueAction, Keeper } from '../src/keeper/keeper.js';
import { contractAddress, createTestContext, snapshotFor, TOKEN, type TestContext } from './helpers.js';

const D = 1_790_000_000;
const at = (s: number) => new Date(s * 1000);
const terms = {
  buyer: Keypair.random().publicKey(),
  seller: Keypair.random().publicKey(),
  token: TOKEN,
  amount: '100',
  windows: { delivery: 86400, receipt: 86400, arbitration: 86400 },
  fundingDeadline: D,
};
const snap = (o: Partial<EscrowSnapshot>) => snapshotFor(contractAddress(80), terms, '00'.repeat(32), '11'.repeat(32), o);

describe('dueAction', () => {
  // ARCHITECTURE §4: "passed" is now >= deadline; at exactly the deadline the timeout is valid.
  it.each([
    ['Created', snap({ state: 'Created', fundingDeadline: at(D) }), 'cancel'],
    ['Funded', snap({ state: 'Funded', deliveryDeadline: at(D) }), 'refund_after_delivery_timeout'],
    ['Delivered', snap({ state: 'Delivered', receiptDeadline: at(D) }), 'escalate'],
    [
      'Disputed',
      snap({ state: 'Disputed', dispute: { openedBy: 'Buyer', openedAt: at(D - 10), fromState: 'Funded', deadline: at(D) } }),
      'refund_after_arbitration_timeout',
    ],
  ] as const)('%s: nothing before the deadline, the timeout at it', (_state, s, method) => {
    expect(dueAction(s, D - 1)).toBeNull();
    expect(dueAction(s, D)).toBe(method);
  });

  it('never acts on a terminal escrow, and never pays the seller', () => {
    for (const state of ['Released', 'Refunded', 'Cancelled'] as const) {
      expect(dueAction(snap({ state, deliveryDeadline: at(D), receiptDeadline: at(D) }), D + 1_000_000)).toBeNull();
    }
  });
});

describe('Keeper (dry run)', () => {
  let ctx: TestContext;
  beforeEach(async () => {
    ctx = await createTestContext();
  });
  afterEach(async () => {
    await ctx.app.close();
    await ctx.db.destroy();
  });

  it('decides on live state and bumps open escrows near archival', async () => {
    const id = contractAddress(81);
    const nowS = ctx.clock.seconds;
    const cached = snap({ contractId: id, state: 'Funded', deliveryDeadline: at(nowS - 10) });
    await recordSnapshot(ctx.db, cached, { now: ctx.clock.now(), arbitratorAddresses: [], created: { buyer: terms.buyer, seller: terms.seller, ledger: 1, txHash: 'x' } });
    ctx.chain.escrows.set(id, cached);
    ctx.chain.liveUntil.set(id, ctx.chain.latestLedger + 10);

    const actions: object[] = [];
    const keeper = new Keeper({
      db: ctx.db,
      chain: ctx.chain,
      server: {} as rpc.Server,
      keypair: Keypair.random(),
      config: { ...ctx.config, KEEPER_DRY_RUN: true },
      now: ctx.clock.now,
      log: { info: (o) => actions.push(o), warn: (o) => actions.push({ warn: o }) },
    });
    await keeper.tick();

    expect(actions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ contractId: id, method: 'refund_after_delivery_timeout' }),
        expect.objectContaining({ contractId: id, method: 'bump' }),
      ]),
    );
    const row = await ctx.db.selectFrom('escrows').select('last_bumped_at').where('contract_id', '=', id).executeTakeFirstOrThrow();
    expect(row.last_bumped_at).not.toBeNull();
  });
});
