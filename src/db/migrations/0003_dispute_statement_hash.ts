import { type Kysely, sql } from 'kysely';

/**
 * sha256 of each party's statement, computed at write time, so it can be compared
 * against the on-chain `dispute.statement_hash` the opener commits in `dispute()`
 * (ARCHITECTURE §7 "Dispute"). Only the opener's own statement can ever match — the
 * contract commits exactly one hash per dispute — but storing it on every row lets the
 * comparison be a plain equality rather than special-cased by role.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`alter table dispute_statements add column statement_hash text`.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`alter table dispute_statements drop column statement_hash`.execute(db);
}
