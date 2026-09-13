import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { auth, authenticate } from '../auth/session.js';
import { IdParams, parse } from '../http/validation.js';
import { audit } from '../lib/audit.js';
import { containsDeliveryCode } from '../lib/delivery-code.js';
import { conflict, unprocessable } from '../lib/errors.js';
import { notifyUsers } from '../notifications/store.js';
import { counterpartyUserIds, draftAccess, knownReleaseCodeHash } from './access.js';

const ListQuery = z.object({
  after: z.coerce.number().int().min(0).default(0),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});
const PostBody = z.object({ body: z.string().trim().min(1).max(4000) });

export async function messageRoutes(app: FastifyInstance): Promise<void> {
  const { db } = app.deps;
  const now = () => app.deps.now();

  app.get('/drafts/:id/messages', { preHandler: authenticate }, async (req) => {
    const { id } = parse(IdParams, req.params);
    const { after, limit } = parse(ListQuery, req.query);
    const { draft } = await draftAccess(req, id, { allowArbitrator: true });
    const rows = await db
      .selectFrom('messages')
      .leftJoin('users', 'users.id', 'messages.sender_user_id')
      .select(['messages.seq', 'messages.sender_role', 'messages.body', 'messages.created_at', 'users.address as sender_address'])
      .where('draft_id', '=', draft.id)
      .where('seq', '>', after)
      .orderBy('seq')
      .limit(limit)
      .execute();
    return {
      messages: rows.map((m) => ({ seq: m.seq, senderRole: m.sender_role, senderAddress: m.sender_address, body: m.body, createdAt: m.created_at })),
      nextAfter: rows.at(-1)?.seq ?? after,
    };
  });

  /**
   * A message that contains this escrow's delivery code is refused before it is stored.
   * Detection is exact (hash match against the committed release_code_hash), so it has
   * no false positives. The client should catch this first; this is the backstop that
   * keeps plaintext codes out of the database.
   */
  app.post('/drafts/:id/messages', { preHandler: authenticate, config: { rateLimit: { max: 60, timeWindow: '1 minute' } } }, async (req, reply) => {
    const { user } = auth(req);
    const { id } = parse(IdParams, req.params);
    const { body } = parse(PostBody, req.body);
    const { draft, role } = await draftAccess(req, id, { allowArbitrator: true });

    const codeHash = await knownReleaseCodeHash(db, draft);
    if (codeHash && containsDeliveryCode(body, codeHash)) {
      await audit(db, req, user.id, 'message.code_blocked', draft.id);
      throw unprocessable(
        'DELIVERY_CODE_IN_MESSAGE',
        'This message contains your delivery code. The code is the money: never send it in chat. Give it to the seller only once the item is in your hands and checked.',
      );
    }

    const message = await db.transaction().execute(async (trx) => {
      const locked = await trx.selectFrom('drafts').select(['id', 'status']).where('id', '=', draft.id).forUpdate().executeTakeFirstOrThrow();
      if (locked.status === 'withdrawn') throw conflict('DRAFT_CLOSED', 'This draft was withdrawn');
      const { max } = await trx
        .selectFrom('messages')
        .select((eb) => eb.fn.max<number | null>('seq').as('max'))
        .where('draft_id', '=', draft.id)
        .executeTakeFirstOrThrow();
      return trx
        .insertInto('messages')
        .values({ draft_id: draft.id, seq: (max ?? 0) + 1, sender_user_id: user.id, sender_role: role, body })
        .returning(['seq', 'sender_role', 'body', 'created_at'])
        .executeTakeFirstOrThrow();
    });

    await notifyUsers(db, await counterpartyUserIds(db, draft, user.id), {
      key: `draft:${draft.id}:message:${message.seq}`,
      kind: 'message',
      title: role === 'arbitrator' ? 'Message from the arbitrator' : 'New message',
      body: 'You have a new message about your order.',
      draftId: draft.id,
      escrowContractId: draft.escrow_contract_id,
    }, now());

    reply.code(201);
    return { seq: message.seq, senderRole: message.sender_role, senderAddress: user.address, body: message.body, createdAt: message.created_at };
  });
}
