import { useEffect, useState, useSyncExternalStore } from 'react';
import { selectedWorkspaceId } from '../api';
import { BaseRegistrationController, type OwnerMode } from './baseRegistrationController';

/**
 * The controller for this agent in the workspace selected now. Another agent or workspace gets a
 * new controller in the same render, so nothing of the previous one is ever shown for it; the old
 * one is stopped, which drops its late answers and timers. A read-only one starts from this
 * agent's last answer in this workspace, if the page has one (src/base/baseStatusCache.ts).
 */
function useController(
  agentId: string,
  readOnly: boolean,
  paused = false,
  ownerMode?: OwnerMode,
): BaseRegistrationController {
  const workspace = selectedWorkspaceId();
  const [held, setHeld] = useState(
    () => new BaseRegistrationController(agentId, workspace, { readOnly, ownerMode }),
  );
  let controller = held;
  if (held.agentId !== agentId || held.workspace !== workspace || held.readOnly !== readOnly) {
    controller = new BaseRegistrationController(agentId, workspace, { readOnly, ownerMode });
    setHeld(controller);
  }
  // Paused: no reads and no timers; the last answer stays shown. Unpaused, it reads afresh.
  useEffect(() => {
    if (paused) return;
    controller.start();
    return () => controller.stop();
  }, [controller, paused]);
  return controller;
}

/**
 * The Base registration of one agent: reads where it stands, gives the agent its own wallet on Base
 * and registers its ERC-8004 identity, controlled by the wallet the owner names. The server does the
 * chain work step by step; this calls it again when the server says to (every few seconds on older
 * servers) until the identity is confirmed. Rendering is the caller's. With `idle` it reads nothing
 * (an agent without a profile, which the server never knows for Base).
 */
export function useBaseRegistration(
  agentId: string,
  idle = false,
  /** The screen decides the owner mode (wallet key or address) before anything resumes. */
  options: { ownerModePending?: boolean } = {},
) {
  const controller = useController(
    agentId,
    false,
    idle,
    options.ownerModePending ? { kind: 'pending' } : undefined,
  );
  const snapshot = useSyncExternalStore(controller.subscribe, controller.getSnapshot);
  return {
    ...snapshot,
    reloadStatus: controller.reloadStatus,
    setAddress: controller.setAddress,
    submit: controller.submit,
    retryNow: controller.retryNow,
    continueWithBound: controller.continueWithBound,
    checkAgain: controller.checkAgain,
    askMakePublic: controller.askMakePublic,
    cancelMakePublic: controller.cancelMakePublic,
    makePublicAndRegister: controller.makePublicAndRegister,
    setMode: controller.setMode,
  };
}

export type BaseRegistrationState = ReturnType<typeof useBaseRegistration>;

/**
 * Where an agent's Base registration stands, read-only: one status read, then re-reads while a
 * registration is in progress (as often as the server says). It never sends a registration.
 * While `paused` it reads nothing and keeps the last answer; unpaused, it reads again, and the last
 * answer stays shown until the fresh one replaces it.
 */
export function useBaseRegistrationStatus(agentId: string, paused = false) {
  const controller = useController(agentId, true, paused);
  return useSyncExternalStore(controller.subscribe, controller.getSnapshot);
}

export type BaseRegistrationStatus = ReturnType<typeof useBaseRegistrationStatus>;
