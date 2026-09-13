import { createDb } from './index.js';
import { migrateToLatest } from './migrate.js';

const db = createDb(process.env.DATABASE_URL ?? 'postgres://postgres:postgres@localhost:5432/trustescrow');
try {
  await migrateToLatest(db);
  console.log('migrations up to date');
} finally {
  await db.destroy();
}
