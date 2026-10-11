import { ChevronRight, Plus } from 'lucide-react';
import type { Snapshot } from '../../../shared/types';
import { Avatar } from '../../rooms/Avatar';
import { AvatarColorsContext, useAvatarColors } from '../../shell/avatarColor';
import type { AgentScreenProps } from './messagesRoomsShared';
import { connectable, ownerLine, permissionRows } from './settingsActionsModel';
import {
  PERMISSIONS_READS,
  SNAPSHOT_READS,
  connectAgent,
  turnOffPermission,
  type PermissionsData,
} from './settingsRequests';
import {
  SettingsEmpty,
  SettingsError,
  SettingsFrame,
  SettingsLoading,
  Toggle,
  useSettingsLifecycle,
} from './settingsShared';

/**
 * Permissions: "Who can work with <name>", one row per agent it has a connection with (workspace
 * connections from the snapshot, approved connections with other owners). Owner decision G7:
 * turning a row off removes its connections (DELETE /api/connections/:id, POST
 * /api/v2/connections/requests/:id/revoke), and the row goes. All of a row's requests go for the
 * workspace it was shown in, and stop once the screen moves on (settingsRequests.ts).
 */
export function PermissionsScreen({ agent, onBack, onOpen, backLabel }: AgentScreenProps) {
  const { controller, view, load } = useSettingsLifecycle(agent.id, PERMISSIONS_READS);
  const read = load<PermissionsData>('permissions');
  const rows =
    read.state === 'ready'
      ? permissionRows(
          agent.id,
          read.data.snapshot.agents,
          read.data.snapshot.connections,
          read.data.cross,
        )
      : [];
  const colours = useAvatarColors(rows.map((row) => row.key));

  return (
    <SettingsFrame
      backLabel={backLabel ?? agent.name}
      onBack={onBack}
      title="Permissions"
      sub={`Who can work with ${agent.name}`}
      notice={view.notice}
    >
      {read.state === 'loading' ? (
        <SettingsLoading />
      ) : read.state === 'error' ? (
        <SettingsError
          message={read.message}
          onRetry={() => void controller.reload('permissions')}
        />
      ) : (
        <>
          {rows.length ? (
            <AvatarColorsContext.Provider value={colours}>
              <div className="ap4-group">
                {rows.map((row) => (
                  <div key={row.key} className="ap4-row v4s-still">
                    <Avatar
                      id={row.key}
                      name={row.name}
                      kind="agent"
                      size="sm"
                      className="v4s-av"
                    />
                    <span className="ap4-k v4s-two">
                      <b>{row.name}</b>
                      <span>{ownerLine(row.owner)}</span>
                    </span>
                    {view.busy === row.key ? (
                      <span className="v4s-spin" aria-hidden="true" />
                    ) : null}
                    <Toggle
                      checked
                      label={`Allow ${row.name}`}
                      disabled={Boolean(view.busy)}
                      onChange={() => void turnOffPermission(controller, row, view.generation)}
                    />
                  </div>
                ))}
              </div>
            </AvatarColorsContext.Provider>
          ) : (
            <SettingsEmpty title="No connections">
              Connect {agent.name} to agents it may work with.
            </SettingsEmpty>
          )}
          {view.error ? (
            <p className="ap4-note v4s-err" role="alert">
              {view.error}
            </p>
          ) : null}
          <button
            type="button"
            className="ap4-btn ap4-ghost v4s-wide"
            onClick={() => onOpen('permissions-add')}
          >
            <Plus className="v4s-i" aria-hidden="true" />
            Connect an agent
          </button>
        </>
      )}
    </SettingsFrame>
  );
}

/**
 * "Connect an agent": your other live agents without a connection to this one. Choosing one
 * lets it ask this agent for work (POST /api/connections {fromAgentId: it, toAgentId: this
 * agent}) and returns to Permissions. Agents of other owners connect through a request, not here.
 */
export function ConnectAgentScreen({ agent, onBack, backLabel }: AgentScreenProps) {
  const { controller, view, load } = useSettingsLifecycle(agent.id, SNAPSHOT_READS);
  const read = load<Snapshot>('snapshot');
  const choices =
    read.state === 'ready'
      ? connectable(
          agent.id,
          read.data.agents,
          permissionRows(agent.id, read.data.agents, read.data.connections, []),
        )
      : [];
  const colours = useAvatarColors(
    choices.map((item) => ({ id: item.id, joinedAt: item.createdAt })),
  );

  return (
    <SettingsFrame backLabel={backLabel ?? 'Permissions'} onBack={onBack} title="Connect an agent">
      {read.state === 'loading' ? (
        <SettingsLoading />
      ) : read.state === 'error' ? (
        <SettingsError message={read.message} onRetry={() => void controller.reload('snapshot')} />
      ) : choices.length ? (
        <AvatarColorsContext.Provider value={colours}>
          <div className="ap4-group">
            {choices.map((item) => (
              <button
                key={item.id}
                type="button"
                className="ap4-row"
                disabled={Boolean(view.busy)}
                onClick={() => void connectAgent(controller, item.id, view.generation, onBack)}
              >
                <Avatar id={item.id} name={item.name} kind="agent" size="sm" className="v4s-av" />
                <span className="ap4-k v4s-two">
                  <b>{item.name}</b>
                  <span>Your agent</span>
                </span>
                {view.busy === item.id ? (
                  <span className="v4s-spin" aria-hidden="true" />
                ) : (
                  <ChevronRight className="ap4-chev v4s-i v4s-i-sm" aria-hidden="true" />
                )}
              </button>
            ))}
          </div>
        </AvatarColorsContext.Provider>
      ) : (
        <SettingsEmpty title="No agent to connect">
          Your other agents are connected to {agent.name} already.
        </SettingsEmpty>
      )}
      {view.error ? (
        <p className="ap4-note v4s-err" role="alert">
          {view.error}
        </p>
      ) : null}
    </SettingsFrame>
  );
}
