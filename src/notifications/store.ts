import type { Kysely } from 'kysely';
import type { EscrowSnapshot } from '../chain/types.js';
import type { Database } from '../db/schema.js';
import { type Audience, planEscrowNotifications } from './plan.js';

/** Registered users who act as `address`, either as their login key or their payout address. */
export async function usersForAddress(db: Kysely<Database>, address: string): Promise<string[]> {
  const rows = await db
    .selectFrom('users')
    .select('id')
    .where((eb) => eb.or([eb('address', '=', address), eb('payout_address', '=', address)]))
    .execute();
  return rows.map((r) => r.id);
}

export async function arbitratorUsers(db: Kysely<Database>, arbitratorAddresses: string[], escrowArbitrator?: string): Promise<string[]> {
  const addresses = [...new Set([...arbitratorAddresses, ...(escrowArbitrator ? [escrowArbitrator] : [])])];
  if (addresses.length === 0) return [];
  const rows = await db.selectFrom('users').select('id').where('address', 'in', addresses).execute();
  return rows.map((r) => r.id);
}

export interface DirectNotification {
  key: string;
  kind: string;
  title: string;
  body: string;
  draftId?: string | null;
  escrowContractId?: string | null;
  sendAt?: Date;
}

/** In-app notification to specific users, deduplicated per user by `key`. */
export async function notifyUsers(db: Kysely<Database>, userIds: string[], n: DirectNotification, now: Date): Promise<void> {
  const unique = [...new Set(userIds)];
  if (unique.length === 0) return;
  await db
    .insertInto('notifications')
    .values(
      unique.map((userId) => ({
        user_id: userId,
        dedupe_key: `${n.key}:${userId}`,
        kind: n.kind,
        title: n.title,
        body: n.body,
        draft_id: n.draftId ?? null,
        escrow_contract_id: n.escrowContractId ?? null,
        send_at: n.sendAt ?? now,
      })),
    )
    .onConflict((oc) => oc.column('dedupe_key').doNothing())
    .execute();
}

export async function applyEscrowNotifications(
  db: Kysely<Database>,
  snapshot: EscrowSnapshot,
  opts: { now: Date; arbitratorAddresses: string[]; draftId: string | null },
): Promise<void> {
  const plan = planEscrowNotifications(snapshot, opts.now);

  if (plan.cancelKinds.length > 0) {
    await db
      .updateTable('notifications')
      .set({ cancelled_at: opts.now })
      .where('escrow_contract_id', '=', snapshot.contractId)
      .where('kind', 'in', plan.cancelKinds)
      .where('sent_at', 'is', null)
      .where('cancelled_at', 'is', null)
      .execute();
  }
  if (plan.upserts.length === 0) return;

  const recipients: Record<Audience, string[]> = {
    buyer: await usersForAddress(db, snapshot.buyer),
    seller: await usersForAddress(db, snapshot.seller),
    arbitrator: await arbitratorUsers(db, opts.arbitratorAddresses, snapshot.arbitrator),
  };

  const rows = plan.upserts.flatMap((p) =>
    recipients[p.audience].map((userId) => ({
      user_id: userId,
      dedupe_key: `${p.key}:${userId}`,
      kind: p.kind,
      escrow_contract_id: snapshot.contractId,
      draft_id: opts.draftId,
      title: p.title,
      body: p.body,
      send_at: p.sendAt,
    })),
  );
  if (rows.length === 0) return;
  await db
    .insertInto('notifications')
    .values(rows)
    .onConflict((oc) => oc.column('dedupe_key').doNothing())
    .execute();
}
