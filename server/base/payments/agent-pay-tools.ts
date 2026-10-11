import { z } from 'zod';
import {
  cityPayInput,
  cityPayStatusInput,
  type AgentPayCaller,
  type AgentPayService,
} from './agent-pay.js';

/**
 * Base Pay P2c MCP tools as a self-contained module (service: agent-pay.ts). Registered in
 * server/remote-mcp/tools.ts and server/assistant-access.ts, only while CITY_BASE_WALLET=1 and
 * CITY_BASE_AGENT_PAY=1, and callable only with the `pay` scope, which is never a default. The
 * recipient text is untrusted (often from a room): it is parsed, never fetched, and nothing in a
 * call can give consent, change a limit or change the recipient once resolved.
 */

export const AGENT_PAY_TOOLS = ['city_pay', 'city_pay_status'] as const;
export type AgentPayToolName = (typeof AGENT_PAY_TOOLS)[number];

export const agentPayInputSchemas: Record<AgentPayToolName, z.ZodType> = {
  city_pay: cityPayInput,
  city_pay_status: cityPayStatusInput,
};

const payment = z
  .object({
    payment_id: z.string(),
    state: z.enum(['pending', 'included', 'final', 'failed']),
    amount: z.object({ raw: z.string(), display: z.string(), token: z.literal('USDC') }).strict(),
    from: z
      .object({ agentId: z.string(), wallet: z.string(), via: z.literal('spending_limit') })
      .strict(),
    onchainSender: z.string(),
    to: z
      .object({
        agentId: z.string(),
        name: z.string().optional(),
        baseId: z.string(),
        wallet: z.string(),
        checkedAtBlock: z.number().int(),
      })
      .strict(),
    txHash: z.string().nullable(),
  })
  .strict();

export const agentPayOutputSchemas: Record<AgentPayToolName, z.ZodType> = {
  city_pay: payment,
  city_pay_status: payment,
};

export const agentPayDescriptions: Record<
  AgentPayToolName,
  { title: string; description: string }
> = {
  city_pay: {
    title: 'Pay a Central City agent',
    description:
      "Pay another Central City agent in USDC from one of your agents' own wallets on Base, within the spending limit its owner signed and only if its owner allowed that agent to pay on its own for that limit. The recipient is a Central City agent named by its Base ID, passport link, passport number or agent wallet address; the text is only parsed, never opened, and any other address is refused. USDC only, at least 0.01; fees are covered by a pinned sponsor or nothing is sent. A retry with the same idempotency_key returns the same payment and never pays twice. The owner's consent screen saying payments are allowed only means a consent covers the current limit; each payment is still checked in full, and a refusal names the check that refused (for example no_consent, over_limit, wallet_not_usable or unavailable). Returns payment_id, state, amount, from (the paying agent and its own wallet, via its spending limit), to (the agent, its wallet and the Base block it was checked at) and txHash. Only state final means the recipient was paid; pending and included are on their way, failed did not go through. onchainSender is the agent's spender account, which sends the transfer on Base by spending from the agent's wallet under the limit: it is not the agent's wallet. There is no note field. Payments on Base cannot be undone.",
  },
  city_pay_status: {
    title: 'Read a Central City payment',
    description:
      'Read one payment city_pay made from this workspace, brought up to date from Base. It never signs and never builds a new payment, but while bringing it up to date it may resend the payment’s same already-signed operation to Base. Returns the same fields as city_pay. Only state final means the recipient was paid. A payment of another workspace is not found.',
  },
};

export interface AgentPayAnnotations {
  readOnlyHint: boolean;
  destructiveHint: boolean;
  idempotentHint: boolean;
  openWorldHint: boolean;
}

/**
 * city_pay moves money to another owner's agent and cannot be undone. city_pay_status signs nothing
 * and builds nothing new, but it reads Base and may resend the payment's already-signed operation
 * while reconciling it, so it is not read-only.
 */
export const agentPayAnnotations: Record<AgentPayToolName, AgentPayAnnotations> = {
  city_pay: {
    readOnlyHint: false,
    destructiveHint: true,
    idempotentHint: true,
    openWorldHint: true,
  },
  city_pay_status: {
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: true,
  },
};

/** Both tools need `pay`, a scope no grant or key holds unless it was asked for by name. */
export const AGENT_PAY_TOOL_SCOPES: Record<AgentPayToolName, 'pay'> = {
  city_pay: 'pay',
  city_pay_status: 'pay',
};

/** True only when both CITY_BASE_WALLET and CITY_BASE_AGENT_PAY are exactly 1 (read per call). */
export function agentPayEnabled(
  env: NodeJS.ProcessEnv | Record<string, string | undefined> = process.env,
): boolean {
  return env.CITY_BASE_WALLET === '1' && env.CITY_BASE_AGENT_PAY === '1';
}

/** Dispatches one tool call; the caller is the one assistant-access.ts builds from the credential. */
export function runAgentPayTool(
  service: AgentPayService,
  name: AgentPayToolName,
  args: unknown,
  caller: AgentPayCaller,
): Promise<unknown> {
  return name === 'city_pay' ? service.pay(caller, args) : service.status(caller, args);
}
