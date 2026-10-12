/*
 * Plain words for the responder's fixed codes (docs/RESPONDER.md). Server text is never
 * shown; only the code is read. Pure, so it is unit tested.
 */
import { PROVIDER_NAMES, type PauseReason, type Provider } from './contract';

export function providerName(provider: Provider | null | undefined): string {
  return provider ? PROVIDER_NAMES[provider] : 'the provider';
}

/** The key/setup error codes of `POST …/responder/key` and `PUT …/responder`. */
export function setupErrorCopy(
  code: string,
  context: { provider: Provider; model?: string; status?: number },
): { message: string; field?: 'key' | 'model'; retry?: boolean } {
  const name = providerName(context.provider);
  switch (code) {
    case 'invalid_key':
      return {
        message: `${name} didn't accept this key. Check that you copied all of it.`,
        field: 'key',
      };
    case 'invalid_key_format':
      return {
        message:
          context.provider === 'anthropic'
            ? 'That doesn’t look like an Anthropic API key. It starts with sk-ant-api.'
            : 'That doesn’t look like an OpenAI API key. It starts with sk-.',
        field: 'key',
      };
    case 'unsupported_key':
      return { message: 'Use a standard API key, not an admin key.', field: 'key' };
    case 'forbidden_key':
      return {
        message: `${name} says this key isn't allowed to do that. Check the key's permissions.`,
        field: 'key',
      };
    case 'model_unavailable':
      return {
        message: `This key can't use ${context.model ?? 'this model'}. Pick another model.`,
        field: 'model',
      };
    case 'model_not_allowed':
      return { message: 'Choose one of the listed models.', field: 'model' };
    case 'provider_unreachable':
      return { message: `We couldn't reach ${name}. Try again in a minute.`, retry: true };
    case 'key_required':
      return { message: `Add a working ${name} API key first.`, field: 'key' };
    case 'timeout':
      return { message: `Checking the key took too long. Try again.`, retry: true };
    case 'rate_limited':
    case 'too_many_requests':
      return { message: 'Too many attempts. Wait a while, then try again.' };
    case 'human_required':
      return { message: 'Only the owner, signed in, can set up auto-reply.' };
    case 'responder_unavailable':
      return { message: 'Auto-reply isn’t available right now. Try again later.', retry: true };
    case 'offline':
      return { message: 'You’re offline. Check your connection, then try again.', retry: true };
    default:
      return context.status === 429
        ? { message: 'Too many attempts. Wait a while, then try again.' }
        : { message: 'Something went wrong. Try again.', retry: true };
  }
}

/** The paused state in plain words: text plus the action that resolves it. */
export function pauseCopy(
  reason: PauseReason | null,
  provider: Provider | null,
  pausedUntil: string | null,
  now = Date.now(),
): { text: string; action: 'change_key' | 'resume' | 'pick_model' | null } {
  const name = providerName(provider);
  switch (reason) {
    case 'invalid_key':
      return { text: `Paused: ${name} rejected the key.`, action: 'change_key' };
    case 'forbidden':
      return { text: `Paused: ${name} doesn't allow this key to reply.`, action: 'change_key' };
    case 'key_removed':
      return { text: 'Off: the key was removed.', action: 'change_key' };
    case 'quota':
      return { text: `Paused: your ${name} quota is used up.`, action: 'resume' };
    case 'model_unavailable':
      return { text: `Paused: this key can't use the chosen model.`, action: 'pick_model' };
    case 'rate_limited': {
      const minutes = pausedUntil
        ? Math.max(1, Math.ceil((Date.parse(pausedUntil) - now) / 60_000))
        : null;
      return {
        text: minutes
          ? `Paused for ${minutes} min: ${name} rate limit. It resumes by itself.`
          : `Paused: ${name} rate limit. It resumes by itself.`,
        action: null,
      };
    }
    case 'repeated_failures':
      return { text: `Paused after repeated errors from ${name}.`, action: 'resume' };
    default:
      return { text: 'Paused.', action: 'resume' };
  }
}

/** "about $0.02 a reply" */
export function costPerReply(usd: number): string {
  return `about $${usd.toFixed(2)} a reply`;
}

/** Parses a dollar amount typed by the owner ("$2", "2.5", "0.01"); null when invalid. */
export function parseUsd(value: string): number | null {
  const cleaned = value.trim().replace(/^\$/, '');
  if (!/^\d{1,3}(\.\d{1,2})?$/.test(cleaned)) return null;
  return Number(cleaned);
}

/** The consent notice (§1.1 item 6), with the agent and provider named. */
export function consentNotice(agentName: string, provider: Provider): string {
  const name = providerName(provider);
  return `When someone @mentions ${agentName} in a room, Central City sends that room's recent messages and your instructions to ${name} with your key, and posts the answer as ${agentName}, labelled Auto-reply. ${name} bills you. Room members see that ${agentName} replies automatically.`;
}
