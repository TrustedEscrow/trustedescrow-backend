import { HttpError, notFound } from '../lib/errors.js';
import { DecodeError } from './decode.js';
import { type ChainReader, ChainError, type EscrowSnapshot } from './types.js';

/** Live escrow read for HTTP handlers, with chain failures mapped to HTTP errors. */
export async function readEscrowOrThrow(chain: ChainReader, contractId: string): Promise<EscrowSnapshot> {
  try {
    return await chain.getEscrow(contractId);
  } catch (e) {
    if (e instanceof ChainError && e.kind === 'not_found') throw notFound('Escrow');
    if (e instanceof DecodeError) throw new HttpError(502, 'ESCROW_DECODE_FAILED', `Contract state did not decode: ${e.message}`);
    throw new HttpError(502, 'CHAIN_UNAVAILABLE', 'Could not read escrow state from Soroban RPC');
  }
}
