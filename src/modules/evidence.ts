import { createHash, randomUUID } from 'node:crypto';
import { basename } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { auth, authenticate, requireStepUp } from '../auth/session.js';
import { IdParams, parse } from '../http/validation.js';
import { audit } from '../lib/audit.js';
import { containsDeliveryCode } from '../lib/delivery-code.js';
import { badRequest, conflict, forbidden, notFound, unprocessable } from '../lib/errors.js';
import { arbitratorUsers, notifyUsers } from '../notifications/store.js';
import { counterpartyUserIds, draftAccess, knownReleaseCodeHash } from './access.js';

const ALLOWED_TYPES = new Set([
  'image/jpeg',
  'image/png',
  'image/webp',
  'image/heic',
  'application/pdf',
  'text/plain',
  'video/mp4',
]);
/** Text evidence up to this size is scanned for the delivery code before storage. */
const TEXT_SCAN_LIMIT = 64 * 1024;

const StatementBody = z.object({ statement: z.string().trim().min(10).max(10_000) });

function safeFilename(name: string): string {
  const cleaned = basename(name).replace(/[^\w.\- ]+/g, '_').slice(0, 200);
  return cleaned || 'evidence';
}

/**
 * Dispute evidence beyond the on-chain proof: photos, documents, and each party's
 * statement. Nothing here is authoritative; the arbitrator weighs it alongside the
 * proof committed on-chain.
 */
export async function evidenceRoutes(app: FastifyInstance): Promise<void> {
  const { db, storage, config } = app.deps;
  const now = () => app.deps.now();

  app.post('/drafts/:id/evidence', { preHandler: authenticate, config: { rateLimit: { max: 20, timeWindow: '1 minute' } } }, async (req, reply) => {
    const { user } = auth(req);
    const { id } = parse(IdParams, req.params);
    const { draft, role } = await draftAccess(req, id, { allowArbitrator: true });
    if (!draft.escrow_contract_id) throw conflict('DRAFT_NOT_LINKED', 'Evidence can be added once the escrow exists');

    const file = await req.file();
    if (!file) throw badRequest('FILE_REQUIRED', 'Upload one file in the "file" field');
    if (!ALLOWED_TYPES.has(file.mimetype)) throw unprocessable('UNSUPPORTED_TYPE', `Allowed types: ${[...ALLOWED_TYPES].join(', ')}`);
    const data = await file.toBuffer();
    const descriptionField = file.fields.description;
    const description =
      descriptionField && !Array.isArray(descriptionField) && descriptionField.type === 'field'
        ? String(descriptionField.value).slice(0, 2000)
        : null;

    const codeHash = await knownReleaseCodeHash(db, draft);
    if (codeHash) {
      const texts = [description ?? ''];
      if (file.mimetype === 'text/plain' && data.length <= TEXT_SCAN_LIMIT) texts.push(data.toString('utf8'));
      if (texts.some((t) => containsDeliveryCode(t, codeHash))) {
        throw unprocessable('DELIVERY_CODE_IN_EVIDENCE', 'This upload contains the delivery code. Codes must never be stored by the platform.');
      }
    }

    const evidenceId = randomUUID();
    const storageKey = `${draft.id}/${evidenceId}`;
    const sha256 = createHash('sha256').update(data).digest('hex');
    await storage.put(storageKey, data);
    const row = await db
      .insertInto('evidence')
      .values({
        id: evidenceId,
        draft_id: draft.id,
        uploaded_by: user.id,
        uploader_role: role,
        filename: safeFilename(file.filename),
        content_type: file.mimetype,
        size_bytes: data.length,
        sha256,
        storage_key: storageKey,
        description,
      })
      .returning(['id', 'filename', 'content_type', 'size_bytes', 'sha256', 'description', 'created_at'])
      .executeTakeFirstOrThrow();
    await audit(db, req, user.id, 'evidence.uploaded', draft.id, { evidenceId, sha256, size: data.length });
    reply.code(201);
    return { ...row, uploaderRole: role };
  });

  app.get('/drafts/:id/evidence', { preHandler: authenticate }, async (req) => {
    const { id } = parse(IdParams, req.params);
    const { draft } = await draftAccess(req, id, { allowArbitrator: true });
    return db
      .selectFrom('evidence')
      .innerJoin('users', 'users.id', 'evidence.uploaded_by')
      .select([
        'evidence.id',
        'evidence.filename',
        'evidence.content_type',
        'evidence.size_bytes',
        'evidence.sha256',
        'evidence.description',
        'evidence.uploader_role',
        'evidence.created_at',
        'users.address as uploaded_by',
      ])
      .where('draft_id', '=', draft.id)
      .orderBy('evidence.created_at')
      .execute();
  });

  app.get('/evidence/:id/download', { preHandler: authenticate }, async (req, reply) => {
    const { id } = parse(IdParams, req.params);
    const row = await db.selectFrom('evidence').selectAll().where('id', '=', id).executeTakeFirst();
    if (!row) throw notFound('Evidence');
    await draftAccess(req, row.draft_id, { allowArbitrator: true });
    reply
      .header('content-type', row.content_type)
      .header('content-disposition', `attachment; filename="${row.filename}"`)
      .header('x-content-type-options', 'nosniff')
      .header('x-evidence-sha256', row.sha256);
    return reply.send(storage.read(row.storage_key));
  });

  /**
   * A party's written case for the arbitrator. Opening the on-chain dispute is a
   * contract call the client signs; this is the backend-mediated half, and it is
   * 2FA-gated (ARCHITECTURE §6 "2FA").
   */
  app.post('/drafts/:id/dispute-case', { preHandler: [authenticate, requireStepUp] }, async (req, reply) => {
    const { user } = auth(req);
    const { id } = parse(IdParams, req.params);
    const { statement } = parse(StatementBody, req.body);
    const { draft, role } = await draftAccess(req, id);
    if (role === 'arbitrator') throw forbidden('Arbitrators use messages, not dispute statements');
    if (!draft.escrow_contract_id) throw conflict('DRAFT_NOT_LINKED', 'There is no escrow to dispute yet');
    const codeHash = await knownReleaseCodeHash(db, draft);
    if (codeHash && containsDeliveryCode(statement, codeHash)) {
      throw unprocessable('DELIVERY_CODE_IN_STATEMENT', 'Remove the delivery code from your statement. The platform never stores codes.');
    }

    const row = await db
      .insertInto('dispute_statements')
      .values({ draft_id: draft.id, user_id: user.id, role, statement })
      .returning(['id', 'role', 'statement', 'created_at'])
      .executeTakeFirstOrThrow();
    await audit(db, req, user.id, 'dispute.statement_added', draft.id);

    const arbitrators = await arbitratorUsers(db, config.ARBITRATOR_ADDRESSES);
    const counterparty = await counterpartyUserIds(db, draft, user.id);
    await notifyUsers(db, [...arbitrators, ...counterparty], {
      key: `dispute_statement:${row.id}`,
      kind: 'dispute_statement',
      title: 'Dispute statement submitted',
      body: `The ${role} submitted a statement for escrow ${draft.escrow_contract_id}.`,
      draftId: draft.id,
      escrowContractId: draft.escrow_contract_id,
    }, now());
    reply.code(201);
    return row;
  });

  app.get('/drafts/:id/dispute-case', { preHandler: authenticate }, async (req) => {
    const { id } = parse(IdParams, req.params);
    const { draft } = await draftAccess(req, id, { allowArbitrator: true });
    return db
      .selectFrom('dispute_statements')
      .innerJoin('users', 'users.id', 'dispute_statements.user_id')
      .select(['dispute_statements.id', 'dispute_statements.role', 'dispute_statements.statement', 'dispute_statements.created_at', 'users.address'])
      .where('draft_id', '=', draft.id)
      .orderBy('dispute_statements.created_at')
      .execute();
  });
}
