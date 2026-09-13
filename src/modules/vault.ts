import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { auth, authenticate, requireStepUp } from '../auth/session.js';
import { json } from '../db/index.js';
import { Hex32, IdParams, parse } from '../http/validation.js';
import { audit } from '../lib/audit.js';
import { conflict, forbidden, notFound, unprocessable } from '../lib/errors.js';
import { draftAccess } from './access.js';
import { EnvelopeInput, envelopeProblem } from './vault-envelope.js';

const PutBody = z.object({ releaseCodeHash: Hex32, envelope: EnvelopeInput });

/**
 * Encrypted code vault. Stores client-encrypted ciphertext only; see vault-envelope.ts.
 *
 * - Only the buyer can write or read their entry.
 * - The committed hash is fixed on first write. There is no rotation (ARCHITECTURE D11)
 *   and no delete: a buyer adding a new device adds an envelope for that credential.
 * - Reading requires a fresh second factor and is audited.
 */
export async function vaultRoutes(app: FastifyInstance): Promise<void> {
  const { db } = app.deps;
  const vaultRateLimit = { rateLimit: { max: 10, timeWindow: '1 minute' } };

  app.put('/drafts/:id/vault', { preHandler: authenticate, config: vaultRateLimit }, async (req, reply) => {
    const { user } = auth(req);
    const { id } = parse(IdParams, req.params);
    const body = parse(PutBody, req.body);
    const { draft, role } = await draftAccess(req, id);
    if (role !== 'buyer') throw forbidden('Only the buyer stores a delivery code');
    if (draft.status === 'withdrawn') throw conflict('DRAFT_CLOSED', 'This draft was withdrawn');
    if (draft.release_code_hash && draft.release_code_hash !== body.releaseCodeHash) {
      throw conflict('CODE_HASH_MISMATCH', "This code does not match the escrow's on-chain release_code_hash");
    }
    const problem = envelopeProblem(body.envelope, body.releaseCodeHash);
    if (problem) throw unprocessable('INVALID_ENVELOPE', problem);

    const existing = await db.selectFrom('vault_entries').selectAll().where('draft_id', '=', draft.id).executeTakeFirst();
    if (existing) {
      if (existing.release_code_hash !== body.releaseCodeHash) {
        throw conflict('CODE_HASH_IMMUTABLE', 'A different code is already committed for this order; codes cannot be rotated');
      }
      // Adding a credential to an existing entry is a sensitive change.
      await requireStepUp(req);
    }

    const { envelope } = body;
    const created = await db.transaction().execute(async (trx) => {
      await trx
        .insertInto('vault_entries')
        .values({ draft_id: draft.id, buyer_user_id: user.id, release_code_hash: body.releaseCodeHash })
        .onConflict((oc) => oc.column('draft_id').doNothing())
        .execute();
      const entry = await trx.selectFrom('vault_entries').selectAll().where('draft_id', '=', draft.id).executeTakeFirstOrThrow();
      if (entry.release_code_hash !== body.releaseCodeHash) {
        throw conflict('CODE_HASH_IMMUTABLE', 'A different code is already committed for this order; codes cannot be rotated');
      }
      const { name, ...kdfParams } = envelope.kdf;
      const inserted = await trx
        .insertInto('vault_envelopes')
        .values({
          entry_id: entry.id,
          credential_id: envelope.credentialId,
          alg: envelope.alg,
          kdf: name,
          kdf_params: json(kdfParams),
          iv: envelope.iv,
          ciphertext: envelope.ciphertext,
        })
        .onConflict((oc) => oc.columns(['entry_id', 'credential_id']).doNothing())
        .returning('id')
        .executeTakeFirst();
      if (!inserted) throw conflict('ENVELOPE_EXISTS', 'An envelope for this credential already exists');
      return entry;
    });

    await audit(db, req, user.id, 'vault.envelope_added', draft.id, { credentialId: envelope.credentialId, kdf: envelope.kdf.name });
    reply.code(201);
    return { draftId: draft.id, releaseCodeHash: created.release_code_hash, credentialId: envelope.credentialId };
  });

  app.get('/drafts/:id/vault', { preHandler: [authenticate, requireStepUp], config: vaultRateLimit }, async (req) => {
    const { user } = auth(req);
    const { id } = parse(IdParams, req.params);
    const { draft, role } = await draftAccess(req, id);
    if (role !== 'buyer') throw forbidden('Only the buyer can read their delivery code');
    const entry = await db.selectFrom('vault_entries').selectAll().where('draft_id', '=', draft.id).executeTakeFirst();
    if (!entry) throw notFound('Vault entry');
    const envelopes = await db.selectFrom('vault_envelopes').selectAll().where('entry_id', '=', entry.id).orderBy('created_at').execute();
    await audit(db, req, user.id, 'vault.read', draft.id, { envelopes: envelopes.length });
    return {
      draftId: draft.id,
      releaseCodeHash: entry.release_code_hash,
      createdAt: entry.created_at,
      envelopes: envelopes.map((e) => ({
        credentialId: e.credential_id,
        alg: e.alg,
        kdf: { name: e.kdf, ...(e.kdf_params as Record<string, unknown>) },
        iv: e.iv,
        ciphertext: e.ciphertext,
        createdAt: e.created_at,
      })),
    };
  });
}
