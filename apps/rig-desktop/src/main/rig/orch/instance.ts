import { randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { app } from 'electron';
import { err, ok } from '@emdash/shared';
import { getAcpRuntimeClient } from '@main/core/acp/controller';
import { events } from '@main/lib/events';
import { log } from '@main/lib/logger';
import { createRPCController } from '@shared/lib/ipc/rpc';
import { rigFeedChangedChannel, rigStartSessionChannel } from '@shared/rig/feed';
import { rigAccountController } from '../account';
import { globalSetup } from '../connectors/connections-instance';
import * as feedRelay from '../feed/relay';
import { getRecentThemes } from '../recent-themes';
import { resolveLocalPathsImpl } from '../recent-rigs';
import { rigSpaceStatusController } from '../space-status';
import { createRuntimeAcpSessions } from '../spaces/dispatch';
import { spacesDispatchController } from '../spaces/dispatch-controller-instance';
import { createHttpSpacesRelayApi } from '../spaces/relay-api';
import { createActions, type StartInput } from './actions';
import { resolveSelfUserId } from '../account';
import { createOrchestrator } from './agent';
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
  spaces: async () => {
    const ws = await rigAccountController.workspaces();
    if (!ws.success) return ws;
    const spaces = ws.data.filter((b) => b.kind === 'space');
    const roots = await resolveLocalPathsImpl(spaces.map((b) => b.id)).catch(() => ({}) as Record<string, string>);
    return ok(spaces.map((b) => ({ bindingId: b.id, name: b.name, root: roots[b.id] ?? null })));
  },
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
 * The background orchestrator (agent.ts): it decides the Feed. It reads a
 * minute after the app starts, then every hour, and when you ask.
 */
export const orchestrator = createOrchestrator({
  acp,
  rigTools: async (scope) => (await import('../spaces/rig-tools-instance')).rigToolsServer.serverFor(scope),
  whoami: async () => {
    const id = await resolveSelfUserId();
    return id.success ? ok({ id: id.data }) : err({ message: id.error.message });
  },
  cwd: async () => {
    const dir = join(app.getPath('userData'), 'rig-orchestrator');
    await mkdir(dir, { recursive: true });
    return dir;
  },
  newConversationId: () => `orchestrator-${randomUUID()}`,
  state: async () => {
    const r = await feedRelay.orchAgentState();
    return r.success ? r : err({ message: r.error.message });
  },
  sources: async () => (await readSources()).filter((x) => !x.paused).map((x) => ({ connector: x.connector, what: x.what })),
  recordRun: (id, trigger, note) => feedRelay.orchRun(id, trigger, note),
  now: () => Date.now(),
  log,
});
const runAgent = (trigger: string) =>
  void orchestrator.run(trigger).then((r) => {
    if (!r.success) log.warn('Rig orchestrator: run failed', { trigger, error: r.error });
    else changed();
  });
setTimeout(() => runAgent('app start'), 60_000).unref?.();
setInterval(() => runAgent('schedule'), 60 * 60_000).unref?.();

/**
 * `rpc.rig.orch`: the person's own clicks. A start from the renderer is the
 * person's own action, so it gets a fresh turn id here.
 */
export const rigOrchController = createRPCController({
  query: (input: { kind: string; filter?: Record<string, unknown>; since?: string; limit?: number }) => orchActions.query(input),
  get: (input: { ref: string }) => orchActions.get(input.ref),
  act: (input: { refs: string[]; action: string; args?: Record<string, unknown> }) => orchActions.act({ ...input, actor: 'person' }),
  start: (input: Omit<StartInput, 'userTurnId'>) => orchActions.start({ ...input, userTurnId: turnGate.issue('click') }),
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
});
