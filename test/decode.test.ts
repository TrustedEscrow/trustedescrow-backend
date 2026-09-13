import { Address, Keypair, nativeToScVal, scValToNative, xdr } from '@stellar/stellar-sdk';
import { describe, expect, it } from 'vitest';
import { decodeEscrow, DecodeError } from '../src/chain/decode.js';
import { contractAddress } from './helpers.js';

/** Encodes values the way soroban-sdk `#[contracttype]` does, then decodes through scValToNative. */
const sym = (s: string) => xdr.ScVal.scvSymbol(s);
const variant = (name: string, payload?: xdr.ScVal) => xdr.ScVal.scvVec(payload ? [sym(name), payload] : [sym(name)]);
const u64 = (n: number) => nativeToScVal(BigInt(n), { type: 'u64' });
const bytes = (fill: number) => xdr.ScVal.scvBytes(Buffer.alloc(32, fill));
const struct = (fields: Record<string, xdr.ScVal>) =>
  xdr.ScVal.scvMap(
    Object.keys(fields)
      .sort()
      .map((k) => new xdr.ScMapEntry({ key: sym(k), val: fields[k]! })),
  );

const buyer = Keypair.random().publicKey();
const seller = Keypair.random().publicKey();
const ESCROW = contractAddress(9);
const TOKEN = contractAddress(1);

function escrowScVal(overrides: Record<string, xdr.ScVal> = {}) {
  return struct({
    buyer: new Address(buyer).toScVal(),
    seller: new Address(seller).toScVal(),
    arbitrator: new Address(Keypair.random().publicKey()).toScVal(),
    token: new Address(TOKEN).toScVal(),
    amount: nativeToScVal(1_500_000_000n, { type: 'i128' }),
    fee_bps: nativeToScVal(100, { type: 'u32' }),
    fee_recipient: new Address(Keypair.random().publicKey()).toScVal(),
    terms_hash: bytes(7),
    release_code_hash: bytes(8),
    state: variant('Funded'),
    created_at: u64(1_788_000_000),
    funding_deadline: u64(1_788_086_400),
    delivery_window: u64(259_200),
    receipt_window: u64(172_800),
    arbitration_window: u64(604_800),
    funded_at: u64(1_788_001_000),
    delivery_deadline: u64(1_788_260_200),
    receipt_deadline: u64(0),
    proof: variant('Pending'),
    dispute: variant('NotOpened'),
    settlement: variant('Open'),
    ...overrides,
  });
}

describe('decodeEscrow', () => {
  it('decodes a funded escrow', () => {
    const s = decodeEscrow(ESCROW, scValToNative(escrowScVal()), 42);
    expect(s).toMatchObject({
      contractId: ESCROW,
      buyer,
      seller,
      token: TOKEN,
      amount: '1500000000',
      feeBps: 100,
      termsHash: '07'.repeat(32),
      releaseCodeHash: '08'.repeat(32),
      state: 'Funded',
      deliveryWindow: 259_200,
      receiptDeadline: null,
      proof: null,
      dispute: null,
      settlement: { status: 'Open' },
      ledger: 42,
    });
    expect(s.deliveryDeadline).toEqual(new Date(1_788_260_200 * 1000));
  });

  it('decodes submitted proof, an opened dispute and a settlement path', () => {
    const s = decodeEscrow(
      ESCROW,
      scValToNative(
        escrowScVal({
          state: variant('Refunded'),
          proof: variant(
            'Submitted',
            struct({
              kind: variant('Tracking'),
              uri: xdr.ScVal.scvString('https://track.example/ABC123'),
              hash: bytes(3),
              submitted_at: u64(1_788_100_000),
            }),
          ),
          dispute: variant(
            'Opened',
            struct({ opened_by: variant('ReceiptTimeout'), opened_at: u64(1_788_300_000), from_state: variant('Delivered'), deadline: u64(1_788_904_800) }),
          ),
          settlement: variant('Refunded', variant('ArbitrationTimeout')),
        }),
      ),
      1,
    );
    expect(s.proof).toEqual({ kind: 'Tracking', uri: 'https://track.example/ABC123', hash: '03'.repeat(32), submittedAt: new Date(1_788_100_000_000) });
    expect(s.dispute).toMatchObject({ openedBy: 'ReceiptTimeout', fromState: 'Delivered' });
    expect(s.settlement).toEqual({ status: 'Refunded', path: 'ArbitrationTimeout' });
  });

  it('fails loudly on an unexpected shape', () => {
    expect(() => decodeEscrow(ESCROW, scValToNative(escrowScVal({ state: variant('Exploded') })), 1)).toThrow(DecodeError);
    expect(() => decodeEscrow(ESCROW, { buyer }, 1)).toThrow(DecodeError);
  });
});
