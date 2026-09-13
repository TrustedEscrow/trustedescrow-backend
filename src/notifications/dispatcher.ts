import type { Config } from '../config.js';
import type { DB } from '../db/index.js';
import type { Mailer } from './mailer.js';

const MAX_ATTEMPTS = 5;

export interface DispatchDeps {
  db: DB;
  mailer: Mailer;
  config: Pick<Config, 'PUBLIC_WEB_URL'>;
  now: () => Date;
  log: { warn: (obj: object, msg: string) => void };
}

/**
 * Delivers due notifications. In-app visibility needs nothing from here (a row is
 * visible once `send_at` passes); this adds email for users with a verified address.
 * Rows are claimed with SKIP LOCKED so several notifier processes can run.
 */
export async function dispatchDue(deps: DispatchDeps, batchSize = 100): Promise<number> {
  const now = deps.now();
  return deps.db.transaction().execute(async (trx) => {
    const due = await trx
      .selectFrom('notifications')
      .selectAll()
      .where('sent_at', 'is', null)
      .where('cancelled_at', 'is', null)
      .where('send_at', '<=', now)
      .orderBy('send_at')
      .limit(batchSize)
      .forUpdate()
      .skipLocked()
      .execute();
    if (due.length === 0) return 0;

    const users = await trx
      .selectFrom('users')
      .select(['id', 'email', 'email_verified_at'])
      .where('id', 'in', [...new Set(due.map((n) => n.user_id))])
      .execute();
    const byId = new Map(users.map((u) => [u.id, u]));

    for (const n of due) {
      const user = byId.get(n.user_id);
      const email = user?.email && user.email_verified_at ? user.email : null;
      if (!email) {
        await trx.updateTable('notifications').set({ sent_at: now }).where('id', '=', n.id).execute();
        continue;
      }
      const link = n.escrow_contract_id
        ? `${deps.config.PUBLIC_WEB_URL}/escrows/${n.escrow_contract_id}`
        : n.draft_id
          ? `${deps.config.PUBLIC_WEB_URL}/drafts/${n.draft_id}`
          : deps.config.PUBLIC_WEB_URL;
      try {
        await deps.mailer.send({ to: email, subject: `TrustEscrow: ${n.title}`, text: `${n.body}\n\n${link}\n` });
        await trx.updateTable('notifications').set({ sent_at: now, email_sent_at: now }).where('id', '=', n.id).execute();
      } catch (e) {
        const attempts = n.attempts + 1;
        deps.log.warn({ notificationId: n.id, attempts, err: String(e) }, 'notification email failed');
        await trx
          .updateTable('notifications')
          .set({
            attempts,
            last_error: String(e).slice(0, 500),
            // Give up on email after MAX_ATTEMPTS; the in-app copy is still visible.
            ...(attempts >= MAX_ATTEMPTS
              ? { sent_at: now }
              : { send_at: new Date(now.getTime() + 60_000 * 2 ** attempts) }),
          })
          .where('id', '=', n.id)
          .execute();
      }
    }
    return due.length;
  });
}
