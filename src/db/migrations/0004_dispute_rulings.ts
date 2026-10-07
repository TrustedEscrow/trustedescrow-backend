import { type Kysely, sql } from 'kysely';

/**
 * The arbitrator's written ruling, recorded off-chain the same way a dispute statement
 * is, so its sha256 can be compared against the on-chain `dispute.ruling_hash` the
 * contract's `resolve` call commits (ARCHITECTURE §7 "Dispute"). Keyed by the escrow's
 * own address rather than draft_id: a ruling is fundamentally about one escrow, and the
 * arbitration console (arbitration.ts) already operates by contract id, not draft id.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`create table dispute_rulings (
    contract_id text primary key,
    user_id uuid not null references users(id),
    ruling text not null,
    ruling_hash text not null,
    created_at timestamptz not null default now()
  )`.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`drop table if exists dispute_rulings`.execute(db);
}
