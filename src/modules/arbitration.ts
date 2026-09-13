import type { FastifyInstance } from 'fastify';
import { sql } from 'kysely';
import { authenticate, requireArbitrator } from '../auth/session.js';
import { readEscrowOrThrow } from '../chain/read.js';
import { parse } from '../http/validation.js';
import { termsHashHex } from '../lib/canonical-json.js';
import { ContractParams, presentCachedEscrow } from './escrows.js';

/**
 * Backend support for the arbitrator console. The arbitrator signs `resolve` with their
 * own key; nothing here can move funds.
 *
 * There is deliberately no endpoint to check a seller-claimed delivery code: that
 * would send a plaintext code to the server. The console hashes it locally and
 * compares against the on-chain `release_code_hash` (ARCHITECTURE §7 "Dispute", step 6).
 */
export async function arbitrationRoutes(app: FastifyInstance): Promise<void> {
  const { db, chain } = app.deps;
  const guard = { preHandler: [authenticate, requireArbitrator] };

  app.get('/arbitration/disputes', guard, async () => {
    const rows = await db
      .selectFrom('escrows')
      .selectAll()
      .where('state', '=', 'Disputed')
      .orderBy('dispute_deadline', 'asc')
      .limit(500)
      .execute();
    return rows.map(presentCachedEscrow);
  });

  /**
   * The case file: live contract state, the agreed terms with a recomputed hash check,
   * chat history, statements and evidence.
   */
  app.get('/arbitration/escrows/:contractId', guard, async (req) => {
    const { contractId } = parse(ContractParams, req.params);
    const escrow = await readEscrowOrThrow(chain, contractId);
    const cached = await db.selectFrom('escrows').select('draft_id').where('contract_id', '=', contractId).executeTakeFirst();
    const draft = cached?.draft_id
      ? await db.selectFrom('drafts').selectAll().where('id', '=', cached.draft_id).executeTakeFirst()
      : undefined;

    if (!draft || draft.agreed_revision === null) {
      return { escrow, draft: null, termsCheck: null, messages: [], statements: [], evidence: [] };
    }

    const rev = await db
      .selectFrom('draft_revisions')
      .select(['terms', 'terms_hash'])
      .where('draft_id', '=', draft.id)
      .where('revision', '=', draft.agreed_revision)
      .executeTakeFirstOrThrow();
    const recomputed = termsHashHex(rev.terms);

    const [messages, statements, evidence] = await Promise.all([
      db
        .selectFrom('messages')
        .leftJoin('users', 'users.id', 'messages.sender_user_id')
        .select(['messages.seq', 'messages.sender_role', 'messages.body', 'messages.created_at', 'users.address as sender_address'])
        .where('draft_id', '=', draft.id)
        .orderBy('seq')
        .execute(),
      db
        .selectFrom('dispute_statements')
        .innerJoin('users', 'users.id', 'dispute_statements.user_id')
        .select(['dispute_statements.role', 'dispute_statements.statement', 'dispute_statements.created_at', 'users.address'])
        .where('draft_id', '=', draft.id)
        .orderBy('dispute_statements.created_at')
        .execute(),
      db
        .selectFrom('evidence')
        .select(['id', 'filename', 'content_type', 'size_bytes', 'sha256', 'description', 'uploader_role', 'created_at'])
        .where('draft_id', '=', draft.id)
        .orderBy('created_at')
        .execute(),
    ]);

    return {
      escrow,
      draft: { id: draft.id, agreedRevision: draft.agreed_revision, terms: rev.terms },
      termsCheck: {
        onChain: escrow.termsHash,
        recomputed,
        match: recomputed === escrow.termsHash,
      },
      messages,
      statements,
      evidence,
    };
  });

  /**
   * Product health (ARCHITECTURE §7 "Release without a code"): the share of releases
   * that were two-sided, and the escalation rate per proof submission.
   */
  app.get('/arbitration/stats', guard, async () => {
    const byOutcome = await db
      .selectFrom('escrows')
      .select(['settlement', 'settlement_path', sql<number>`count(*)::int`.as('count')])
      .where('settlement', 'in', ['Released', 'Refunded'])
      .groupBy(['settlement', 'settlement_path'])
      .execute();
    const totals = await db
      .selectFrom('escrows')
      .select([
        sql<number>`count(*) filter (where proof_submitted_at is not null)::int`.as('proofs'),
        sql<number>`count(*) filter (where dispute_opened_by = 'ReceiptTimeout')::int`.as('escalations'),
        sql<number>`count(*) filter (where state = 'Disputed')::int`.as('openDisputes'),
      ])
      .executeTakeFirstOrThrow();
    const released = byOutcome.filter((r) => r.settlement === 'Released');
    const releasedTotal = released.reduce((n, r) => n + r.count, 0);
    const twoSided = released.filter((r) => r.settlement_path === 'Code' || r.settlement_path === 'Confirmation').reduce((n, r) => n + r.count, 0);
    return {
      outcomes: byOutcome.map((r) => ({ settlement: r.settlement, path: r.settlement_path, count: r.count })),
      twoSidedReleaseShare: releasedTotal ? twoSided / releasedTotal : null,
      escalationRate: totals.proofs ? totals.escalations / totals.proofs : null,
      proofsSubmitted: totals.proofs,
      escalations: totals.escalations,
      openDisputes: totals.openDisputes,
      source: 'cache',
    };
  });
}
