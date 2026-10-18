import type { ReactNode } from 'react';
import type { Agent } from '../../../shared/types';

/** Props every screen of the agent pane takes (the v4 master–detail shell hosts them). */
export type AgentScreenProps = {
  agent: { id: string; name: string };
  onBack: () => void;
  /** Opens another screen of the pane: 'messages', 'thread:<context id>', 'rooms', 'base', … */
  onOpen: (screen: string) => void;
  /** The back link's label (the screen it returns to). */
  backLabel?: string;
  /** Opens a room's page (an invitation the agent just accepted). */
  onOpenRoom?: (roomId: string) => void;
};

/** A screen id is "<name>" or "<name>:<param>" (for example "thread:ctx_1"). */
export function screenName(id: string): string {
  const at = id.indexOf(':');
  return at < 0 ? id : id.slice(0, at);
}

/**
 * The pane's screens by name. Each area adds its screen here as it lands (Base, Messages, Rooms,
 * Activity, Developer details, Auto-reply, Permissions); a row whose screen is not here does
 * nothing.
 */
export type AgentScreens = Partial<
  Record<
    string,
    (
      props: AgentScreenProps & {
        param?: string;
        full: Agent;
        /** Re-reads the workspace after a screen changed the agent (made it public, renamed it). */
        onChanged: () => void;
      },
    ) => ReactNode
  >
>;
