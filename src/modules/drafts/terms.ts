import { z } from 'zod';
import type { EscrowSnapshot } from '../../chain/types.js';
import type { RailConfig } from '../../config.js';

/**
 * Order terms. `terms_hash = sha256(canonical_json(terms))` is what the buyer commits
 * on-chain in `Factory::create`, so everything a later arbitrator needs to judge the
 * trade lives here: item, delivery method, expected proof kind, windows.
 */

export const WINDOW_MIN_SECONDS = 3600;
export const WINDOW_MAX_SECONDS = 365 * 24 * 3600;
const I128_MAX = (1n << 127n) - 1n;
const MIN_FUNDING_LEAD_SECONDS = 300;

/** Physical goods by carrier need third-party evidence; see ARCHITECTURE §7 "Proof kinds". */
export const PROOF_KINDS_BY_METHOD = {
  in_person: ['Attestation', 'Tracking'],
  shipped: ['Tracking'],
  digital: ['Content'],
  service: ['Attestation'],
} as const satisfies Record<string, readonly string[]>;

const windowSeconds = z.number().int().min(WINDOW_MIN_SECONDS).max(WINDOW_MAX_SECONDS);

export const TermsInput = z
  .object({
    rail: z.string().min(1).max(64),
    amount: z
      .string()
      .regex(/^[1-9][0-9]{0,38}$/, 'positive integer in token base units, as a string')
      .refine((a) => BigInt(a) <= I128_MAX, 'exceeds i128'),
    item: z
      .object({
        title: z.string().trim().min(1).max(200),
        description: z.string().max(5000).default(''),
      })
      .strict(),
    delivery: z
      .object({
        method: z.enum(['in_person', 'shipped', 'digital', 'service']),
        proofKind: z.enum(['Tracking', 'Content', 'Attestation']),
        carrier: z.string().trim().min(1).max(100).optional(),
        notes: z.string().max(2000).optional(),
      })
      .strict()
      .refine((d) => (PROOF_KINDS_BY_METHOD[d.method] as readonly string[]).includes(d.proofKind), {
        message: 'proof kind not accepted for this delivery method',
        path: ['proofKind'],
      })
      .refine((d) => d.method !== 'shipped' || d.carrier !== undefined, {
        message: 'shipped goods must name a carrier',
        path: ['carrier'],
      }),
    windows: z.object({ delivery: windowSeconds, receipt: windowSeconds, arbitration: windowSeconds }).strict(),
    /** Absolute unix seconds. */
    fundingDeadline: z.number().int().positive(),
  })
  .strict();

export type TermsInputT = z.output<typeof TermsInput>;

export interface CanonicalTerms {
  version: 1;
  /** Draft id. Makes every draft's terms hash unique, which is how escrows are matched to drafts. */
  ref: string;
  buyer: string;
  seller: string;
  rail: string;
  token: string;
  amount: string;
  item: TermsInputT['item'];
  delivery: TermsInputT['delivery'];
  windows: TermsInputT['windows'];
  fundingDeadline: number;
}

export function buildTerms(
  input: TermsInputT,
  ctx: { draftId: string; buyer: string; seller: string; rail: RailConfig },
): CanonicalTerms {
  return {
    version: 1,
    ref: ctx.draftId,
    buyer: ctx.buyer,
    seller: ctx.seller,
    rail: ctx.rail.id,
    token: ctx.rail.tokenAddress,
    amount: input.amount,
    item: input.item,
    delivery: input.delivery,
    windows: input.windows,
    fundingDeadline: input.fundingDeadline,
  };
}

export function fundingDeadlineProblem(fundingDeadline: number, now: Date): string | null {
  const nowS = Math.floor(now.getTime() / 1000);
  if (fundingDeadline < nowS + MIN_FUNDING_LEAD_SECONDS) return 'funding deadline must be at least 5 minutes in the future';
  if (fundingDeadline > nowS + WINDOW_MAX_SECONDS) return 'funding deadline must be within 365 days';
  return null;
}

/** Fields where a deployed escrow disagrees with the agreed terms. Empty means it matches. */
export function compareTermsWithEscrow(terms: CanonicalTerms, termsHash: string, s: EscrowSnapshot): string[] {
  const mismatches: string[] = [];
  const check = (field: string, ok: boolean) => ok || mismatches.push(field);
  check('terms_hash', s.termsHash === termsHash.toLowerCase());
  check('buyer', s.buyer === terms.buyer);
  check('seller', s.seller === terms.seller);
  check('token', s.token === terms.token);
  check('amount', s.amount === terms.amount);
  check('delivery_window', s.deliveryWindow === terms.windows.delivery);
  check('receipt_window', s.receiptWindow === terms.windows.receipt);
  check('arbitration_window', s.arbitrationWindow === terms.windows.arbitration);
  check('funding_deadline', Math.floor(s.fundingDeadline.getTime() / 1000) === terms.fundingDeadline);
  return mismatches;
}
