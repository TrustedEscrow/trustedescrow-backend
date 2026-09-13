import type { FastifyRequest } from 'fastify';
import type { Kysely } from 'kysely';
import { auth } from '../auth/session.js';
import type { Database, Draft, ParticipantRole, User } from '../db/schema.js';
import { notFound } from '../lib/errors.js';

export type DraftRole = Exclude<ParticipantRole, 'system'>;

export function participantRole(draft: Pick<Draft, 'buyer_address' | 'seller_address'>, user: Pick<User, 'address'>): 'buyer' | 'seller' | null {
  if (draft.buyer_address === user.address) return 'buyer';
  if (draft.seller_address === user.address) return 'seller';
  return null;
}

/** Arbitrators see a draft only once its escrow has entered a dispute. */
async function arbitratorMayAccess(db: Kysely<Database>, draft: Draft): Promise<boolean> {
  if (!draft.escrow_contract_id) return false;
  const row = await db
    .selectFrom('escrows')
    .select('dispute_opened_at')
    .where('contract_id', '=', draft.escrow_contract_id)
    .executeTakeFirst();
  return !!row?.dispute_opened_at;
}

/**
 * Loads a draft the caller may see. Non-participants get 404 rather than 403 so draft
 * ids don't leak who is trading with whom.
 */
export async function draftAccess(
  req: FastifyRequest,
  draftId: string,
  opts: { allowArbitrator?: boolean } = {},
): Promise<{ draft: Draft; role: DraftRole }> {
  const { user, isArbitrator } = auth(req);
  const db = req.server.deps.db;
  const draft = await db.selectFrom('drafts').selectAll().where('id', '=', draftId).executeTakeFirst();
  if (!draft) throw notFound('Draft');
  const role = participantRole(draft, user);
  if (role) return { draft, role };
  if (opts.allowArbitrator && isArbitrator && (await arbitratorMayAccess(db, draft))) return { draft, role: 'arbitrator' };
  throw notFound('Draft');
}

/** The committed code hash for a draft, from whichever source knows it first. */
export async function knownReleaseCodeHash(db: Kysely<Database>, draft: Draft): Promise<string | null> {
  if (draft.release_code_hash) return draft.release_code_hash;
  const entry = await db.selectFrom('vault_entries').select('release_code_hash').where('draft_id', '=', draft.id).executeTakeFirst();
  if (entry) return entry.release_code_hash;
  if (draft.escrow_contract_id) {
    const row = await db.selectFrom('escrows').select('release_code_hash').where('contract_id', '=', draft.escrow_contract_id).executeTakeFirst();
    return row?.release_code_hash ?? null;
  }
  return null;
}

export async function counterpartyUserIds(db: Kysely<Database>, draft: Draft, exceptUserId: string): Promise<string[]> {
  const rows = await db
    .selectFrom('users')
    .select('id')
    .where('address', 'in', [draft.buyer_address, draft.seller_address])
    .where('id', '!=', exceptUserId)
    .execute();
  return rows.map((r) => r.id);
}
