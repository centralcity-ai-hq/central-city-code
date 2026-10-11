import { getAddress } from 'viem';
import { allowedToken, baseNetwork } from '../../../shared/base/chains.js';
import type { facilitatorClient, PaymentRequirements } from '../chain/x402-facilitator.js';
import { parseReceivePayload } from './receive-payload.js';
import type { createReceiveRuntime } from './receive-runtime.js';
import type { createReceiveStore } from './receive-store.js';

interface ResourcePrice {
  price: string;
  token: string;
  recipient: string;
  chainId: number;
}

/** Unwired adapter: resolver must enforce current visibility; no new public resource is exposed. */
export function createReceiveRoute<T>(deps: {
  env: { CITY_BASE_X402_RECEIVE?: string; CITY_BASE_MAINNET?: string };
  resourceUrl: string;
  authenticate(request: Request): Promise<string | null>;
  resolveResource(workspaceId: string, resourceId: string): Promise<ResourcePrice | null>;
  facilitator: ReturnType<typeof facilitatorClient>;
  run: ReturnType<typeof createReceiveRuntime<T>>;
  find: ReturnType<typeof createReceiveStore>['find'];
}) {
  const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
    Response.json(body, { status, headers: { 'cache-control': 'no-store', ...headers } });
  return async (request: Request, resourceId: string): Promise<Response> => {
    if (deps.env.CITY_BASE_X402_RECEIVE !== '1') return json(404, { error: 'NOT_FOUND' });
    if (request.method !== 'GET')
      return json(405, { error: 'METHOD_NOT_ALLOWED' }, { Allow: 'GET' });
    try {
      const workspaceId = await deps.authenticate(request);
      if (!workspaceId) return json(401, { error: 'UNAUTHORIZED' });
      const resource = await deps.resolveResource(workspaceId, resourceId);
      if (!resource) return json(404, { error: 'NOT_FOUND' });
      const { price, token, recipient, chainId } = resource;
      const network = baseNetwork(chainId, deps.env);
      const asset = network && allowedToken(network, token);
      if (
        ![8453, 84532].includes(chainId) ||
        !asset?.eip712 ||
        !/^[1-9][0-9]{0,77}$/.test(price) ||
        BigInt(price) >= 1n << 256n
      )
        return json(503, { error: 'UNAVAILABLE' });
      const requirements: PaymentRequirements = {
        scheme: 'exact',
        network: `eip155:${chainId}`,
        amount: price,
        asset: getAddress(token),
        payTo: getAddress(recipient),
        maxTimeoutSeconds: 60,
        extra: { ...asset.eip712, assetTransferMethod: 'eip3009' },
      };
      const challenge = () => {
        const body = {
          x402Version: 2,
          resource: { url: deps.resourceUrl },
          accepts: [requirements],
        };
        return json(402, body, {
          'PAYMENT-REQUIRED': Buffer.from(JSON.stringify(body)).toString('base64'),
        });
      };
      const header = request.headers.get('PAYMENT-SIGNATURE');
      if (!header) return challenge();
      const payment = parseReceivePayload(header, requirements, deps.resourceUrl);
      if (!payment) return json(400, { error: 'INVALID_PAYMENT' });
      const binding = {
        workspaceId,
        resource: resourceId,
        chainId,
        token,
        recipient,
        amount: price,
        payer: payment.payload.authorization.from,
        nonce: payment.payload.authorization.nonce,
      };
      const existing = await deps.find(binding);
      if (!existing) {
        const verification = await deps.facilitator.verify(payment, requirements);
        if (verification.kind === 'unknown') return json(503, { error: 'UNAVAILABLE' });
        if (
          verification.kind !== 'valid' ||
          (verification.payer !== null &&
            getAddress(verification.payer) !== getAddress(payment.payload.authorization.from))
        )
          return json(400, { error: 'INVALID_PAYMENT' });
      }
      const result = await deps.run(
        {
          workspaceId,
          resource: resourceId,
          chainId,
          token,
          recipient,
          amount: price,
          payer: payment.payload.authorization.from,
          nonce: payment.payload.authorization.nonce,
          validBefore: payment.payload.authorization.validBefore,
        },
        () => deps.facilitator.settle(payment, requirements),
        existing !== null,
      );
      // This authorization can never pay: ask again so the payer signs a fresh nonce.
      if (result.kind === 'failed') return challenge();
      return result.kind === 'paid'
        ? json(200, result.value, {
            'PAYMENT-RESPONSE': Buffer.from(
              JSON.stringify({
                success: true,
                transaction: result.transaction,
                network: requirements.network,
                payer: payment.payload.authorization.from,
              }),
            ).toString('base64'),
          })
        : json(202, { state: 'pending', receiptId: result.receiptId });
    } catch {
      return json(503, { error: 'UNAVAILABLE' });
    }
  };
}
