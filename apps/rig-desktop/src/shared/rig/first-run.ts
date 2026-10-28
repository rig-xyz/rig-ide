/**
 * The first run (rig/docs/onboarding-spec.md): its steps, its version, and
 * the progress kept in settings so a quit resumes where it stopped.
 */

/**
 * The first run's steps, in order. Home is where it ends, not a step. Not
 * every one is built yet: `renderer/features/first-run/steps.ts` says which.
 */
export const FIRST_RUN_STEP_IDS = [
  'welcome',
  'setup',
  'connect',
  'you',
  'read',
  'firstWin',
] as const;
export type FirstRunStepId = (typeof FIRST_RUN_STEP_IDS)[number];

/**
 * The flow's version. `firstRunSeen` below it shows the first run again, so
 * raising this shows a changed flow once to everyone who saw the old one.
 */
export const FIRST_RUN_VERSION = 1;

/** Where a first run in progress stopped. */
export type FirstRunProgress = {
  step: FirstRunStepId;
  /** The first read (pass 1) has started, so a resume goes back to Read, not before it. */
  readStarted: boolean;
};

export function isFirstRunStepId(value: unknown): value is FirstRunStepId {
  return typeof value === 'string' && (FIRST_RUN_STEP_IDS as readonly string[]).includes(value);
}

export function normalizeFirstRunProgress(value: unknown): FirstRunProgress | null {
  if (typeof value !== 'object' || value === null) return null;
  const raw = value as Record<string, unknown>;
  if (!isFirstRunStepId(raw.step)) return null;
  return { step: raw.step, readStarted: raw.readStarted === true };
}

/**
 * The tools Rig has a logo and words for. Connect lists whatever the person's
 * Claude has; one of these shows its own mark, any other a neutral one.
 */
export const KNOWN_TOOLS = [
  'slack',
  'linear',
  'github',
  'gmail',
  'calendar',
  'notion',
  'granola',
] as const;
export type KnownTool = (typeof KNOWN_TOOLS)[number];

/** How a known tool shows up in Claude's list: its name ("claude.ai Slack") or its server's host. */
const KNOWN_MATCH: Record<KnownTool, RegExp> = {
  slack: /slack/i,
  linear: /linear/i,
  github: /github/i,
  gmail: /gmail|google mail/i,
  calendar: /calendar|gcal/i,
  notion: /notion/i,
  granola: /granola/i,
};

/** A known tool's name, as claude.ai names its connector. */
export const KNOWN_NAME: Record<KnownTool, string> = {
  slack: 'Slack',
  linear: 'Linear',
  github: 'GitHub',
  gmail: 'Gmail',
  calendar: 'Google Calendar',
  notion: 'Notion',
  granola: 'Granola',
};

/** The known tool a server is, from its name and URL, or null for any other. */
export function knownTool(name: string, url?: string | null): KnownTool | null {
  const text = `${name} ${url ?? ''}`;
  return KNOWN_TOOLS.find((t) => KNOWN_MATCH[t].test(text)) ?? null;
}

/**
 * One tool Connect lists, by the name Claude gives its server ("Granola",
 * "Google Drive"; claude.ai's own prefix dropped), or "GitHub" for `gh`.
 */
export type FirstRunConnector = string;

/**
 * The key a tool's choice is kept under: a known tool by its id, so "Google
 * Calendar" and a source named "Calendar" are one; any other by its name.
 */
export function toolKey(connector: FirstRunConnector): string {
  return knownTool(connector) ?? connector.trim().toLowerCase();
}

/**
 * One of the person's tools as their agent has it (`rpc.rig.firstRun.preflight`):
 * reachable, or there but needing the person to sign in again. Tools Claude
 * doesn't have aren't listed.
 */
export type ConnectorCheck = {
  connector: FirstRunConnector;
  /** Its logo and words, when Rig knows the tool. */
  known: KnownTool | null;
  state: 'connected' | 'needs_auth';
};
