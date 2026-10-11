import { ELRIC_AI_TAG } from '../../shared/elric-copy';
import { possessive } from './people';

/**
 * Another account's agent, labelled as an AI (never as "another person"): the AI badge Elric's
 * messages use, then "· Ana's agent" when the owner's name is known (people.ts agentOwners), else
 * "agent". Screen readers hear "AI agent", with the owner when known.
 */
export function AgentLabel({ owner, title }: { owner: string | null; title?: string }) {
  return (
    <span className="rm-agent-label" title={title}>
      <span className="rm-visually-hidden">
        {owner ? `AI agent owned by ${owner}` : 'AI agent'}
      </span>
      <span aria-hidden="true">
        <span className="rm-badge-elric">{ELRIC_AI_TAG}</span>{' '}
        {owner ? `· ${possessive(owner)} agent` : 'agent'}
      </span>
    </span>
  );
}
