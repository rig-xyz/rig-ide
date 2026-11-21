import { createHash } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { lstat, readdir, readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { app } from 'electron';
import { getAcpRuntimeClient } from '@main/core/acp/controller';
import { localDependencyManager } from '@main/core/dependencies/dependency-managers';
import { events } from '@main/lib/events';
import { log } from '@main/lib/logger';
import { createRPCController } from '@shared/lib/ipc/rpc';
import { isError, resolveContext, rigAccountController } from '../account';
import { reportAgentRunFailure } from '../agent-run-failure-instance';
import { clearAgentSignInNeeded, noteAgentRunFailedForSignIn } from '../agent-sign-in-needed';
import { findBindingConfig } from '../binding';
import { watchAcpSessions } from '../session-registry';
import { createOwnChatWrites } from '../views/own-chat-writes';
import { resolveLocalPathsImpl } from '../recent-rigs';
import { activeMac } from '../active-mac-instance';
import { runRig } from '../create';
import {
  createGardener,
  cutFacts,
  GARDENER_SILENT_REPLY,
  GARDENER_TICK_MS,
  GARDENER_PROMPT,
  spaceFingerprint,
} from '../gardener/gardener';
import { createFileGardenerStore } from '../gardener/gardener-store';
import { createFileViewPassStore } from '../views/view-pass-store';
import { rigSettingsStore } from '../settings-instance';
import { thisMacId, thisMacName } from '../this-mac';
import { codexProjectServersFor, connections, globalSetupFor, projectServersFor } from '../connectors/connections-instance';
import { sessionConnectorsFor } from '../connectors/global-setup';
import { withCodexProjectServers } from '../connectors/project-servers';
import {
  checkViewAct,
  isViewName,
  parseViewSchedule,
  viewActPrompt,
  viewDataPath,
  viewMetaPath,
  viewMetasWrittenBy,
  viewScheduleSignature,
  viewRefreshPrompt,
  VIEWS_DIR,
  viewTurnContext,
} from '@shared/rig/views';
import { isConnectorId, RIG_TOOLS_SERVER } from '@shared/spaces/connectors';
import {
  DETAILS_HIDDEN_EVENT,
  roomSeesFor,
  spacesLocalRunEventChannel,
  type LocalRunEvent,
} from '@shared/spaces/room-sees';
import { err, ok, type Result } from '@emdash/shared';
import {
  type AgentConfig,
  type AgentConfigChange,
  createDeviceIdResolver,
  createRuntimeAcpSessions,
  createSpacesDispatcher,
  roomContextLines,
  type SpaceSessionStatus,
} from './dispatch';
import { SpacesDispatchController, type SpacesDispatchControllerDeps } from './dispatch-controller';
import { createImagePreparer } from './agent-images';
import { createAgentsReporter } from './agents-reporter';
import { LocalRunStore } from './local-runs';
import { createHttpSpacesRelayApi, otherMacsAgents, type SessionAgent } from './relay-api';
import { RequestClaimPoller, unrunnableRequestLine } from './request-claim';
import { rigToolsServer } from './rig-tools-instance';
import { spaceState } from '../space-state/space-state-instance';
import type { SpaceState } from '@shared/rig/space-state';
import { createFileViewConsentStore, createOwnViewWrites } from '../views/view-consent-store';
import { createViewActLimit, createViewRefresher, VIEW_REFRESH_TICK_MS } from '../views/view-refresh';
import { readAgentSessionSize } from './session-size';
import { spaceSessionStore } from './session-store-instance';

/**
 * Boot-only wiring for `SpacesDispatchController` — real settings store,
 * real ACP runtime client, real relay API. Deliberately kept out of
 * `dispatch-controller.ts` itself: several of these (the ACP runtime
 * client, `resolveLocalPathsImpl`'s DB read, the settings store singleton)
 * touch Electron's `app`/the SQLite DB at module load time, which only
 * works inside the real app — importing any of them from a Vitest `node`
 * project test fails before a single test even runs (the same pre-existing
 * gap `context.test.ts`/`comments.smoke.test.ts`/etc. hit). This file is
 * the one place that eagerly pays that cost, and nothing under test may
 * import it.
 */
/**
 * The owner overlay (`local-runs.ts`): this computer's full copy of the runs
 * it runs, pushed to its own windows as each event lands so the Room shows
 * your own runs from it rather than from the relay's filtered copy.
 */
const localRuns = new LocalRunStore();
localRuns.subscribe((bindingId, runId, event) => events.emit(spacesLocalRunEventChannel, { bindingId, runId, event }));

/**
 * With the app run as RIG_CLAUDE_DEBUG=1, each Claude space session writes
 * Claude Code's debug log (tool search, MCP, API calls) to
 * <logs>/claude-debug/<conversation id>.log. Off otherwise.
 */
function claudeDebugFile(conversationId: string): string | undefined {
  if (process.env.RIG_CLAUDE_DEBUG !== '1') return undefined;
  const dir = join(app.getPath('logs'), 'claude-debug');
  try {
    mkdirSync(dir, { recursive: true });
  } catch (error) {
    log.warn('Rig spaces: could not create the Claude debug log folder', { error: String(error) });
    return undefined;
  }
  const file = join(dir, `${conversationId}.log`);
  log.info('Rig spaces: Claude debug log for this space session', { conversationId, file });
  return file;
}

function realDeps(): SpacesDispatchControllerDeps {
  return {
    isEnabled: () => rigSettingsStore.get().spacesEnabled,
    subscribeEnabled: (cb) => rigSettingsStore.subscribe(cb),
    isSignedIn: async () => !isError(await resolveContext()),
    startPoller: async () => {
      const api = createHttpSpacesRelayApi();
      const dispatcher = createSpacesDispatcher({
        api,
        acp: createRuntimeAcpSessions(getAcpRuntimeClient, { claudeDebugFile }),
        sessionSize: readAgentSessionSize,
        resolveWorkspace: async (bindingId) =>
          (await resolveLocalPathsImpl([bindingId]))[bindingId] ?? null,
        store: spaceSessionStore(),
        connectors: async (bindingId, agent) => {
          const spaceConnectors = async () => {
            const listed = await api.listConnectors?.(bindingId);
            if (!listed?.success) {
              // An older relay without the route, or a hiccup: the session runs without connectors.
              if (listed) log.warn('Rig spaces: could not load the space connectors', { bindingId, error: listed.error.message });
              return { servers: [], gaps: [] };
            }
            const ids = listed.data.map((c) => c.connectorId).filter(isConnectorId);
            // A tool this agent already has from its own setup is used that way: never a gap, never injected twice.
            return sessionConnectorsFor(ids, agent, {
              forSession: (rest) => connections.forSession(rest),
              globalSetup: () => globalSetupFor(bindingId),
            });
          };
          if (agent === 'codex') {
            // Codex doesn't read the folder's .mcp.json: the servers you allowed there
            // (remote and local) go in its session beside rig's, unless it already has them.
            const rigSide = await spaceConnectors();
            const codex = await codexProjectServersFor(bindingId, [
              ...rigSide.servers.map((s) => ({ name: s.name, url: 'url' in s ? s.url : null })),
              { name: RIG_TOOLS_SERVER, url: null },
            ]);
            return withCodexProjectServers(rigSide, codex);
          }
          // Claude also loads the folder's own .mcp.json: hold back the copies of
          // servers it already has, and the ones you haven't allowed.
          const [rigSide, project] = await Promise.all([
            spaceConnectors(),
            projectServersFor(bindingId),
          ]);
          if (!project || project.disabled.length === 0) return rigSide;
          return { ...rigSide, project: { disabled: project.disabled, pending: project.pending.map((p) => p.name) } };
        },
        rigTools: (scope) => rigToolsServer.serverFor(scope),
        feed: () => rigSettingsStore.get().alphaEnabled,
        roomSees: (bindingId) => roomSeesFor(rigSettingsStore.get().spacesRoomSees, bindingId, rigSettingsStore.get().spacesRoomSeesDefault),
        recordLocal: (bindingId, runId, event) => {
          localRuns.append(bindingId, runId, event);
          // A `view.json` this Mac's own session writes carries a schedule its person agreed to.
          if (event.kind === 'tool_call' || event.kind === 'tool_call_update') {
            for (const { view, schedule } of viewMetasWrittenBy(event.payload)) {
              ownViewWrites.mark(bindingId, view, schedule ? viewScheduleSignature(schedule) : null);
            }
          }
          // From here, not `localRuns.subscribe`: that one stops after a run overflows its budget.
          if (rigSettingsStore.get().alphaEnabled) spaceState.runEvent(bindingId, runId, event);
        },
        onRunStarted: (run) => {
          if (rigSettingsStore.get().alphaEnabled) spaceState.runStarted(run);
        },
        // Attached images go in as image content, shrunk to fit when they must.
        prepareImage: createImagePreparer(join(app.getPath('temp'), 'rig-agent-images')),
        codexVersion: () => localDependencyManager.get('codex')?.version ?? null,
        onRunFailed: (failure) => {
          reportAgentRunFailure(failure);
          noteAgentRunFailedForSignIn(failure);
        },
        onRunSucceeded: (agent) => clearAgentSignInNeeded(agent),
        defaultConfig: (agent) => {
          const settings = rigSettingsStore.get();
          const model = settings.lastModelByHarness[agent];
          const effort = settings.lastEffortByHarness[agent];
          // No mode picked yet: Claude starts in its auto mode, where it carries on with what is
          // safe and stops for what is not, as Claude's own apps do. (Where the model has no
          // auto mode, Claude's adapter falls back by itself.) Codex keeps its own default.
          const mode = settings.lastModeByHarness[agent] ?? (agent === 'claude' ? ROOM_DEFAULT_MODE : undefined);
          return { ...(model ? { model } : {}), ...(effort ? { effort } : {}), ...(mode ? { mode } : {}) };
        },
      });
      const folderOf = async (bindingId: string) => (await resolveLocalPathsImpl([bindingId]))[bindingId] ?? null;
      const poller = new RequestClaimPoller({
        api,
        deviceId: createDeviceIdResolver(api, {
          localDeviceId: async (bindingId) => {
            const folder = await folderOf(bindingId);
            const binding = folder ? findBindingConfig(folder) : null;
            return binding?.config.bindingId === bindingId ? binding.config.deviceId : null;
          },
          label: thisMacName,
        }),
        dispatch: dispatcher.dispatch,
        // Leave a request for your other Mac when this one lacks the space or the agent.
        canRun: async (request) =>
          rigSettingsStore.get().lastKnownRunnableAgents.includes(request.targetAgent) &&
          (await folderOf(request.bindingId)) !== null,
        // A request for an agent this Mac doesn't have, that no other Mac of
        // yours reports and none took: fail it in plain words. When the relay
        // can't say what your other Macs have, it stays queued for them.
        giveUp: async (request) => {
          const line = unrunnableRequestLine(request, rigSettingsStore.get().lastKnownRunnableAgents, Date.now());
          if (!line) return null;
          const elsewhere = await otherMacsAgentsNow();
          return elsewhere && !elsewhere.includes(request.targetAgent) ? line : null;
        },
        // The Mac you're at gets the first go (the relay holds the others back for a moment).
        computer: thisMacId(),
      });
      poller.start();
      void dispatcher.settleInterrupted();
      return { poller, dispatcher };
    },
    setInterval: (cb, ms) => setInterval(cb, ms),
    clearInterval: (handle) => clearInterval(handle as NodeJS.Timeout),
  };
}

const relayApi = createHttpSpacesRelayApi();

/** The agents your other Macs report, or null when the relay can't say (an error, or no route). */
async function otherMacsAgentsNow(): Promise<SessionAgent[] | null> {
  const report = await relayApi.getMyAgents?.().catch(() => null);
  if (!report?.success || !report.data) return null;
  return otherMacsAgents(report.data, thisMacId());
}

export const spacesDispatchController = new SpacesDispatchController(realDeps());

/** The permission mode a person's Claude starts a space session in until they pick one themselves. */
export const ROOM_DEFAULT_MODE = 'auto';

/** How often running turns are checked for a long silence (`reportStalled`). */
const STALL_CHECK_MS = 30_000;

/** Ends runs that went quiet as failed, with a Retry in a new conversation (`agent_run_failed` with reason `stalled`). */
export function wireStalledRunCheck(): void {
  setInterval(() => spacesDispatchController.reportStalledRuns(), STALL_CHECK_MS).unref?.();
}

/** How often a sign-in or account switch is noticed for the agents report (there's no event for it). */
const AGENTS_REPORT_RECHECK_MS = 60_000;

/**
 * Keeps the relay told which agents you can run (`agents-reporter.ts`):
 * once at launch, again whenever settings change (the runnable set is
 * persisted there each time a probe changes it) and on a slow interval.
 */
export function wireAgentsReporter(): void {
  const reporter = createAgentsReporter({
    isEnabled: () => rigSettingsStore.get().spacesEnabled,
    account: async () => {
      const ctx = await resolveContext();
      // A hash, so the token itself is never kept around for this.
      return isError(ctx) ? null : createHash('sha256').update(`${ctx.url}\n${ctx.token}`).digest('hex');
    },
    runnable: () => rigSettingsStore.get().lastKnownRunnableAgents,
    device: thisMacId,
    put: (agents, device) => relayApi.setMyAgents!(agents, device),
    setTimeout: (cb, ms) => setTimeout(cb, ms),
    clearTimeout: (handle) => clearTimeout(handle as NodeJS.Timeout),
  });
  rigSettingsStore.subscribe(() => reporter.nudge());
  setInterval(() => reporter.nudge(), AGENTS_REPORT_RECHECK_MS);
  reporter.nudge();
}

/**
 * Doc comments in a space go to your room agent: the same persistent session
 * `@claude` reaches in the Room. Returns null when this isn't a space (or
 * Spaces is off), so the caller keeps the standalone comment agent.
 */
/** Answers an approval on a room-agent turn from the doc margin (same path as the Room card). */
export async function resolveRoomTurnPermission(runId: string, requestId: string, optionId: string): Promise<boolean> {
  return spacesDispatchController.resolvePermission(runId, requestId, optionId);
}

export async function runCommentTurnInRoom(spec: {
  bindingId: string;
  agent: 'claude' | 'codex';
  prompt: string;
  hiddenContext: string;
  /** The doc comment thread being answered. */
  threadId?: string;
  onPermissionsChanged?: Parameters<SpacesDispatchController['runLocal']>[0]['onPermissionsChanged'];
}): Promise<Awaited<ReturnType<SpacesDispatchController['runLocal']>> | null> {
  if (!spacesDispatchController.isRunning()) {
    log.info('Rig spaces: doc mention goes to the standalone agent (Spaces not running)');
    return null;
  }
  log.info('Rig spaces: doc mention — checking whether this is a space', { bindingId: spec.bindingId });
  const workspaces = await rigAccountController.workspaces();
  const isSpace =
    workspaces.success && workspaces.data.some((b) => b.id === spec.bindingId && b.kind === 'space');
  log.info('Rig spaces: doc mention — space check done', { isSpace, ok: workspaces.success });
  if (!isSpace) return null;
  const me = await relayApi.whoami();
  if (!me.success) {
    log.warn('Rig spaces: doc mention could not identify you; using the standalone agent', { error: me.error.message });
    return null;
  }
  log.info('Rig spaces: doc mention goes to your room agent', { bindingId: spec.bindingId });
  return spacesDispatchController.runLocal({
    bindingId: spec.bindingId,
    ownerUserId: me.data.id,
    agent: spec.agent,
    prompt: spec.prompt,
    extraHiddenContext: spec.hiddenContext,
    threadId: spec.threadId,
    onPermissionsChanged: spec.onPermissionsChanged,
  });
}

const viewActLimit = createViewActLimit();
/** Turns views started that are still going, so the view can be told when its turn is over. */
const viewTurns = new Map<string, Promise<{ status: string }>>();

/**
 * A choice made in a Rig view (spike, Rig Alpha only): a turn in the viewing member's own session in
 * that space. The renderer's host already checked the message; it is checked again here, and the
 * person is whoever is signed in on this Mac, never something the page or the renderer said.
 */
async function runViewAct(spec: {
  bindingId: string;
  view: string;
  intent: string;
  payload: Record<string, string>;
  /** The words on what was pressed, and the title of the item it was pressed on, as the view shows them. */
  label?: string;
  item?: string;
}): Promise<Result<{ runId: string | null }, string>> {
  if (!rigSettingsStore.get().alphaEnabled) return err('Views are part of Rig Alpha.');
  if (!isViewName(spec.view)) return err('Not a view.');
  const bad = checkViewAct(spec);
  if (bad) return err(`That action was refused (${bad}).`);
  if (!spacesDispatchController.isRunning()) return err('Spaces is not running.');
  const workspaces = await rigAccountController.workspaces();
  if (!workspaces.success || !workspaces.data.some((b) => b.id === spec.bindingId && b.kind === 'space')) {
    return err('This is not a space.');
  }
  const me = await rigAccountController.me();
  if (!me.success) return err(me.error.message);
  const refused = viewActLimit.refuse(spec, Date.now());
  // The same choice, sent again: it is already on its way. No turn, and nothing to report.
  if (refused === 'repeat') return ok({ runId: null });
  if (refused === 'flood') return err('This view has sent a lot in the last minute. Try again shortly.');
  const prompt = viewActPrompt({
    view: spec.view,
    person: me.data.name ?? me.data.email ?? 'a member',
    intent: spec.intent,
    payload: spec.payload,
  });
  log.info('Rig views: action goes to your session', { bindingId: spec.bindingId, view: spec.view, intent: spec.intent });
  const started = await spacesDispatchController.runLocal({
    bindingId: spec.bindingId,
    ownerUserId: me.data.id,
    agent: 'claude',
    prompt,
    extraHiddenContext: viewTurnContext(spec.view),
    view: spec.view,
    startedBy: 'view',
    // For the line above the run's card in the Room; `parseRunTrigger` cuts each to one short line.
    pressed: { label: spec.label, item: spec.item, note: spec.payload.note },
  });
  if (!started) return err('Spaces is not running.');
  if (!started.success) return err(started.error);
  const { runId, done } = started.data;
  viewTurns.set(runId, done);
  void done.finally(() => setTimeout(() => viewTurns.delete(runId), 60_000));
  return ok({ runId });
}

/** Resolves when the turn a view action started is over, so the view can stop showing it as sent. */
async function viewActDone({ runId }: { runId: string }): Promise<{ ok: boolean }> {
  const done = viewTurns.get(runId);
  if (!done) return { ok: true };
  const { status } = await done;
  return { ok: status !== 'failed' };
}

/** The views in a space folder, for the refresh timer: each one's `view.json` and its data's age. */
async function readSpaceViews(path: string): Promise<{ name: string; meta: string | null; dataModifiedMs: number | null }[]> {
  let names: string[];
  try {
    names = (await readdir(join(path, VIEWS_DIR), { withFileTypes: true }))
      .filter((entry) => entry.isDirectory() && isViewName(entry.name))
      .map((entry) => entry.name)
      .sort((a, b) => a.localeCompare(b));
  } catch {
    return [];
  }
  return Promise.all(
    names.map(async (name) => ({
      name,
      meta: await readFile(join(path, viewMetaPath(name)), 'utf8').catch(() => null),
      dataModifiedMs: await stat(join(path, viewDataPath(name))).then((info) => info.mtimeMs, () => null),
    }))
  );
}

/** The `view.json` files this Mac's own sessions just wrote (`views/view-consent-store.ts`). */
const ownViewWrites = createOwnViewWrites(() => Date.now());

/** The view clock, kept so the state read can ask it to look at a space (`rigSpaceStateController`). */
let refresher: ReturnType<typeof createViewRefresher> | null = null;

/** Starts the timer that refreshes views whose `view.json` asks for it (`views/view-refresh.ts`). */
export function wireViewRefresh(): void {
  // The person's chat sessions in a space (one Home's chat started, a side chat) report the
  // schedules they write too, so those are agreed to like one a Room run wrote.
  const acpSessions = createRuntimeAcpSessions(getAcpRuntimeClient);
  watchAcpSessions(
    createOwnChatWrites({
      bindingOf: (cwd) => findBindingConfig(cwd)?.config.bindingId ?? null,
      subscribeRaw: (conversationId, on) => acpSessions.subscribeRaw(conversationId, on),
      mark: (bindingId, view, signature) => ownViewWrites.mark(bindingId, view, signature),
    })
  );
  refresher = createViewRefresher({
    enabled: () => rigSettingsStore.get().alphaEnabled && spacesDispatchController.isRunning(),
    me: async () => {
      const me = await relayApi.whoami();
      return me.success ? me.data.id : null;
    },
    spaces: async () => {
      const workspaces = await rigAccountController.workspaces();
      if (!workspaces.success) return [];
      const ids = workspaces.data.filter((b) => b.kind === 'space').map((b) => b.id);
      const paths = await resolveLocalPathsImpl(ids);
      return Object.entries(paths).map(([bindingId, path]) => ({ bindingId, path }));
    },
    views: readSpaceViews,
    busy: (bindingId, userId) => spacesDispatchController.currentRunId(bindingId, userId, 'claude') !== null,
    run: async ({ bindingId, userId, view, prompt, context }) => {
      log.info('Rig views: scheduled refresh', { bindingId, view });
      const started = await spacesDispatchController.runLocal({
        bindingId,
        ownerUserId: userId,
        agent: 'claude',
        prompt,
        extraHiddenContext: context,
        view,
        startedBy: 'clock',
      });
      return !!started && started.success;
    },
    now: () => Date.now(),
    seen: (bindingId, me, views) => spaceState.viewsSeen(bindingId, me, views),
    skipped: (bindingId, view, reason) => spaceState.refreshSkipped(bindingId, view, reason),
    notStarted: (bindingId, view) => spaceState.refreshNotStarted(bindingId, view),
    lastStarted: createFileViewPassStore(join(app.getPath('userData'), 'rig-view-passes.json')),
    consent: createFileViewConsentStore(join(app.getPath('userData'), 'rig-view-consent.json')),
    wroteHere: (bindingId, view, signature) => ownViewWrites.wroteHere(bindingId, view, signature),
  });
  const timer = refresher;
  setInterval(() => void timer.tick().catch((error) => log.warn('Rig views: refresh tick failed', { error: String(error) })), VIEW_REFRESH_TICK_MS).unref?.();
}

const GARDENER_MAX_DEPTH = 8;
const GARDENER_MAX_FILES = 5_000;

/**
 * The files of a space for the gardener's fingerprint. Skips dot names, `node_modules`, links and
 * each page's `data.json` (rewritten by every refresh, so it would always look like a change).
 * Null when the folder cannot be read.
 */
async function listSpaceFiles(root: string): Promise<{ relPath: string; mtimeMs: number }[] | null> {
  const files: { relPath: string; mtimeMs: number }[] = [];
  const walk = async (dir: string, rel: string, depth: number): Promise<boolean> => {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return false;
    }
    for (const entry of entries) {
      if (files.length >= GARDENER_MAX_FILES) return true;
      if (entry.name.startsWith('.') || entry.name === 'node_modules' || entry.isSymbolicLink()) continue;
      const relPath = rel ? `${rel}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        if (depth < GARDENER_MAX_DEPTH) await walk(join(dir, entry.name), relPath, depth + 1);
      } else if (entry.isFile()) {
        if (/^views\/[^/]+\/data\.json$/.test(relPath)) continue;
        const info = await lstat(join(dir, entry.name)).catch(() => null);
        if (info) files.push({ relPath, mtimeMs: info.mtimeMs });
      }
    }
    return true;
  };
  return (await walk(root, '', 0)) ? files : null;
}

/**
 * Starts the gardener (`gardener/gardener.ts`): about once an hour per space, and only when
 * something changed, one quiet turn in the owner's own session that follows the `rig-gardener`
 * skill. Only the owner's app on the Mac they used last runs it.
 */
export function wireGardener(): void {
  const file = createFileGardenerStore(join(app.getPath('userData'), 'rig-gardener.json'));
  // What the record says about the last look also goes to the space's state, for the pill.
  const tell = (id: string, record: { lastStartedMs: number | null; lastFinishedMs: number | null }) =>
    spaceState.checked(id, { lastStartedAt: record.lastStartedMs, lastFinishedAt: record.lastFinishedMs });
  const store: typeof file = {
    get(id) {
      const record = file.get(id);
      if (record) tell(id, record);
      return record;
    },
    set(id, record) {
      file.set(id, record);
      tell(id, record);
    },
  };
  const gardener = createGardener({
    enabled: () => rigSettingsStore.get().alphaEnabled && spacesDispatchController.isRunning(),
    me: async () => {
      const me = await relayApi.whoami();
      return me.success ? me.data.id : null;
    },
    elsewhere: () => activeMac.usingAnotherMac(),
    spaces: async () => {
      const workspaces = await rigAccountController.workspaces();
      if (!workspaces.success) return [];
      const spaces = workspaces.data.filter((b) => b.kind === 'space');
      const paths = await resolveLocalPathsImpl(spaces.map((b) => b.id));
      return spaces.flatMap((b) => (paths[b.id] ? [{ bindingId: b.id, path: paths[b.id]!, name: b.name, role: b.role }] : []));
    },
    busy: (bindingId, userId) => spacesDispatchController.currentRunId(bindingId, userId, 'claude') !== null,
    lastTurnAt: (bindingId, userId) => spaceSessionStore().get(`${bindingId}::${userId}::claude`)?.lastTurnAt ?? null,
    fingerprint: async (path) => {
      const files = await listSpaceFiles(path);
      return files ? spaceFingerprint(files) : null;
    },
    facts: async ({ bindingId, path }) => {
      // Rig runs its own check here so the turn never stops on an approval for a shell command.
      const outcome = await runRig(['doctor', '--json'], path, 20_000).catch(() => null);
      const doctor = outcome?.kind === 'ran' && outcome.stdout.trim() ? cutFacts(outcome.stdout.trim()) : null;
      return { views: cutFacts(JSON.stringify(spaceState.get(bindingId).views)), doctor };
    },
    run: async ({ bindingId, userId, context, mayRename }) => {
      log.info('Rig gardener: looking over a space', { bindingId });
      const started = await spacesDispatchController.runLocal({
        bindingId,
        ownerUserId: userId,
        agent: 'claude',
        prompt: GARDENER_PROMPT,
        extraHiddenContext: context,
        startedBy: 'gardener',
        quietCard: { silentAnswer: GARDENER_SILENT_REPLY },
        renameOnce: mayRename,
      });
      return started && started.success ? { done: started.data.done } : null;
    },
    store,
    now: () => Date.now(),
  });
  setInterval(() => void gardener.tick().catch((error) => log.warn('Rig gardener: tick failed', { error: String(error) })), GARDENER_TICK_MS).unref?.();
}

/**
 * This Mac's own runtime facts about a space's standing work and turns (`space-state/`). Not
 * `spaceStatus`, which is Home's poll of the relay. Looks at the space's views first so the
 * schedule is current even when the clock has not ticked since the view changed.
 */
export const rigSpaceStateController = createRPCController({
  /** Every space's standing work and turns as this Mac knows them, for Home's list of spaces. */
  all: async (): Promise<SpaceState[]> => (rigSettingsStore.get().alphaEnabled ? spaceState.all() : []),
  get: async ({ bindingId }: { bindingId: string }): Promise<SpaceState> => {
    if (!rigSettingsStore.get().alphaEnabled) return { bindingId, at: Date.now(), views: [], runs: [] };
    try {
      const path = (await resolveLocalPathsImpl([bindingId]))[bindingId];
      if (path && refresher) await refresher.look({ bindingId, path });
    } catch {
      // The facts we already have are still true.
    }
    return spaceState.get(bindingId);
  },
});

/**
 * "Run now" on a scheduled view: the same pass its schedule starts, started by the person. It is
 * their own act, so the Room shows it as a press ("Drafts to review · Run now").
 */
async function runViewNow(spec: { bindingId: string; view: string }): Promise<Result<{ runId: string }, string>> {
  if (!rigSettingsStore.get().alphaEnabled) return err('Views are part of Rig Alpha.');
  if (!isViewName(spec.view)) return err('Not a view.');
  if (!spacesDispatchController.isRunning()) return err('Spaces is not running.');
  const me = await rigAccountController.me();
  if (!me.success) return err(me.error.message);
  const path = (await resolveLocalPathsImpl([spec.bindingId]))[spec.bindingId];
  if (!path) return err("This space's folder isn't on this Mac.");
  const view = (await readSpaceViews(path)).find((v) => v.name === spec.view);
  const schedule = view?.meta ? parseViewSchedule(view.meta) : null;
  if (!view || !schedule) return err('That view has no schedule to run.');
  if (spacesDispatchController.currentRunId(spec.bindingId, me.data.id, 'claude') !== null) {
    return err('Your Claude is working on something here. Run it again once that is done.');
  }
  log.info('Rig views: run now', { bindingId: spec.bindingId, view: spec.view });
  const started = await spacesDispatchController.runLocal({
    bindingId: spec.bindingId,
    ownerUserId: me.data.id,
    agent: 'claude',
    prompt: viewRefreshPrompt(spec.view, schedule),
    extraHiddenContext: viewTurnContext(spec.view),
    view: spec.view,
    startedBy: 'view',
    pressed: { label: 'Run now' },
  });
  if (!started) return err('Spaces is not running.');
  if (!started.success) return err(started.error);
  // Running it themselves is the person agreeing to this schedule as it stands.
  refresher?.accept(spec.bindingId, spec.view, schedule);
  // The person's own pass moves the schedule like the clock's would, and is the view's last refresh.
  refresher?.started(spec.bindingId, spec.view);
  spaceState.refreshStarted(spec.bindingId, spec.view, started.data.runId);
  return ok({ runId: started.data.runId });
}

/**
 * The person agrees to a view's schedule that someone else set or changed: from then on it runs in
 * their session like one they set themselves. Only for a schedule that names them.
 */
async function acceptViewSchedule(spec: { bindingId: string; view: string }): Promise<Result<{ accepted: true }, string>> {
  if (!rigSettingsStore.get().alphaEnabled) return err('Views are part of Rig Alpha.');
  if (!isViewName(spec.view)) return err('Not a view.');
  const me = await rigAccountController.me();
  if (!me.success) return err(me.error.message);
  const path = (await resolveLocalPathsImpl([spec.bindingId]))[spec.bindingId];
  if (!path) return err("This space's folder isn't on this Mac.");
  const view = (await readSpaceViews(path)).find((v) => v.name === spec.view);
  const schedule = view?.meta ? parseViewSchedule(view.meta) : null;
  if (!view || !schedule) return err('That view has no schedule to accept.');
  if (schedule.runsAs !== me.data.id) return err('That schedule runs in another member\'s Rig app, not yours.');
  if (!refresher) return err('Spaces is not running.');
  log.info('Rig views: schedule accepted', { bindingId: spec.bindingId, view: spec.view });
  refresher.accept(spec.bindingId, spec.view, schedule);
  await refresher.look({ bindingId: spec.bindingId, path });
  return ok({ accepted: true });
}

/** The renderer-facing half: the Room's session card Stop button and owner approvals. */
export const rigSpacesDispatchController = createRPCController({
  viewAct: runViewAct,
  viewActDone,
  runViewNow,
  acceptViewSchedule,
  stopRun: async ({ runId, bindingId }: { runId: string; bindingId?: string }): Promise<{ stopped: boolean }> => ({
    stopped: await spacesDispatchController.stopRun(runId, bindingId),
  }),
  /** `/new` in the Room: your sessions in this space are set aside, so your next message starts a new conversation. */
  newSession: async ({ bindingId }: { bindingId: string }): Promise<Result<{ count: number }, string>> => {
    const me = await relayApi.whoami();
    if (!me.success) return err(me.error.message);
    return ok({ count: spacesDispatchController.startOver(bindingId, me.data.id) });
  },
  /** The Room's recent conversation as lines for an agent's context: what a side chat starts from. */
  roomContext: async ({ bindingId }: { bindingId: string }): Promise<Result<{ lines: string[] }, string>> => {
    const context = await roomContextLines(relayApi, { bindingId, sourceMessageId: '' }, '', null).catch(
      () => null
    );
    return context ? ok({ lines: context.lines }) : err('The Room could not be read.');
  },
  /** `/stop` in the Room: your agents' turns in this space are stopped; a session that does not answer is set aside. */
  stopAll: async ({ bindingId }: { bindingId: string }): Promise<Result<{ count: number }, string>> => {
    const me = await relayApi.whoami();
    if (!me.success) return err(me.error.message);
    return ok({ count: await spacesDispatchController.stopAll(bindingId, me.data.id) });
  },
  /** `/status` in the Room: your sessions in this space. */
  sessionStatus: async ({ bindingId }: { bindingId: string }): Promise<Result<SpaceSessionStatus[], string>> => {
    const me = await relayApi.whoami();
    if (!me.success) return err(me.error.message);
    return ok(spacesDispatchController.sessionStatus(bindingId, me.data.id));
  },
  /** Your agent's settings in this space; reaches its session, so only call it when a selector opens. */
  agentConfig: async ({
    bindingId,
    agent,
  }: {
    bindingId: string;
    agent: 'claude' | 'codex';
  }): Promise<Result<AgentConfig, string>> => {
    const me = await relayApi.whoami();
    if (!me.success) return err(me.error.message);
    return spacesDispatchController.agentConfig(bindingId, me.data.id, agent);
  },
  setAgentConfig: async ({
    bindingId,
    agent,
    change,
  }: {
    bindingId: string;
    agent: 'claude' | 'codex';
    change: AgentConfigChange;
  }): Promise<Result<AgentConfig, string>> => {
    const me = await relayApi.whoami();
    if (!me.success) return err(me.error.message);
    return spacesDispatchController.setAgentConfig(bindingId, me.data.id, agent, change);
  },
  settleStaleRun: async ({ runId, bindingId }: { runId: string; bindingId: string }): Promise<{ settled: boolean }> => ({
    settled: await spacesDispatchController.settleStaleRun(runId, bindingId),
  }),
  checkNow: async (): Promise<void> => {
    await spacesDispatchController.checkNow();
  },
  /** The agents your other Macs report, so the composer can say where a tagged agent runs; null when unknown. */
  otherMacsAgents: async (): Promise<{ agents: SessionAgent[] } | null> => {
    const agents = await otherMacsAgentsNow();
    return agents ? { agents } : null;
  },
  resolvePermission: async ({
    runId,
    requestId,
    optionId,
  }: {
    runId: string;
    requestId: string;
    optionId: string;
  }): Promise<{ resolved: boolean }> => ({
    resolved: await spacesDispatchController.resolvePermission(runId, requestId, optionId),
  }),
  /** The owner overlay: this computer's own full copy of one of your runs, or null (not run here, or since restarted). */
  localRunEvents: async ({ runId }: { runId: string }): Promise<{ events: LocalRunEvent[] | null }> => ({
    events: localRuns.events(runId),
  }),
  /** "Hide details" on one of your finished runs: the relay keeps only its answer; your own copy just notes it. */
  hideRunDetails: async ({ bindingId, runId }: { bindingId: string; runId: string }): Promise<Result<{ steps: number }, string>> => {
    const result = await relayApi.hideSessionDetails?.(bindingId, runId);
    if (!result) return err("This relay can't hide a run's details.");
    if (!result.success) return err(result.error.message);
    localRuns.note(runId, DETAILS_HIDDEN_EVENT, { steps: result.data.steps });
    return ok(result.data);
  },
});
