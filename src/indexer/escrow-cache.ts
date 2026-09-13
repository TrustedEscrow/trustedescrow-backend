import type { Kysely } from 'kysely';
import type { EscrowSnapshot } from '../chain/types.js';
import type { Database, Draft, EscrowRow, EscrowRowUpdate } from '../db/schema.js';
import { type CanonicalTerms, compareTermsWithEscrow } from '../modules/drafts/terms.js';
import { applyEscrowNotifications } from '../notifications/store.js';

export function snapshotColumns(s: EscrowSnapshot, now: Date): EscrowRowUpdate {
  return {
    state: s.state,
    arbitrator: s.arbitrator,
    token: s.token,
    amount: s.amount,
    fee_bps: s.feeBps,
    terms_hash: s.termsHash,
    release_code_hash: s.releaseCodeHash,
    funding_deadline: s.fundingDeadline,
    funded_at: s.fundedAt,
    delivery_deadline: s.deliveryDeadline,
    receipt_deadline: s.receiptDeadline,
    dispute_opened_by: s.dispute?.openedBy ?? null,
    dispute_opened_at: s.dispute?.openedAt ?? null,
    dispute_deadline: s.dispute?.deadline ?? null,
    proof_kind: s.proof?.kind ?? null,
    proof_uri: s.proof?.uri ?? null,
    proof_hash: s.proof?.hash ?? null,
    proof_submitted_at: s.proof?.submittedAt ?? null,
    settlement: s.settlement.status,
    settlement_path: s.settlement.status === 'Open' ? null : s.settlement.path,
    snapshot_ledger: s.ledger,
    snapshot_at: now,
    updated_at: now,
  };
}

/**
 * Links an agreed draft to a deployed escrow if the contract's storage matches the
 * agreed terms exactly. Returns the mismatching fields; empty means linked.
 * Must run inside a transaction.
 */
export async function tryLinkDraft(trx: Kysely<Database>, draftId: string, s: EscrowSnapshot, now: Date): Promise<string[]> {
  const draft = await trx.selectFrom('drafts').selectAll().where('id', '=', draftId).forUpdate().executeTakeFirst();
  if (!draft || draft.status !== 'agreed' || draft.agreed_revision === null) return ['draft_not_agreed'];
  const rev = await trx
    .selectFrom('draft_revisions')
    .select(['terms', 'terms_hash'])
    .where('draft_id', '=', draft.id)
    .where('revision', '=', draft.agreed_revision)
    .executeTakeFirstOrThrow();
  const mismatches = compareTermsWithEscrow(rev.terms as unknown as CanonicalTerms, rev.terms_hash, s);
  if (mismatches.length > 0) return mismatches;

  await trx
    .updateTable('drafts')
    .set({ status: 'linked', escrow_contract_id: s.contractId, release_code_hash: s.releaseCodeHash, linked_at: now, updated_at: now })
    .where('id', '=', draft.id)
    .execute();
  await trx.updateTable('escrows').set({ draft_id: draft.id }).where('contract_id', '=', s.contractId).execute();
  await postSystemMessage(trx, draft.id, `Escrow ${s.contractId} deployed and linked to these terms.`);
  return [];
}

export async function postSystemMessage(trx: Kysely<Database>, draftId: string, body: string): Promise<void> {
  // The caller holds the draft row lock (or is inside a transaction that does), so max(seq) is stable.
  const { max } = await trx
    .selectFrom('messages')
    .select((eb) => eb.fn.max<number | null>('seq').as('max'))
    .where('draft_id', '=', draftId)
    .executeTakeFirstOrThrow();
  await trx
    .insertInto('messages')
    .values({ draft_id: draftId, seq: (max ?? 0) + 1, sender_user_id: null, sender_role: 'system', body })
    .execute();
}

export interface RecordSnapshotOptions {
  now: Date;
  arbitratorAddresses: string[];
  /** Present when the snapshot follows the factory's `escrow` event. */
  created?: { buyer: string; seller: string; ledger: number; txHash: string };
}

/**
 * Writes a fresh contract snapshot into the read cache, links it to its draft, and
 * (re)plans notifications. A snapshot older than the cached one is ignored, so racing
 * refreshes can't move the cache backwards.
 */
export async function recordSnapshot(db: Kysely<Database>, s: EscrowSnapshot, opts: RecordSnapshotOptions): Promise<EscrowRow | null> {
  return db.transaction().execute(async (trx) => {
    if (opts.created) {
      await trx
        .insertInto('escrows')
        .values({
          contract_id: s.contractId,
          buyer_address: opts.created.buyer,
          seller_address: opts.created.seller,
          created_ledger: opts.created.ledger,
          created_tx_hash: opts.created.txHash,
        })
        .onConflict((oc) => oc.column('contract_id').doNothing())
        .execute();
    }
    const updated = await trx
      .updateTable('escrows')
      .set(snapshotColumns(s, opts.now))
      .where('contract_id', '=', s.contractId)
      .where((eb) => eb.or([eb('snapshot_ledger', 'is', null), eb('snapshot_ledger', '<=', s.ledger)]))
      .returningAll()
      .executeTakeFirst();
    if (!updated) return null;

    let draftId = updated.draft_id;
    if (!draftId) {
      const alreadyLinked = await trx.selectFrom('drafts').select('id').where('escrow_contract_id', '=', s.contractId).executeTakeFirst();
      if (alreadyLinked) {
        draftId = alreadyLinked.id;
      } else {
        const candidate: Pick<Draft, 'id'> | undefined = await trx
          .selectFrom('drafts')
          .select('id')
          .where('terms_hash', '=', s.termsHash)
          .where('status', '=', 'agreed')
          .executeTakeFirst();
        if (candidate && (await tryLinkDraft(trx, candidate.id, s, opts.now)).length === 0) draftId = candidate.id;
      }
      if (draftId) await trx.updateTable('escrows').set({ draft_id: draftId }).where('contract_id', '=', s.contractId).execute();
    }

    await applyEscrowNotifications(trx, s, { now: opts.now, arbitratorAddresses: opts.arbitratorAddresses, draftId });
    return { ...updated, draft_id: draftId };
  });
}
