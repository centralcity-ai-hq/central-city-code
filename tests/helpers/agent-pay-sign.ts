import { randomBytes } from 'node:crypto';
import type { LocalAccount } from 'viem/accounts';
import { agentPayConsentTypedData } from '../../shared/base/agent-pay-consent.js';

/** The app under test: only what reading the consent screen needs. */
interface Injector {
  inject(request: { url: string; headers: Record<string, string> }): Promise<{ json(): unknown }>;
}

/**
 * The agent-pay consent PUT body as the owner's screen sends it since CCA-113: the limit and
 * recipients shown, signed by the wallet's owner key over what the screen (GET) says to sign.
 */
export async function signedConsent(
  app: Injector,
  cookie: string,
  agentId: string,
  owner: LocalAccount,
  body: { permissionHash: string; recipients?: string },
  options: { issuedAt?: number } = {},
): Promise<string> {
  const view = (
    await app.inject({ url: `/api/base/agents/${agentId}/wallet/agent-pay`, headers: { cookie } })
  ).json() as { chainId: number; signing?: { wallet: string; token: string } };
  const nonce = `0x${randomBytes(32).toString('hex')}`;
  const issuedAt = options.issuedAt ?? Date.now();
  const signature = await owner.signTypedData(
    agentPayConsentTypedData({
      chainId: view.chainId,
      wallet: view.signing!.wallet,
      token: view.signing!.token,
      permissionHash: body.permissionHash,
      recipients: body.recipients ?? 'central-city-agents',
      nonce,
      issuedAt,
    }),
  );
  return JSON.stringify({ ...body, nonce, issuedAt, signature });
}
