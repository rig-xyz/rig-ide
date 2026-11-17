import { defineEvent } from '../lib/ipc/events';

/**
 * "Room sees": how much of your agent's work other members of a space see
 * in the Room. One setting per member per space, kept on the member's own
 * computer (`RigSettings.spacesRoomSees`) and enforced there, in the session
 * publisher, before anything is uploaded (`main/rig/spaces/trace-privacy.ts`).
 * The owner always sees all of their own agent's work.
 */

export type RoomSees = 'answer' | 'steps' | 'everything';

export const ROOM_SEES_LEVELS: readonly RoomSees[] = ['answer', 'steps', 'everything'];

export const DEFAULT_ROOM_SEES: RoomSees = 'steps';

export const ROOM_SEES_LABEL: Record<RoomSees, string> = {
  answer: 'Answer',
  steps: 'Steps',
  everything: 'Everything',
};

/** The only description the setting has: the current pick's tooltip. */
export const ROOM_SEES_TOOLTIP =
  'Answer: only the reply. Steps: what your agent did, not what your tools returned. Everything: every step and result. You always see all of your own agent’s work.';

export function isRoomSees(value: unknown): value is RoomSees {
  return value === 'answer' || value === 'steps' || value === 'everything';
}

/** A space's level from the saved map, or `fallback` (the person's own default, `spacesRoomSeesDefault`) for a space never set. */
export function roomSeesFor(
  saved: Readonly<Record<string, RoomSees>> | undefined,
  bindingId: string,
  fallback?: RoomSees
): RoomSees {
  const level = saved?.[bindingId];
  if (isRoomSees(level)) return level;
  return isRoomSees(fallback) ? fallback : DEFAULT_ROOM_SEES;
}

/** Recorded first in every run: the level it ran at, so other members' cards know why details are missing. */
export const RUN_PRIVACY_EVENT = 'run_privacy';
/**
 * Recorded at the start of a run nobody typed a message for: what started it. A press in a view
 * (`by: 'view'`, with the tab, the words on the button, the item it was pressed on and the line of
 * context the person added), the view's schedule (`clock`), or Rig's own look over the space
 * (`gardener`). The Room shows it above the run's card.
 */
export const RUN_TRIGGER_EVENT = 'run_trigger';
export type RunTrigger = {
  by: 'view' | 'clock' | 'gardener';
  /** The view's folder name; a press on its line in the Room opens that tab. */
  view?: string;
  label?: string;
  item?: string;
  note?: string;
};

const oneLine = (value: unknown, max: number): string | undefined => {
  if (typeof value !== 'string') return undefined;
  const text = value.replace(/\s+/g, ' ').trim().slice(0, max).trim();
  return text || undefined;
};

/** A trigger from untyped input (an event payload, a view's message): only the fields above, each one short line. */
export function parseRunTrigger(value: unknown): RunTrigger | null {
  if (!value || typeof value !== 'object') return null;
  const v = value as Record<string, unknown>;
  if (v.by !== 'view' && v.by !== 'clock' && v.by !== 'gardener') return null;
  const view = typeof v.view === 'string' && /^[a-z0-9][a-z0-9_-]{0,63}$/i.test(v.view) ? v.view : undefined;
  const label = oneLine(v.label, 60);
  const item = oneLine(v.item, 100);
  const note = oneLine(v.note, 240);
  return {
    by: v.by,
    ...(view ? { view } : {}),
    ...(label ? { label } : {}),
    ...(item ? { item } : {}),
    ...(note ? { note } : {}),
  };
}

/** At "answer only", stands in for each new step: `{steps}` so far, `final: true` at the end. */
export const PRIVATE_PROGRESS_EVENT = 'private_progress';
/** Appended by the relay when the owner hides a finished run's details: `{steps}`. */
export const DETAILS_HIDDEN_EVENT = 'details_hidden';
/**
 * The run's prompt went again in the same run: `{reason: 'sign_in'}` after its
 * turn failed on its agent's sign-in, `{reason: 'new_conversation'}` into a new
 * conversation after its session was lost or stopped responding before the
 * prompt started. What it printed before doesn't count.
 */
export const RUN_RETRIED_EVENT = 'run_retried';

/** One event of a run as its owner's computer recorded it, before the Room-sees filter. */
export type LocalRunEvent = { seq: number; kind: string; payload: Record<string, unknown> };

/**
 * Pushed to the owner's own windows for every event of a run this computer
 * is running: the Room shows your own runs from this unfiltered copy (the
 * "owner overlay"), so you see all of your agent's work and can answer its
 * approvals whatever the room sees.
 */
export const spacesLocalRunEventChannel = defineEvent<{ bindingId: string; runId: string; event: LocalRunEvent }>(
  'rig:spaces-local-run-event'
);
