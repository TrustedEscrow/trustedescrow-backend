import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { auth, authenticate } from '../auth/session.js';
import { IdParams, parse } from '../http/validation.js';
import { notFound } from '../lib/errors.js';

const ListQuery = z.object({
  unreadOnly: z.enum(['true', 'false']).default('false').transform((v) => v === 'true'),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  before: z.iso.datetime().optional(),
});

export async function notificationRoutes(app: FastifyInstance): Promise<void> {
  const { db } = app.deps;
  const now = () => app.deps.now();

  app.get('/notifications', { preHandler: authenticate }, async (req) => {
    const { user } = auth(req);
    const q = parse(ListQuery, req.query);
    let query = db
      .selectFrom('notifications')
      .select(['id', 'kind', 'title', 'body', 'escrow_contract_id', 'draft_id', 'send_at', 'read_at'])
      .where('user_id', '=', user.id)
      .where('cancelled_at', 'is', null)
      .where('send_at', '<=', now());
    if (q.unreadOnly) query = query.where('read_at', 'is', null);
    if (q.before) query = query.where('send_at', '<', new Date(q.before));
    return query.orderBy('send_at', 'desc').limit(q.limit).execute();
  });

  app.post('/notifications/:id/read', { preHandler: authenticate }, async (req, reply) => {
    const { user } = auth(req);
    const { id } = parse(IdParams, req.params);
    const res = await db
      .updateTable('notifications')
      .set({ read_at: now() })
      .where('id', '=', id)
      .where('user_id', '=', user.id)
      .executeTakeFirst();
    if (Number(res.numUpdatedRows) !== 1) throw notFound('Notification');
    reply.code(204);
  });

  app.post('/notifications/read-all', { preHandler: authenticate }, async (req, reply) => {
    const { user } = auth(req);
    await db
      .updateTable('notifications')
      .set({ read_at: now() })
      .where('user_id', '=', user.id)
      .where('read_at', 'is', null)
      .where('send_at', '<=', now())
      .execute();
    reply.code(204);
  });
}
