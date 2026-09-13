import type { rpc, xdr } from '@stellar/stellar-sdk';
import type { EscrowState } from '../db/schema.js';

export type { EscrowState };
export const TERMINAL_STATES: ReadonlySet<EscrowState> = new Set(['Released', 'Refunded', 'Cancelled']);

/** Contract storage for one escrow, decoded from `Escrow::get` (ARCHITECTURE §4 "State"). */
export interface EscrowSnapshot {
  contractId: string;
  buyer: string;
  seller: string;
  arbitrator: string;
  token: string;
  /** i128 base units, decimal string. */
  amount: string;
  feeBps: number;
  feeRecipient: string;
  termsHash: string;
  releaseCodeHash: string;
  state: EscrowState;
  createdAt: Date;
  fundingDeadline: Date;
  deliveryWindow: number;
  receiptWindow: number;
  arbitrationWindow: number;
  fundedAt: Date | null;
  deliveryDeadline: Date | null;
  receiptDeadline: Date | null;
  proof: { kind: string; uri: string; hash: string; submittedAt: Date } | null;
  dispute: { openedBy: string; openedAt: Date; fromState: string; deadline: Date } | null;
  settlement: { status: 'Open' } | { status: 'Released'; path: string } | { status: 'Refunded'; path: string };
  /** Ledger the read was simulated against. */
  ledger: number;
}

/** Live contract reads. Escrow detail always comes from here, never from the cache. */
export interface ChainReader {
  getEscrow(contractId: string): Promise<EscrowSnapshot>;
}

export interface ChainEvent {
  id: string;
  txHash: string;
  ledger: number;
  contractId: string;
  topic: xdr.ScVal[];
  value: xdr.ScVal;
  inSuccessfulContractCall: boolean;
}

export interface EventPage {
  events: ChainEvent[];
  cursor: string;
  latestLedger: number;
  oldestLedger: number;
}

export interface ChainClient extends ChainReader {
  getHealth(): Promise<{ latestLedger: number; oldestLedger: number }>;
  getEvents(request: rpc.Api.GetEventsRequest): Promise<EventPage>;
  getInstanceLiveUntil(contractId: string): Promise<{ liveUntil: number | null; latestLedger: number }>;
}

export class ChainError extends Error {
  constructor(
    message: string,
    readonly kind: 'not_found' | 'archived' | 'simulation' | 'rpc',
  ) {
    super(message);
  }
}
