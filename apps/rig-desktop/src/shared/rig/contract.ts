import { defineEvent } from '../lib/ipc/events';

/**
 * Rig Tasks bridge contract — main-process bridge observes ACP plan updates,
 * publishes them as intents to the tap relay, and pushes board snapshots to
 * the renderer over this channel. The renderer never talks to the relay
 * directly (no CORS dependency; capability token stays in main).
 */

export type RigUiStatus = 'todo' | 'doing' | 'done' | 'abandoned';

export type RigIntentView = {
  id: string;
  title: string;
  agent: string;
  status: 'open' | 'closed' | 'abandoned';
  uiStatus: RigUiStatus;
  summaryText: string | null;
  parentIntentId: string | null;
  createdAt: string;
  closedAt: string | null;
};

export type RigTasksSnapshot = {
  /** rig workspace root the active session is bound to, if any */
  workspacePath: string | null;
  bindingId: string | null;
  relayUrl: string | null;
  /** true once the relay has accepted at least one request this session */
  connected: boolean;
  error: string | null;
  intents: RigIntentView[];
  updatedAt: number;
};

export const rigTasksUpdateChannel = defineEvent<RigTasksSnapshot>('rig:tasks-update');
