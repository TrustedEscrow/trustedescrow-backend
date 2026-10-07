import { type Kysely, sql } from 'kysely';

/**
 * `unswept_fee` mirrors the on-chain field of the same name: i128 base units as text,
 * zero/null until a fee transfer fails on release and the fee sits recoverable via the
 * escrow's own `sweep_fee` (ARCHITECTURE §4 "State").
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`alter table escrows add column unswept_fee text`.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`alter table escrows drop column unswept_fee`.execute(db);
}
