import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import type { Kysely } from 'kysely';
import { z } from 'zod';
import { auth, authenticate } from '../../auth/session.js';
import { readEscrowOrThrow } from '../../chain/read.js';
import { json } from '../../db/index.js';
import type { Database, Draft } from '../../db/schema.js';
import { IdParams, parse } from '../../http/validation.js';
import { canonicalJson, termsHashHex } from '../../lib/canonical-json.js';
import { HttpError, badRequest, conflict, forbidden } from '../../lib/errors.js';
import { isAccountAddress, isContractAddress } from '../../lib/stellar.js';
import { postSystemMessage, recordSnapshot, tryLinkDraft } from '../../indexer/escrow-cache.js';
import { notifyUsers } from '../../notifications/store.js';
import { counterpartyUserIds, draftAccess, type DraftRole } from '../access.js';
import { type CanonicalTerms, TermsInput, buildTerms, fundingDeadlineProblem } from './terms.js';

const CreateDraftBody = z.object({
  role: z.enum(['buyer', 'seller']),
  counterpartyAddress: z.string().refine(isAccountAddress, 'must be a Stellar account address (G…)'),
  terms: TermsInput,
  note: z.string().max(1000).optional(),
});
const ReviseBody = z.object({ terms: TermsInput, note: z.string().max(1000).optional() });
const AcceptBody = z.object({ revision: z.number().int().positive() });
const LinkBody = z.object({ contractId: z.string().refine(isContractAddress, 'must be a contract address (C…)') });
const ListQuery = z.object({ status: z.enum(['negotiating', 'agreed', 'linked', 'withdrawn']).optional() });

export function presentDraft(d: Draft, role: DraftRole | null) {
  return {
    id: d.id,
    status: d.status,
    role,
    buyerAddress: d.buyer_address,
    sellerAddress: d.seller_address,
    currentRevision: d.current_revision,
    agreedRevision: d.agreed_revision,
    termsHash: d.terms_hash,
    escrowContractId: d.escrow_contract_id,
    releaseCodeHash: d.release_code_hash,
    linkedAt: d.linked_at,
    createdAt: d.created_at,
    updatedAt: d.updated_at,
  };
}

/** Terms pay the seller at their current payout address, or their login address if they haven't joined yet. */
async function sellerPayoutAddress(db: Kysely<Database>, sellerLogin: string): Promise<string> {
  const u = await db.selectFrom('users').select('payout_address').where('address', '=', sellerLogin).executeTakeFirst();
  return u?.payout_address ?? sellerLogin;
}

export async function draftRoutes(app: FastifyInstance): Promise<void> {
  const { db, config, chain } = app.deps;
  const now = () => app.deps.now();

  function railOrThrow(id: string) {
    const rail = config.RAILS.find((r) => r.id === id);
    if (!rail) throw badRequest('UNKNOWN_RAIL', `Settlement rail "${id}" is not offered`);
    return rail;
  }

  /** Adds revision n with the proposer's acceptance. Caller holds the draft row lock. */
  async function addRevision(trx: Kysely<Database>, draft: Draft, userId: string, revision: number, terms: CanonicalTerms, note?: string) {
    await trx
      .insertInto('draft_revisions')
      .values({ draft_id: draft.id, revision, proposed_by: userId, terms: json(terms), terms_hash: termsHashHex(terms), note: note ?? null })
      .execute();
    await trx.insertInto('draft_acceptances').values({ draft_id: draft.id, revision, user_id: userId }).execute();
  }

  app.post('/drafts', { preHandler: authenticate }, async (req, reply) => {
    const { user } = auth(req);
    const body = parse(CreateDraftBody, req.body);
    if (body.counterpartyAddress === user.address) throw badRequest('SELF_TRADE', 'You cannot trade with yourself');
    const rail = railOrThrow(body.terms.rail);
    const problem = fundingDeadlineProblem(body.terms.fundingDeadline, now());
    if (problem) throw badRequest('INVALID_FUNDING_DEADLINE', problem);

    const buyer = body.role === 'buyer' ? user.address : body.counterpartyAddress;
    const sellerLogin = body.role === 'seller' ? user.address : body.counterpartyAddress;
    const seller = await sellerPayoutAddress(db, sellerLogin);
    const draftId = randomUUID();
    const terms = buildTerms(body.terms, { draftId, buyer, seller, rail });

    const draft = await db.transaction().execute(async (trx) => {
      const d = await trx
        .insertInto('drafts')
        .values({ id: draftId, buyer_address: buyer, seller_address: sellerLogin, created_by: user.id, status: 'negotiating', current_revision: 1 })
        .returningAll()
        .executeTakeFirstOrThrow();
      await addRevision(trx, d, user.id, 1, terms, body.note);
      await notifyUsers(trx, await counterpartyUserIds(trx, d, user.id), {
        key: `draft:${d.id}:proposed:1`,
        kind: 'draft_proposed',
        title: 'New order proposal',
        body: `${user.display_name ?? user.address} proposed an order: ${terms.item.title}.`,
        draftId: d.id,
      }, now());
      return d;
    });
    reply.code(201);
    return { ...presentDraft(draft, body.role), terms, termsHash: termsHashHex(terms) };
  });

  app.get('/drafts', { preHandler: authenticate }, async (req) => {
    const { user } = auth(req);
    const { status } = parse(ListQuery, req.query);
    let q = db
      .selectFrom('drafts')
      .selectAll()
      .where((eb) => eb.or([eb('buyer_address', '=', user.address), eb('seller_address', '=', user.address)]));
    if (status) q = q.where('status', '=', status);
    const rows = await q.orderBy('updated_at', 'desc').limit(200).execute();
    return rows.map((d) => presentDraft(d, d.buyer_address === user.address ? 'buyer' : 'seller'));
  });

  app.get('/drafts/:id', { preHandler: authenticate }, async (req) => {
    const { id } = parse(IdParams, req.params);
    const { draft, role } = await draftAccess(req, id, { allowArbitrator: true });
    const revisions = await db
      .selectFrom('draft_revisions')
      .innerJoin('users', 'users.id', 'draft_revisions.proposed_by')
      .select(['revision', 'terms', 'terms_hash', 'note', 'draft_revisions.created_at', 'users.address as proposed_by'])
      .where('draft_id', '=', draft.id)
      .orderBy('revision')
      .execute();
    const acceptances = await db
      .selectFrom('draft_acceptances')
      .innerJoin('users', 'users.id', 'draft_acceptances.user_id')
      .select(['revision', 'users.address', 'accepted_at'])
      .where('draft_id', '=', draft.id)
      .execute();
    return {
      ...presentDraft(draft, role),
      revisions: revisions.map((r) => ({
        revision: r.revision,
        proposedBy: r.proposed_by,
        terms: r.terms,
        termsHash: r.terms_hash,
        note: r.note,
        createdAt: r.created_at,
        acceptedBy: acceptances.filter((a) => a.revision === r.revision).map((a) => a.address),
      })),
    };
  });

  /** Counter-proposal. Reopens negotiation even if the previous revision was agreed. */
  app.post('/drafts/:id/revisions', { preHandler: authenticate }, async (req, reply) => {
    const { user } = auth(req);
    const { id } = parse(IdParams, req.params);
    const body = parse(ReviseBody, req.body);
    const { draft, role } = await draftAccess(req, id);
    if (role === 'arbitrator') throw forbidden();
    const rail = railOrThrow(body.terms.rail);
    const problem = fundingDeadlineProblem(body.terms.fundingDeadline, now());
    if (problem) throw badRequest('INVALID_FUNDING_DEADLINE', problem);
    const seller = await sellerPayoutAddress(db, draft.seller_address);
    const terms = buildTerms(body.terms, { draftId: draft.id, buyer: draft.buyer_address, seller, rail });

    const revision = await db.transaction().execute(async (trx) => {
      const locked = await trx.selectFrom('drafts').selectAll().where('id', '=', draft.id).forUpdate().executeTakeFirstOrThrow();
      if (locked.status !== 'negotiating' && locked.status !== 'agreed') {
        throw conflict('DRAFT_CLOSED', `Draft is ${locked.status}; terms can no longer change`);
      }
      const n = locked.current_revision + 1;
      await addRevision(trx, locked, user.id, n, terms, body.note);
      await trx
        .updateTable('drafts')
        .set({ current_revision: n, status: 'negotiating', agreed_revision: null, terms_hash: null, updated_at: now() })
        .where('id', '=', locked.id)
        .execute();
      await notifyUsers(trx, await counterpartyUserIds(trx, locked, user.id), {
        key: `draft:${locked.id}:proposed:${n}`,
        kind: 'draft_proposed',
        title: 'Counter-proposal received',
        body: `Revision ${n} of "${terms.item.title}" is waiting for your review.`,
        draftId: locked.id,
      }, now());
      return n;
    });
    reply.code(201);
    return { revision, terms, termsHash: termsHashHex(terms) };
  });

  /** Both parties accepting the same revision fixes the terms and their hash. */
  app.post('/drafts/:id/accept', { preHandler: authenticate }, async (req) => {
    const { user } = auth(req);
    const { id } = parse(IdParams, req.params);
    const { revision } = parse(AcceptBody, req.body);
    const { draft, role } = await draftAccess(req, id);
    if (role === 'arbitrator') throw forbidden();

    const updated = await db.transaction().execute(async (trx) => {
      const locked = await trx.selectFrom('drafts').selectAll().where('id', '=', draft.id).forUpdate().executeTakeFirstOrThrow();
      if (locked.status !== 'negotiating') throw conflict('DRAFT_NOT_NEGOTIATING', `Draft is ${locked.status}`);
      if (revision !== locked.current_revision) throw conflict('STALE_REVISION', `Revision ${locked.current_revision} is the current proposal`);
      const rev = await trx
        .selectFrom('draft_revisions')
        .selectAll()
        .where('draft_id', '=', locked.id)
        .where('revision', '=', revision)
        .executeTakeFirstOrThrow();
      const terms = rev.terms as unknown as CanonicalTerms;
      if (role === 'seller' && terms.seller !== user.payout_address) {
        throw conflict('PAYOUT_ADDRESS_MISMATCH', 'These terms pay a different address than your current payout address; propose a new revision');
      }
      const problem = fundingDeadlineProblem(terms.fundingDeadline, now());
      if (problem) throw conflict('FUNDING_DEADLINE_PASSED', `${problem}; propose a new revision`);

      await trx
        .insertInto('draft_acceptances')
        .values({ draft_id: locked.id, revision, user_id: user.id })
        .onConflict((oc) => oc.columns(['draft_id', 'revision', 'user_id']).doNothing())
        .execute();
      const accepted = await trx
        .selectFrom('draft_acceptances')
        .innerJoin('users', 'users.id', 'draft_acceptances.user_id')
        .select('users.address')
        .where('draft_id', '=', locked.id)
        .where('revision', '=', revision)
        .execute();
      const addresses = new Set(accepted.map((a) => a.address));
      if (!(addresses.has(locked.buyer_address) && addresses.has(locked.seller_address))) return locked;

      const agreed = await trx
        .updateTable('drafts')
        .set({ status: 'agreed', agreed_revision: revision, terms_hash: rev.terms_hash, updated_at: now() })
        .where('id', '=', locked.id)
        .returningAll()
        .executeTakeFirstOrThrow();
      await postSystemMessage(trx, locked.id, `Both parties agreed revision ${revision}. Terms hash ${rev.terms_hash}.`);
      await notifyUsers(trx, await counterpartyUserIds(trx, locked, user.id), {
        key: `draft:${locked.id}:agreed:${revision}`,
        kind: 'draft_agreed',
        title: 'Terms agreed',
        body: `Both parties agreed "${terms.item.title}". The buyer can now create and fund the escrow.`,
        draftId: locked.id,
      }, now());
      return agreed;
    });
    return presentDraft(updated, role);
  });

  /** The exact terms and canonical bytes the buyer must hash into `Factory::create`. */
  app.get('/drafts/:id/terms', { preHandler: authenticate }, async (req) => {
    const { id } = parse(IdParams, req.params);
    const { draft } = await draftAccess(req, id, { allowArbitrator: true });
    if (draft.agreed_revision === null) throw conflict('DRAFT_NOT_AGREED', 'Terms have not been agreed yet');
    const rev = await db
      .selectFrom('draft_revisions')
      .select(['terms', 'terms_hash'])
      .where('draft_id', '=', draft.id)
      .where('revision', '=', draft.agreed_revision)
      .executeTakeFirstOrThrow();
    return { revision: draft.agreed_revision, terms: rev.terms, canonical: canonicalJson(rev.terms), termsHash: rev.terms_hash };
  });

  app.post('/drafts/:id/withdraw', { preHandler: authenticate }, async (req) => {
    const { user } = auth(req);
    const { id } = parse(IdParams, req.params);
    const { draft, role } = await draftAccess(req, id);
    if (role === 'arbitrator') throw forbidden();
    const updated = await db
      .updateTable('drafts')
      .set({ status: 'withdrawn', withdrawn_at: now(), updated_at: now() })
      .where('id', '=', draft.id)
      .where('status', 'in', ['negotiating', 'agreed'])
      .returningAll()
      .executeTakeFirst();
    if (!updated) throw conflict('DRAFT_CLOSED', `Draft is ${draft.status}`);
    await notifyUsers(db, await counterpartyUserIds(db, draft, user.id), {
      key: `draft:${draft.id}:withdrawn`,
      kind: 'draft_withdrawn',
      title: 'Proposal withdrawn',
      body: 'The other party withdrew this order proposal.',
      draftId: draft.id,
    }, now());
    return presentDraft(updated, role);
  });

  /**
   * Associates the deployed escrow with the draft after verifying, against live contract
   * state, that it commits exactly the agreed terms. The indexer does the same thing
   * automatically when it sees the factory event; this is the immediate path.
   */
  app.post('/drafts/:id/link', { preHandler: authenticate }, async (req) => {
    const { id } = parse(IdParams, req.params);
    const { contractId } = parse(LinkBody, req.body);
    const { draft, role } = await draftAccess(req, id);
    if (role === 'arbitrator') throw forbidden();
    if (draft.status === 'linked' && draft.escrow_contract_id !== contractId) {
      throw conflict('ALREADY_LINKED', 'Draft is linked to a different escrow');
    }
    if (draft.status !== 'agreed' && draft.status !== 'linked') throw conflict('DRAFT_NOT_AGREED', `Draft is ${draft.status}`);

    const snapshot = await readEscrowOrThrow(chain, contractId);
    if (draft.status === 'agreed') {
      const mismatches = await db.transaction().execute((trx) => tryLinkDraft(trx, draft.id, snapshot, now()));
      if (mismatches.length > 0) {
        throw new HttpError(422, 'ESCROW_TERMS_MISMATCH', 'The escrow does not commit the agreed terms', { mismatches });
      }
    }
    // Refresh the cache row if the indexer has already seen this escrow.
    await recordSnapshot(db, snapshot, { now: now(), arbitratorAddresses: config.ARBITRATOR_ADDRESSES });

    const linked = await db.selectFrom('drafts').selectAll().where('id', '=', draft.id).executeTakeFirstOrThrow();
    const vault = await db.selectFrom('vault_entries').select('release_code_hash').where('draft_id', '=', draft.id).executeTakeFirst();
    return {
      draft: presentDraft(linked, role),
      escrow: snapshot,
      vault: vault ? { stored: true, matchesOnChainHash: vault.release_code_hash === snapshot.releaseCodeHash } : { stored: false },
    };
  });
}
