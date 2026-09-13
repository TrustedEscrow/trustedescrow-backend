import { Keypair } from '@stellar/stellar-sdk';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { EscrowSnapshot } from '../src/chain/types.js';
import { dispatchDue } from '../src/notifications/dispatcher.js';
import { planEscrowNotifications, REMINDER_KINDS } from '../src/notifications/plan.js';
import { notifyUsers } from '../src/notifications/store.js';
import { contractAddress, createTestContext, snapshotFor, TOKEN, type TestContext } from './helpers.js';

const HOUR = 3600_000;
const now = new Date('2026-09-01T12:00:00Z');
const terms = {
  buyer: Keypair.random().publicKey(),
  seller: Keypair.random().publicKey(),
  token: TOKEN,
  amount: '100',
  windows: { delivery: 86400, receipt: 86400, arbitration: 86400 },
  fundingDeadline: now.getTime() / 1000 + 86400,
};
const snap = (o: Partial<EscrowSnapshot>) => snapshotFor(contractAddress(70), terms, '00'.repeat(32), '11'.repeat(32), o);
const summary = (s: EscrowSnapshot) => planEscrowNotifications(s, now).upserts.map((u) => `${u.audience}:${u.kind}`).sort();

describe('planEscrowNotifications', () => {
  it('tells the seller about funding and reminds them 24h before the delivery deadline', () => {
    const deadline = new Date(now.getTime() + 72 * HOUR);
    const plan = planEscrowNotifications(snap({ state: 'Funded', deliveryDeadline: deadline }), now);
    expect(plan.upserts.map((u) => `${u.audience}:${u.kind}`)).toEqual(['seller:funded', `seller:${REMINDER_KINDS.delivery}`]);
    expect(plan.upserts[1]!.sendAt).toEqual(new Date(deadline.getTime() - 24 * HOUR));
    expect(plan.cancelKinds).not.toContain(REMINDER_KINDS.delivery);
    expect(plan.cancelKinds).toContain(REMINDER_KINDS.receipt);
  });

  it('sends a reminder immediately inside the window and never after the deadline', () => {
    const soon = planEscrowNotifications(snap({ state: 'Funded', deliveryDeadline: new Date(now.getTime() + 10 * HOUR) }), now);
    expect(soon.upserts[1]!.sendAt).toEqual(now);
    const late = planEscrowNotifications(snap({ state: 'Funded', deliveryDeadline: new Date(now.getTime() - HOUR) }), now);
    expect(late.upserts.map((u) => u.kind)).toEqual(['funded']);
  });

  it('prompts the buyer for receipt once proof is in', () => {
    expect(summary(snap({ state: 'Delivered', receiptDeadline: new Date(now.getTime() + 48 * HOUR) }))).toEqual([
      'buyer:proof_submitted',
      `buyer:${REMINDER_KINDS.receipt}`,
    ]);
  });

  it('distinguishes an escalation from a party-opened dispute', () => {
    const dispute = (openedBy: string) =>
      snap({ state: 'Disputed', dispute: { openedBy, openedAt: now, fromState: 'Delivered', deadline: new Date(now.getTime() + 7 * 24 * HOUR) } });
    expect(summary(dispute('ReceiptTimeout'))).toEqual([
      `arbitrator:${REMINDER_KINDS.arbitration24}`,
      `arbitrator:${REMINDER_KINDS.arbitration72}`,
      'arbitrator:dispute_new',
      `buyer:${REMINDER_KINDS.arbitration72}`,
      'buyer:escalated',
      `seller:${REMINDER_KINDS.arbitration72}`,
      'seller:escalated',
    ]);
    expect(summary(dispute('Buyer'))).toContain('seller:dispute_opened');
  });

  it('announces settlement and cancels every pending reminder', () => {
    const plan = planEscrowNotifications(snap({ state: 'Released', settlement: { status: 'Released', path: 'Arbitration' } }), now);
    expect(plan.upserts.map((u) => `${u.audience}:${u.kind}`).sort()).toEqual([
      'buyer:dispute_resolved',
      'buyer:released',
      'seller:dispute_resolved',
      'seller:released',
    ]);
    expect(plan.cancelKinds.sort()).toEqual(Object.values(REMINDER_KINDS).sort());
  });
});

describe('dispatchDue', () => {
  let ctx: TestContext;
  beforeEach(async () => {
    ctx = await createTestContext();
  });
  afterEach(async () => {
    await ctx.app.close();
    await ctx.db.destroy();
  });

  async function user(email: string | null) {
    const address = Keypair.random().publicKey();
    return ctx.db
      .insertInto('users')
      .values({ address, payout_address: address, email, email_verified_at: email ? ctx.clock.now() : null })
      .returning('id')
      .executeTakeFirstOrThrow();
  }

  const deps = () => ({ db: ctx.db, mailer: ctx.mailer, config: ctx.config, now: ctx.clock.now, log: { warn: () => {} } });

  it('emails verified users, marks everyone done, and leaves future notices alone', async () => {
    const withEmail = await user('buyer@example.com');
    const without = await user(null);
    await notifyUsers(ctx.db, [withEmail.id, without.id], { key: 'k1', kind: 'funded', title: 'Escrow funded', body: 'b', escrowContractId: 'C1' }, ctx.clock.now());
    await notifyUsers(ctx.db, [withEmail.id], { key: 'k2', kind: 'later', title: 'Later', body: 'b', sendAt: new Date(ctx.clock.t + HOUR) }, ctx.clock.now());

    expect(await dispatchDue(deps())).toBe(2);
    expect(ctx.mailer.sent).toHaveLength(1);
    expect(ctx.mailer.sent[0]).toMatchObject({ to: 'buyer@example.com', subject: 'TrustEscrow: Escrow funded' });
    expect(await dispatchDue(deps())).toBe(0);
  });

  it('backs off on mail failure without hiding the in-app copy', async () => {
    const u = await user('seller@example.com');
    await notifyUsers(ctx.db, [u.id], { key: 'k3', kind: 'funded', title: 'T', body: 'b' }, ctx.clock.now());
    ctx.mailer.fail = true;
    await dispatchDue(deps());
    const row = await ctx.db.selectFrom('notifications').selectAll().where('user_id', '=', u.id).executeTakeFirstOrThrow();
    expect(row.attempts).toBe(1);
    expect(row.sent_at).toBeNull();
    expect(row.send_at.getTime()).toBeGreaterThan(ctx.clock.t);
  });
});
