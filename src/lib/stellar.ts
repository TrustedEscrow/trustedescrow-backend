import { Keypair, StrKey } from '@stellar/stellar-sdk';

export const isAccountAddress = (a: string): boolean => StrKey.isValidEd25519PublicKey(a);
export const isContractAddress = (a: string): boolean => StrKey.isValidContract(a);
export const isAddress = (a: string): boolean => isAccountAddress(a) || isContractAddress(a);

function decodeSignature(signature: string): Buffer | null {
  if (/^[0-9a-fA-F]{128}$/.test(signature)) return Buffer.from(signature, 'hex');
  const b = Buffer.from(signature, 'base64');
  return b.length === 64 ? b : null;
}

/**
 * SEP-53 signed-message verification: the wallet signs
 * sha256("Stellar Signed Message:\n" + message) with the account's ed25519 key.
 * Accepts base64 (what Freighter returns) or hex.
 */
export function verifySignedMessage(address: string, message: string, signature: string): boolean {
  if (!isAccountAddress(address)) return false;
  const sig = decodeSignature(signature);
  if (!sig) return false;
  try {
    return Keypair.fromPublicKey(address).verifyMessage(message, sig);
  } catch {
    return false;
  }
}
