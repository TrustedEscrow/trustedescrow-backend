import type { EscrowSnapshot } from '../chain/types.js';

/**
 * Which notifications an escrow should have, given its current contract state
 * (ARCHITECTURE §6 "Notifications"). Pure: the indexer calls it after every
 * snapshot refresh and dedupe keys make repeated calls idempotent.
 *
 * "Something happened" notices are only emitted while the escrow is still in the state
 * they describe, so a backfill that first sees an escrow already settled doesn't send
 * a stale "you've been funded".
 */

export type Audience = 'buyer' | 'seller' | 'arbitrator';

export interface PlannedNotification {
  /** Dedupe key without the recipient; the store appends the user id. */
  key: string;
  kind: string;
  audience: Audience;
  title: string;
  body: string;
  sendAt: Date;
}

export interface NotificationPlan {
  upserts: PlannedNotification[];
  /** Pending reminders of these kinds no longer apply and should be cancelled. */
  cancelKinds: string[];
}

const HOUR = 3600 * 1000;

export const REMINDER_KINDS = {
  delivery: 'delivery_deadline_24h',
  receipt: 'receipt_deadline_24h',
  arbitration72: 'arbitration_deadline_72h',
  arbitration24: 'arbitration_deadline_24h',
} as const;

const epoch = (d: Date) => Math.floor(d.getTime() / 1000);

export function planEscrowNotifications(s: EscrowSnapshot, now: Date): NotificationPlan {
  const c = s.contractId;
  const upserts: PlannedNotification[] = [];
  const cancelKinds: string[] = [];

  const push = (audiences: Audience[], n: Omit<PlannedNotification, 'audience' | 'key'> & { key?: string }) => {
    for (const audience of audiences) {
      upserts.push({ ...n, audience, key: `${c}:${n.key ?? n.kind}:${audience}` });
    }
  };

  /** Reminder `leadMs` before `deadline`; sent immediately if that point has passed, skipped once the deadline has. */
  const remind = (audiences: Audience[], kind: string, deadline: Date | null, leadMs: number, title: string, body: string) => {
    if (!deadline || deadline.getTime() <= now.getTime()) return;
    const at = new Date(Math.max(deadline.getTime() - leadMs, now.getTime()));
    push(audiences, { kind, key: `${kind}:${epoch(deadline)}`, title, body, sendAt: at });
  };

  switch (s.state) {
    case 'Funded':
      push(['seller'], {
        kind: 'funded',
        title: 'Escrow funded',
        body: 'The buyer has deposited the funds. Deliver the goods and submit your proof of delivery before the delivery deadline.',
        sendAt: now,
      });
      remind(
        ['seller'],
        REMINDER_KINDS.delivery,
        s.deliveryDeadline,
        24 * HOUR,
        'Delivery deadline in 24 hours',
        'Submit proof of delivery within 24 hours. After the deadline anyone can refund the buyer. Do not hand over goods once the deadline has passed.',
      );
      break;

    case 'Delivered':
      push(['buyer'], {
        kind: 'proof_submitted',
        title: 'Seller submitted proof of delivery',
        body: 'When the goods are in your hands and checked, give the seller your delivery code or confirm receipt in the app. If something is wrong, open a dispute. Never give the code before you have the item.',
        sendAt: now,
      });
      remind(
        ['buyer'],
        REMINDER_KINDS.receipt,
        s.receiptDeadline,
        24 * HOUR,
        'Receipt deadline in 24 hours',
        'Confirm receipt, give your code on receipt, or open a dispute. After this deadline the arbitrator decides.',
      );
      break;

    case 'Disputed': {
      const escalated = s.dispute?.openedBy === 'ReceiptTimeout';
      push(['buyer', 'seller'], escalated
        ? {
            kind: 'escalated',
            title: 'Escrow escalated to arbitration',
            body: 'The buyer did not confirm receipt or dispute before the receipt deadline, so the arbitrator will now decide this escrow.',
            sendAt: now,
          }
        : {
            kind: 'dispute_opened',
            title: 'Dispute opened',
            body: 'A dispute has been opened on this escrow. Add your statement and any evidence for the arbitrator.',
            sendAt: now,
          });
      push(['arbitrator'], {
        kind: 'dispute_new',
        title: escalated ? 'New escalation' : 'New dispute',
        body: `Escrow ${c} needs a ruling before its arbitration deadline.`,
        sendAt: now,
      });
      const deadline = s.dispute?.deadline ?? null;
      remind(
        ['buyer', 'seller', 'arbitrator'],
        REMINDER_KINDS.arbitration72,
        deadline,
        72 * HOUR,
        'Arbitration deadline in 72 hours',
        'If the arbitrator has not ruled by the deadline, the buyer is refunded.',
      );
      remind(
        ['arbitrator'],
        REMINDER_KINDS.arbitration24,
        deadline,
        24 * HOUR,
        'Arbitration deadline in 24 hours',
        `Escrow ${c} refunds the buyer automatically if no ruling is made by the deadline.`,
      );
      break;
    }

    case 'Released':
    case 'Refunded': {
      const path = s.settlement.status === 'Open' ? '' : s.settlement.path;
      if (path === 'Arbitration') {
        push(['buyer', 'seller'], {
          kind: 'dispute_resolved',
          title: 'Dispute resolved',
          body: `The arbitrator ruled: ${s.state === 'Released' ? 'funds released to the seller' : 'buyer refunded'}.`,
          sendAt: now,
        });
      }
      push(['buyer', 'seller'], s.state === 'Released'
        ? { kind: 'released', title: 'Funds released', body: 'The escrow has been released to the seller.', sendAt: now }
        : { kind: 'refunded', title: 'Buyer refunded', body: 'The escrow has been refunded to the buyer in full.', sendAt: now });
      break;
    }

    case 'Cancelled':
      push(['buyer', 'seller'], { kind: 'cancelled', title: 'Escrow cancelled', body: 'The escrow was cancelled before funding.', sendAt: now });
      break;

    case 'Created':
      break;
  }

  if (s.state !== 'Funded') cancelKinds.push(REMINDER_KINDS.delivery);
  if (s.state !== 'Delivered') cancelKinds.push(REMINDER_KINDS.receipt);
  if (s.state !== 'Disputed') cancelKinds.push(REMINDER_KINDS.arbitration72, REMINDER_KINDS.arbitration24);

  return { upserts, cancelKinds };
}
