import { z } from 'zod';
import { getAddress } from 'viem';
import type { PaymentRequirements } from '../chain/x402-facilitator.js';

const address = z.string().regex(/^0x[0-9a-fA-F]{40}$/);
const uint = z
  .string()
  .regex(/^(0|[1-9][0-9]{0,77})$/)
  .refine((v) => BigInt(v) < 1n << 256n);
const schema = z
  .object({
    x402Version: z.literal(2),
    accepted: z
      .object({
        scheme: z.literal('exact'),
        network: z.string().max(32),
        amount: uint,
        asset: address,
        payTo: address,
        maxTimeoutSeconds: z.number().int().positive(),
        extra: z
          .object({
            name: z.string().max(64),
            version: z.string().max(16),
            assetTransferMethod: z.literal('eip3009').optional(),
          })
          .strict(),
      })
      .strict(),
    payload: z
      .object({
        signature: z
          .string()
          .max(16386)
          .regex(/^0x(?:[0-9a-fA-F]{2})+$/),
        authorization: z
          .object({
            from: address,
            to: address,
            value: uint,
            validAfter: uint,
            validBefore: uint,
            nonce: z.string().regex(/^0x[0-9a-fA-F]{64}$/),
          })
          .strict(),
      })
      .strict(),
    resource: z
      .object({
        url: z.string().max(2048),
        description: z.string().max(2048).optional(),
        mimeType: z.string().max(128).optional(),
      })
      .strict()
      .optional(),
    extensions: z.object({}).strict().optional(),
  })
  .strict();

/** No caller-provided terms survive: forward a bounded authorization with server-owned terms. */
export function parseReceivePayload(
  header: string,
  requirements: PaymentRequirements,
  resourceUrl: string,
) {
  try {
    if (header.length > 32768 || header.length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(header))
      return null;
    const bytes = Buffer.from(header, 'base64');
    if (bytes.toString('base64') !== header) return null;
    const parsed = schema.safeParse(
      JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)),
    );
    if (!parsed.success) return null;
    const { accepted: a, payload, resource } = parsed.data;
    const sameAddress = (a: string, b: string) => getAddress(a) === getAddress(b);
    if (
      a.scheme !== requirements.scheme ||
      a.network !== requirements.network ||
      a.amount !== requirements.amount ||
      !sameAddress(a.asset, requirements.asset) ||
      !sameAddress(a.payTo, requirements.payTo) ||
      a.maxTimeoutSeconds !== requirements.maxTimeoutSeconds ||
      a.extra.name !== requirements.extra?.name ||
      a.extra.version !== requirements.extra?.version ||
      (requirements.extra?.assetTransferMethod ?? 'eip3009') !== 'eip3009' ||
      (resource && resource.url !== resourceUrl) ||
      payload.authorization.value !== requirements.amount ||
      !sameAddress(payload.authorization.to, requirements.payTo) ||
      BigInt(payload.authorization.validAfter) >= BigInt(payload.authorization.validBefore)
    )
      return null;
    return {
      x402Version: 2 as const,
      accepted: { ...requirements, extra: { ...requirements.extra } },
      payload,
      resource: { url: resourceUrl },
    };
  } catch {
    return null;
  }
}
