import type { Kysely } from 'kysely';
import { type Migration, Migrator } from 'kysely/migration';
import * as m0001 from './migrations/0001_initial.js';

const migrations: Record<string, Migration> = {
  '0001_initial': m0001,
};

export async function migrateToLatest(db: Kysely<any>): Promise<void> {
  const migrator = new Migrator({ db, provider: { getMigrations: async () => migrations } });
  const { error, results } = await migrator.migrateToLatest();
  for (const r of results ?? []) {
    if (r.status === 'Error') console.error(`migration ${r.migrationName} failed`);
  }
  if (error) throw error;
}
