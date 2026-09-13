import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { auth, authenticate } from '../auth/session.js';
import { readEscrowOrThrow } from '../chain/read.js';
import type { EscrowRow } from '../db/schema.js';
import { parse } from '../http/validation.js';
import { isContractAddress } from '../lib/stellar.js';

const States = ['Created', 'Funded', 'Delivered', 'Disputed', 'Released', 'Refunded', 'Cancelled'] as const;
const ListQuery = z.object({
  role: z.enum(['buyer', 'seller', 'any']).default('any'),
  state: z.enum(States).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(100),
});
export const ContractParams = z.object({ contractId: z.string().refine(isContractAddress, 'must be a contract address (C…)') });

/** Cache rows are labelled as such: good enough for a list, never for a decision. */
export function presentCachedEscrow(r: EscrowRow) {
  return {
    source: 'cache' as const,
    contractId: r.contract_id,
    buyer: r.buyer_address,
    seller: r.seller_address,
    draftId: r.draft_id,
    state: r.state,
    token: r.token,
    amount: r.amount,
    feeBps: r.fee_bps,
    termsHash: r.terms_hash,
    deadlines: {
      funding: r.funding_deadline,
      delivery: r.delivery_deadline,
      receipt: r.receipt_deadline,
      arbitration: r.dispute_deadline,
    },
    proof: r.proof_kind ? { kind: r.proof_kind, uri: r.proof_uri, hash: r.proof_hash, submittedAt: r.proof_submitted_at } : null,
    dispute: r.dispute_opened_by ? { openedBy: r.dispute_opened_by, openedAt: r.dispute_opened_at, deadline: r.dispute_deadline } : null,
    settlement: r.settlement,
    settlementPath: r.settlement_path,
    createdLedger: r.created_ledger,
    snapshotLedger: r.snapshot_ledger,
    snapshotAt: r.snapshot_at,
  };
}

export async function escrowRoutes(app: FastifyInstance): Promise<void> {
  const { db, chain } = app.deps;

  /** "Which escrows involve me" — the only question the read cache answers. */
  app.get('/escrows', { preHandler: authenticate }, async (req) => {
    const { user } = auth(req);
    const q = parse(ListQuery, req.query);
    const addresses = [...new Set([user.address, user.payout_address])];
    let query = db.selectFrom('escrows').selectAll();
    if (q.role === 'buyer') query = query.where('buyer_address', 'in', addresses);
    else if (q.role === 'seller') query = query.where('seller_address', 'in', addresses);
    else query = query.where((eb) => eb.or([eb('buyer_address', 'in', addresses), eb('seller_address', 'in', addresses)]));
    if (q.state) query = query.where('state', '=', q.state);
    const rows = await query.orderBy('created_ledger', 'desc').limit(q.limit).execute();
    return rows.map(presentCachedEscrow);
  });

  /** Escrow detail is read live from contract storage, never from the cache. */
  app.get('/escrows/:contractId', { preHandler: authenticate }, async (req) => {
    const { user } = auth(req);
    const { contractId } = parse(ContractParams, req.params);
    const snapshot = await readEscrowOrThrow(chain, contractId);
    const addresses = new Set([user.address, user.payout_address]);
    const participant = addresses.has(snapshot.buyer) || addresses.has(snapshot.seller);
    const cached = participant
      ? await db.selectFrom('escrows').select('draft_id').where('contract_id', '=', contractId).executeTakeFirst()
      : undefined;
    return { source: 'chain' as const, ...snapshot, draftId: cached?.draft_id ?? null };
  });
}
