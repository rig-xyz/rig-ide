import { randomUUID } from 'node:crypto';
import { appendFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { app, powerMonitor } from 'electron';
import { err, ok, type Result } from '@emdash/shared';
import { getAcpRuntimeClient } from '@main/core/acp/controller';
import { events } from '@main/lib/events';
import { log } from '@main/lib/logger';
import { createRPCController } from '@shared/lib/ipc/rpc';
import { rigFeedChangedChannel, rigStartSessionChannel } from '@shared/rig/feed';
import { FIRST_RUN_VERSION } from '@shared/rig/first-run';
import { rigOrchProgressChannel, type OrchProgressEvent, type RunProblem } from '@shared/rig/orch-progress';
import type { RigAccountError } from '@shared/rig/account';
import { rigAccountController } from '../account';
import { globalSetup } from '../connectors/connections-instance';
import * as feedRelay from '../feed/relay';
import { getRecentThemes } from '../recent-themes';
import { resolveLocalPathsImpl } from '../recent-rigs';
import { rigSpaceStatusController } from '../space-status';
import { createRuntimeAcpSessions } from '../spaces/dispatch';
import { createHttpSpacesRelayApi } from '../spaces/relay-api';
import { createActions, type StartInput } from './actions';
import { createSender } from './send';
import { rigSpaceSetupController } from '../space-setup';
import { rigSettingsStore } from '../settings-instance';
import { createHomeSpace } from './home-space';
import { resolveSelfUserId } from '../account';
import { createOrchestrator, FIRST_RUN, type RunFail } from './agent';
import { createCatchUp, readWindow } from './catch-up';
import { runGhRead, runGhWrite } from './github';
import { readSnapshot } from './snapshot';
import { runSource, type Source } from './sources';
import { turnGate } from './turns';

/**
 * Boot wiring for the control plane (actions.ts): the real relay, spaces,
 * topics, connectors, sessions, sources and the dispatcher. Tests use
 * `createActions` with fakes.
 */

const relayApi = createHttpSpacesRelayApi();
const acp = createRuntimeAcpSessions(getAcpRuntimeClient);
const sourcesFile = () => join(app.getPath('userData'), 'orch-sources.json');

async function readSources(): Promise<Source[]> {
  try {
    const parsed: unknown = JSON.parse(await readFile(sourcesFile(), 'utf8'));
    return Array.isArray(parsed) ? (parsed as Source[]) : [];
  } catch {
    return [];
  }
}
async function writeSources(list: Source[]): Promise<void> {
  await writeFile(sourcesFile(), JSON.stringify(list, null, 2));
}
async function updateSource(ref: string, patch: Partial<Source>): Promise<Source | null> {
  const list = await readSources();
  const at = list.findIndex((x) => x.ref === ref);
  if (at < 0) return null;
  list[at] = { ...list[at]!, ...patch };
  await writeSources(list);
  return list[at]!;
}

const changed = () => events.emit(rigFeedChangedChannel, { reason: 'local' });

const headless = {
  acp,
  cwd: async () => {
    const dir = join(app.getPath('userData'), 'rig-watch');
    await mkdir(dir, { recursive: true });
    return dir;
  },
  newConversationId: () => `watch-${randomUUID()}`,
};

/** The account's spaces, with their folder on this Mac when they have one. */
async function listSpaces() {
  const ws = await rigAccountController.workspaces();
  if (!ws.success) return ws;
  const spaces = ws.data.filter((b) => b.kind === 'space');
  const roots = await resolveLocalPathsImpl(spaces.map((b) => b.id)).catch(() => ({}) as Record<string, string>);
  return ok(spaces.map((b) => ({ bindingId: b.id, name: b.name, root: roots[b.id] ?? null })));
}

/** Makes a space the way the app's own New space does, and waits until it's live (or failed). */
async function makeSpace(name: string): Promise<Result<{ bindingId: string; root: string }, string>> {
  const started = await rigSpaceSetupController.start({ name });
  if (!started.success) return err(started.error.message);
  const id = started.data.id;
  for (let waited = 0; waited < 180_000; waited += 1000) {
    const setup = (await rigSpaceSetupController.list()).find((x) => x.id === id);
    if (setup?.status === 'live' && setup.bindingId) return ok({ bindingId: setup.bindingId, root: setup.path });
    if (!setup || setup.status === 'failed') return err(setup?.error?.message ?? 'Setting up the space failed.');
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  return err('Setting up the space took too long.');
}

/** The person's private Home space (home-space.ts): Send and unbound Starts run there. */
export const homeSpace = createHomeSpace({
  homeSpaceId: () => rigSettingsStore.get().homeSpaceId,
  setHomeSpaceId: (id) => rigSettingsStore.set({ homeSpaceId: id }),
  spaces: listSpaces,
  create: makeSpace,
  log,
});

export const orchActions = createActions({
  relay: {
    query: (kind, opts) => feedRelay.orchQuery(kind, opts),
    get: (ref) => feedRelay.orchGet(ref),
    act: async (refs, action, args, actor) => {
      const r = await feedRelay.orchAct(refs, action, args, actor);
      if (r.success && r.data.some((x) => x.ok && !x.card)) changed();
      return r;
    },
    linkSession: (runId, situationId, bindingId) => feedRelay.linkSession(runId, situationId, bindingId),
    check: (check, subject) => feedRelay.orchCheck(check, subject),
    remember: (fact) => feedRelay.orchFact(fact),
    runNote: (runId, note) => feedRelay.orchRun(runId, '', note),
  },
  spaces: listSpaces,
  homeSpace: () => homeSpace.ensure(),
  topics: async () => {
    const t = await getRecentThemes();
    return t.kind === 'none' ? null : t.themes.map((x) => ({ name: x.name, space: x.spaceName, description: x.description, messages: x.messageCount, people: x.people }));
  },
  connectors: async () => {
    const entries = await globalSetup.claudeEntries(undefined).catch(() => null);
    return entries ? entries.map((e) => ({ name: e.name.replace(/^claude\.ai\s+/i, ''), state: e.state })) : null;
  },
  sessions: async () => {
    const [status, ws] = await Promise.all([rigSpaceStatusController.get(), rigAccountController.workspaces()]);
    if (!status.success) return err({ message: status.error.message });
    const names = new Map(ws.success ? ws.data.map((b) => [b.id, b.name] as const) : []);
    return ok(
      status.data.flatMap((s) => [
        ...s.running.map((r) => ({ ref: `ses_${r.runId}`, space: `#${names.get(s.bindingId) ?? s.bindingId}`, title: r.title ?? 'Session', state: r.activity ?? 'running', who: `${r.ownerName ?? 'someone'}'s ${r.agent === 'codex' ? 'Codex' : 'Claude'}`, at: r.startedAt })),
        ...(s.lastRun ? [{ ref: `space_${s.bindingId}`, space: `#${names.get(s.bindingId) ?? s.bindingId}`, title: 'Last run', state: s.lastRun.status, who: `${s.lastRun.ownerName ?? 'someone'}'s ${s.lastRun.agent === 'codex' ? 'Codex' : 'Claude'}`, at: s.lastRun.endedAt ?? '' }] : []),
      ])
    );
  },
  sources: {
    list: readSources,
    update: updateSource,
    run: async (ref) => {
      const source = (await readSources()).find((x) => x.ref === ref);
      if (!source) return null;
      await updateSource(ref, { lastStatus: 'running' });
      const outcome = await runSource(
        {
          ...headless,
          postEvents: async (evs) => {
            const r = await feedRelay.orchEvents(evs);
            return r.success ? r : err({ message: r.error.message });
          },
          now: () => Date.now(),
          log,
        },
        source
      );
      await updateSource(ref, {
        lastRun: new Date().toISOString(),
        lastStatus: outcome.status,
        lastCount: outcome.added,
        cursor: outcome.cursor,
        lastError: outcome.error,
      });
      log.info('Rig sources: checked', { ref, status: outcome.status, listed: outcome.listed, added: outcome.added });
      return outcome;
    },
  },
  startSession: (start) => events.emit(rigStartSessionChannel, start),
  newSessionId: () => randomUUID(),
  members: async (bindingId) => {
    const r = await relayApi.listMembers(bindingId);
    return r.success ? r.data.length : null;
  },
  writeFile: async (root, relPath, text) => {
    const file = join(root, relPath);
    if (!file.startsWith(join(root, 'sessions') + '/')) throw new Error('brief path outside the space');
    await mkdir(dirname(file), { recursive: true });
    await writeFile(file, text);
  },
  turns: turnGate,
  now: () => Date.now(),
});

/**
 * A card's Send or Post (send.ts): the words go where the card's draft says,
 * through the person's own Slack connector or `gh`, from their Home space.
 */
export const sender = createSender({
  card: async (situationId) => {
    const feed = await feedRelay.getFeed();
    if (!feed.success) return err({ message: feed.error.message });
    const item = [...feed.data.visible, ...feed.data.queued].find((x) => x.situationId === situationId);
    return ok(item?.card ?? null);
  },
  gh: runGhWrite,
  acp,
  cwd: async () => {
    const home = await homeSpace.ensure();
    if (home.success) return home.data.root;
    const dir = join(app.getPath('userData'), 'rig-send');
    await mkdir(dir, { recursive: true });
    return dir;
  },
  newConversationId: () => `send-${randomUUID()}`,
  answered: (situationId, choice) => orchActions.act({ refs: [situationId], action: 'done', args: { choice, reason: choice }, actor: 'person' }),
  turns: turnGate,
  log,
});

// An account with no Home space yet gets one, once, a little after start (the first run makes it after Set up).
setTimeout(() => {
  void resolveSelfUserId().then((me) => {
    if (me.success && !rigSettingsStore.get().homeSpaceId) void homeSpace.ensure();
  });
}, 30_000).unref?.();

/**
 * Dev only: with RIG_ORCH_RECORD=<file>, every run's progress goes to that
 * file, one JSON event per line, to make the Read step's replay fixture from
 * a real run (renderer/features/first-run/read/fixtures). Scrub it before
 * committing: it holds the person's own channel names and outcome lines.
 */
const recordFile = process.env.RIG_ORCH_RECORD && !app.isPackaged ? process.env.RIG_ORCH_RECORD : null;
function recordProgress(event: OrchProgressEvent): void {
  if (!recordFile) return;
  void appendFile(recordFile, `${JSON.stringify(event)}\n`).catch(() => undefined);
}

/** A relay or account error as a run failure, with its fix: sign in again, or retry when the relay is back. */
function relayFail(error: RigAccountError | { kind: string; message: string; status?: number }): RunFail {
  const problem: RunProblem | undefined =
    error.kind === 'invalidToken' || error.kind === 'notSignedIn'
      ? 'rig_signed_out'
      : error.kind === 'relay' && error.status === undefined
        ? 'relay_unreachable'
        : undefined;
  return problem ? { message: error.message, problem } : { message: error.message };
}

/** The situations with a card on the Feed now (visible or queued). */
async function feedRefs(): Promise<string[]> {
  const feed = await feedRelay.getFeed();
  return feed.success ? [...feed.data.visible, ...feed.data.queued].map((x) => x.situationId) : [];
}

/** Where a first run for someone Rig has read for before catches up from: their last read. Null for someone new. */
async function catchUpSince(): Promise<string | null> {
  const state = await feedRelay.orchAgentState();
  return state.success ? readWindow(state.data, Date.now()).since : null;
}

/**
 * The background orchestrator (agent.ts): it decides the Feed. It reads a
 * minute after the app starts, then every hour, and when you ask; and it
 * catches up (catch-up.ts) when the app opens or the Mac wakes after hours away.
 */
export const orchestrator = createOrchestrator({
  acp,
  rigTools: async (scope) => (await import('../spaces/rig-tools-instance')).rigToolsServer.serverFor(scope),
  whoami: async () => {
    const id = await resolveSelfUserId();
    return id.success ? ok({ id: id.data }) : err(relayFail(id.error));
  },
  cwd: async () => {
    const dir = join(app.getPath('userData'), 'rig-orchestrator');
    await mkdir(dir, { recursive: true });
    return dir;
  },
  newConversationId: () => `orchestrator-${randomUUID()}`,
  state: async () => {
    const r = await feedRelay.orchAgentState();
    return r.success ? r : err(relayFail(r.error));
  },
  feedRefs,
  sources: async () => (await readSources()).filter((x) => !x.paused).map((x) => ({ connector: x.connector, what: x.what })),
  recordRun: (id, trigger, note, pass) => feedRelay.orchRun(id, trigger, note, pass),
  snapshot: () => readSnapshot((kind, opts) => feedRelay.orchQuery(kind, opts), runGhRead),
  onProgress: (event) => {
    events.emit(rigOrchProgressChannel, event);
    recordProgress(event);
    catchUp.record(event);
    if (event.kind === 'end' && event.problem) log.warn('Rig orchestrator: run stopped', { problem: event.problem });
  },
  now: () => Date.now(),
  log,
});
const runAgent = (trigger: string) =>
  void orchestrator.run(trigger).then((r) => {
    if (!r.success) log.warn('Rig orchestrator: run failed', { trigger, error: r.error });
    else changed();
  });

/** The morning catch-up (catch-up.ts): a short run Home shows, when Rig last read hours ago. */
const catchUp = createCatchUp({
  state: async () => {
    const r = await feedRelay.orchAgentState();
    return r.success ? r : err({ message: r.error.message });
  },
  firstRunDone: () => rigSettingsStore.get().firstRunSeen >= FIRST_RUN_VERSION,
  running: () => orchestrator.running(),
  run: (trigger, opts) =>
    orchestrator.run(trigger, opts).then((r) => {
      if (r.success) changed();
      else log.warn('Rig catch-up: failed', { error: r.error });
      return r;
    }),
  now: () => Date.now(),
  log,
});

// On open: a catch-up if Rig last read hours ago, else the usual quiet run a minute in. Then every hour.
setTimeout(() => {
  void catchUp.maybe('app start').then((r) => {
    if (r !== 'started') setTimeout(() => runAgent('app start'), 50_000).unref?.();
  });
}, 10_000).unref?.();
setInterval(() => runAgent('schedule'), 60 * 60_000).unref?.();
// Back from sleep: the hours away are the ones to catch up on.
app.whenReady().then(() => {
  const woke = () => void catchUp.maybe('wake');
  powerMonitor.on('resume', woke);
  powerMonitor.on('unlock-screen', woke);
}, () => undefined);

/**
 * `rpc.rig.orch`: the person's own clicks. A start from the renderer is the
 * person's own action, so it gets a fresh turn id here.
 */
export const rigOrchController = createRPCController({
  query: (input: { kind: string; filter?: Record<string, unknown>; since?: string; limit?: number }) => orchActions.query(input),
  get: (input: { ref: string }) => orchActions.get(input.ref),
  act: (input: { refs: string[]; action: string; args?: Record<string, unknown> }) => orchActions.act({ ...input, actor: 'person' }),
  start: (input: Omit<StartInput, 'userTurnId'>) => orchActions.start({ ...input, userTurnId: turnGate.issue('click') }),
  /**
   * The first run (onboarding's Read step): starts it and answers at once;
   * its progress comes on `rigOrchProgressChannel`, ending with `end`.
   */
  firstRun: async () => {
    // Someone Rig has read for before is caught up since their last read, not read the last 3 days again.
    const since = await catchUpSince();
    // One first run at a time: asking again (a Read step mounted twice) joins it, with its events so far.
    const first = orchestrator.startFirst(since ? { ...FIRST_RUN, since } : FIRST_RUN);
    if (!first.joined) {
      void first.done.then((r) => {
        if (!r.success) log.warn('Rig orchestrator: first run failed', { error: r.error });
        else changed();
      });
    }
    return ok({ started: true, joined: first.joined, events: first.events });
  },
  /** Where a catch-up would read from (the last read), or null for someone Rig hasn't read for yet. */
  since: async () => ok({ since: await catchUpSince() }),
  /** The morning catch-up going now, or just ended, with its events so far (Home's strip); null when there's none. */
  catchUp: async () => ok(catchUp.status()),
  /** The catch-up again, now (its Try again after it stopped). */
  catchUpNow: async () => ok({ outcome: await catchUp.maybe('asked', true) }),
  /** The person's Home space, made if there's none yet: the first run asks once Set up is done. */
  ensureHome: async () => {
    const home = await homeSpace.ensure();
    return home.success ? ok(home.data) : err({ message: home.error });
  },
  /** A background orchestrator run now (agent.ts). */
  runNow: async () => {
    const r = await orchestrator.run('asked');
    if (r.success) changed();
    return r.success ? ok(r.data) : err({ message: r.error });
  },
  /** A space session started for a situation, linked to it (start-in-space.ts, when a follow-up couldn't continue). */
  linkSession: (input: { sessionId: string; situationId: string; bindingId: string }) =>
    feedRelay.linkSession(input.sessionId, input.situationId, input.bindingId),
  /** Whether the background orchestrator is running right now. */
  agentStatus: async () => ok({ running: orchestrator.running() }),
  addSource: async (input: { connector: string; what: string; everyMin?: number }) => {
    const list = await readSources();
    const ref = `src_${input.connector.toLowerCase().replace(/[^a-z0-9]+/g, '-')}${list.some((x) => x.ref.startsWith(`src_${input.connector.toLowerCase()}`)) ? `-${list.length + 1}` : ''}`;
    const source: Source = { ref, connector: input.connector, what: input.what, everyMin: input.everyMin ?? 30, paused: false, cursor: null, lastRun: null, lastStatus: null, lastCount: 0 };
    await writeSources([...list, source]);
    return ok(source);
  },
  /** What Rig watches for the person (Connect's switches read and write these). */
  sources: async () => ok(await readSources()),
  /** Stops or resumes watching one source; a paused one leaves the packet. */
  pauseSource: async (input: { ref: string; paused: boolean }) => {
    const source = await updateSource(input.ref, { paused: input.paused });
    return source ? ok(source) : err({ message: `No source ${input.ref}.` });
  },
});
