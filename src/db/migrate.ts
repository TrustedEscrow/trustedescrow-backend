import type { Kysely } from 'kysely';
import { type Migration, Migrator } from 'kysely/migration';
import * as m0001 from './migrations/0001_initial.js';
import * as m0002 from './migrations/0002_escrow_unswept_fee.js';
import * as m0003 from './migrations/0003_dispute_statement_hash.js';

const migrations: Record<string, Migration> = {
  '0001_initial': m0001,
  '0002_escrow_unswept_fee': m0002,
  '0003_dispute_statement_hash': m0003,
};

export async function migrateToLatest(db: Kysely<any>): Promise<void> {
  const migrator = new Migrator({ db, provider: { getMigrations: async () => migrations } });
  const { error, results } = await migrator.migrateToLatest();
  for (const r of results ?? []) {
    if (r.status === 'Error') console.error(`migration ${r.migrationName} failed`);
  }
  if (error) throw error;
}
