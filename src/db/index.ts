import { type Dialect, Kysely, PostgresDialect, type RawBuilder, sql } from 'kysely';
import pg from 'pg';
import type { Database } from './schema.js';

export type DB = Kysely<Database>;

export function createDb(databaseUrl: string): DB {
  return createDbWithDialect(
    new PostgresDialect({ pool: new pg.Pool({ connectionString: databaseUrl, max: 10 }) }),
  );
}

export function createDbWithDialect(dialect: Dialect): DB {
  return new Kysely<Database>({ dialect });
}

/** Bind a value as jsonb. Serialising here keeps node-pg and PGlite behaviour identical. */
export function json<T>(value: T): RawBuilder<T> {
  return sql<T>`cast(${JSON.stringify(value)} as jsonb)`;
}

export type { Database } from './schema.js';
