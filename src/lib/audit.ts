import type { FastifyRequest } from 'fastify';
import type { Kysely } from 'kysely';
import { json } from '../db/index.js';
import type { Database } from '../db/schema.js';

/**
 * Security-relevant actions: logins, 2FA changes, payout changes, vault reads.
 * Metadata must never include message bodies, ciphertext or anything code-shaped.
 */
export async function audit(
  db: Kysely<Database>,
  req: FastifyRequest | null,
  userId: string | null,
  action: string,
  subject: string | null = null,
  metadata: Record<string, unknown> = {},
): Promise<void> {
  await db
    .insertInto('audit_log')
    .values({
      user_id: userId,
      action,
      subject,
      ip: req?.ip ?? null,
      user_agent: (req?.headers['user-agent'] as string | undefined)?.slice(0, 300) ?? null,
      metadata: json(metadata),
    })
    .execute();
}
