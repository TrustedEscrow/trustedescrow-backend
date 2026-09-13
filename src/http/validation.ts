import { z } from 'zod';
import { badRequest } from '../lib/errors.js';
import { isAddress } from '../lib/stellar.js';

export function parse<S extends z.ZodType>(schema: S, data: unknown): z.output<S> {
  const result = schema.safeParse(data);
  if (!result.success) {
    throw badRequest(
      'VALIDATION_ERROR',
      'Request validation failed',
      result.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
    );
  }
  return result.data;
}

export const StellarAddress = z.string().refine(isAddress, 'must be a valid Stellar account (G…) or contract (C…) address');
export const Hex32 = z
  .string()
  .regex(/^[0-9a-fA-F]{64}$/, 'must be 32 bytes, hex-encoded')
  .transform((s) => s.toLowerCase());
export const IdParams = z.object({ id: z.uuid() });
