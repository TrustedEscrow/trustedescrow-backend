import type { EscrowSnapshot, EscrowState } from './types.js';

/**
 * Decodes the `scValToNative` form of the contract's `Escrow` struct.
 *
 * Soroban `#[contracttype]` structs arrive as objects keyed by their Rust field names,
 * unit enum variants as `["Variant"]`, tuple variants as `["Variant", payload]`,
 * u64/i128 as bigint and BytesN as Buffer. Optional parts are enums rather than
 * `Option` (ARCHITECTURE §4), e.g. `proof: ["Pending"] | ["Submitted", Proof]`.
 */

const STATES: ReadonlySet<string> = new Set(['Created', 'Funded', 'Delivered', 'Disputed', 'Released', 'Refunded', 'Cancelled']);

export class DecodeError extends Error {}

function tag(v: unknown, field: string): string {
  if (typeof v === 'string') return v;
  if (Array.isArray(v) && typeof v[0] === 'string') return v[0];
  throw new DecodeError(`${field}: expected enum variant, got ${describe(v)}`);
}

function payload(v: unknown): unknown {
  return Array.isArray(v) ? v[1] : undefined;
}

function record(v: unknown, field: string): Record<string, unknown> {
  if (v && typeof v === 'object' && !Array.isArray(v) && !Buffer.isBuffer(v)) return v as Record<string, unknown>;
  throw new DecodeError(`${field}: expected struct, got ${describe(v)}`);
}

function str(v: unknown, field: string): string {
  if (typeof v === 'string') return v;
  throw new DecodeError(`${field}: expected string, got ${describe(v)}`);
}

function int(v: unknown, field: string): bigint {
  if (typeof v === 'bigint') return v;
  if (typeof v === 'number' && Number.isInteger(v)) return BigInt(v);
  throw new DecodeError(`${field}: expected integer, got ${describe(v)}`);
}

function seconds(v: unknown, field: string): number {
  return Number(int(v, field));
}

function date(v: unknown, field: string): Date {
  return new Date(seconds(v, field) * 1000);
}

/** Deadlines and `funded_at` are 0 until set. */
function optionalDate(v: unknown, field: string): Date | null {
  const s = seconds(v, field);
  return s === 0 ? null : new Date(s * 1000);
}

function hex(v: unknown, field: string): string {
  if (v instanceof Uint8Array) return Buffer.from(v).toString('hex');
  throw new DecodeError(`${field}: expected bytes, got ${describe(v)}`);
}

function describe(v: unknown): string {
  if (Array.isArray(v)) return 'array';
  if (Buffer.isBuffer(v)) return 'bytes';
  return v === null ? 'null' : typeof v;
}

export function decodeEscrow(contractId: string, native: unknown, ledger: number): EscrowSnapshot {
  const e = record(native, 'escrow');
  const state = tag(e.state, 'state');
  if (!STATES.has(state)) throw new DecodeError(`state: unknown variant ${state}`);

  let proof: EscrowSnapshot['proof'] = null;
  if (tag(e.proof, 'proof') === 'Submitted') {
    const p = record(payload(e.proof), 'proof');
    proof = {
      kind: tag(p.kind, 'proof.kind'),
      uri: str(p.uri, 'proof.uri'),
      hash: hex(p.hash, 'proof.hash'),
      submittedAt: date(p.submitted_at, 'proof.submitted_at'),
    };
  }

  let dispute: EscrowSnapshot['dispute'] = null;
  if (tag(e.dispute, 'dispute') === 'Opened') {
    const d = record(payload(e.dispute), 'dispute');
    dispute = {
      openedBy: tag(d.opened_by, 'dispute.opened_by'),
      openedAt: date(d.opened_at, 'dispute.opened_at'),
      fromState: tag(d.from_state, 'dispute.from_state'),
      deadline: date(d.deadline, 'dispute.deadline'),
    };
  }

  const settlementTag = tag(e.settlement, 'settlement');
  let settlement: EscrowSnapshot['settlement'];
  if (settlementTag === 'Open') settlement = { status: 'Open' };
  else if (settlementTag === 'Released' || settlementTag === 'Refunded')
    settlement = { status: settlementTag, path: tag(payload(e.settlement), 'settlement.path') };
  else throw new DecodeError(`settlement: unknown variant ${settlementTag}`);

  return {
    contractId,
    buyer: str(e.buyer, 'buyer'),
    seller: str(e.seller, 'seller'),
    arbitrator: str(e.arbitrator, 'arbitrator'),
    token: str(e.token, 'token'),
    amount: int(e.amount, 'amount').toString(),
    feeBps: Number(int(e.fee_bps, 'fee_bps')),
    feeRecipient: str(e.fee_recipient, 'fee_recipient'),
    termsHash: hex(e.terms_hash, 'terms_hash'),
    releaseCodeHash: hex(e.release_code_hash, 'release_code_hash'),
    state: state as EscrowState,
    createdAt: date(e.created_at, 'created_at'),
    fundingDeadline: date(e.funding_deadline, 'funding_deadline'),
    deliveryWindow: seconds(e.delivery_window, 'delivery_window'),
    receiptWindow: seconds(e.receipt_window, 'receipt_window'),
    arbitrationWindow: seconds(e.arbitration_window, 'arbitration_window'),
    fundedAt: optionalDate(e.funded_at, 'funded_at'),
    deliveryDeadline: optionalDate(e.delivery_deadline, 'delivery_deadline'),
    receiptDeadline: optionalDate(e.receipt_deadline, 'receipt_deadline'),
    proof,
    dispute,
    settlement,
    ledger,
  };
}
