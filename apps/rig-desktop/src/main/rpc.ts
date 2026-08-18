import { createRPCNamespace, createRPCRouter } from '../shared/lib/ipc/rpc';
import { agentsController } from './core/agents/controller';
import { appController } from './core/app/controller';
import { automationsController } from './core/automations/controller';
import { browserController } from './core/browser/controller';
import { conversationController } from './core/conversations/controller';
import { editorBufferController } from './core/editor/controller';
import { machineFilesController } from './core/files/controller';
import { workspaceFileSystemController } from './core/files/file-system/controller';
import { fileTreeController } from './core/files/file-tree/controller';
import { gitRepositoryController } from './core/git/repository/controller';
import { gitWorktreeController } from './core/git/worktree/controller';
import { githubController } from './core/github/controller';
import { integrationsController } from './core/integrations/controller';
import { issueController } from './core/issues/controller';
import { mcpController } from './core/mcp/controller';
import { previewServersController } from './core/preview-servers/controller';
import { projectSetupController } from './core/project-setup/controller';
import { projectController } from './core/projects/controller';
import { promptLibraryController } from './core/prompt-library/controller';
import { ptyController } from './core/pty/controller';
import { pullRequestController } from './core/pull-requests/controller';
import { resourceMonitorController } from './core/resource-monitor/controller';
import { searchController } from './core/search/controller';
import { appSettingsController } from './core/settings/controller';
import { providerSettingsController } from './core/settings/provider-settings-controller';
import { skillsController } from './core/skills/controller';
import { sshController } from './core/ssh/controller';
import { storageController } from './core/storage/controller';
import { taskController } from './core/tasks/controller';
import { telemetryController } from './core/telemetry/controller';
import { terminalsController } from './core/terminals/controller';
import { updateController } from './core/updates/controller';
import { viewStateController } from './core/view-state/controller';
import { projectSettingsController } from './core/workspaces/project-settings-controller';
import { legacyPortController } from './db/legacy-port/controller';
import { rigAccountController } from './rig/account';
import { rigAuthController } from './rig/auth';
import { rigBundledCliController } from './rig/bundled-cli';
import { rigCommentAgentController } from './rig/comment-agent';
import { rigCommentsController } from './rig/comments';
import { rigCommentsCacheController } from './rig/comments-cache-store';
import { rigCreateController } from './rig/create';
import { rigFilesController } from './rig/files';
import { rigImportController } from './rig/import-doc';
import { rigJoinController } from './rig/join';
import { rigPulseController } from './rig/pulse';
import { rigRecentController } from './rig/recent-rigs';
import { rigSessionsController } from './rig/sessions';
import { rigSettingsController } from './rig/settings-instance';
import { rigShareController } from './rig/rig-share';
import { rigShareLinksController } from './rig/share-links';
import { rigWorkspaceController } from './rig/workspace';

export const rpcRouter = createRPCRouter({
  agents: agentsController,
  legacyPort: legacyPortController,
  app: appController,
  automations: automationsController,
  appSettings: appSettingsController,
  providerSettings: providerSettingsController,
  browser: browserController,
  gitRepository: gitRepositoryController,
  update: updateController,
  pty: ptyController,
  resourceMonitor: resourceMonitorController,
  files: machineFilesController,
  github: githubController,
  integrations: integrationsController,
  issues: issueController,
  promptLibrary: promptLibraryController,
  skills: skillsController,
  ssh: sshController,
  storage: storageController,
  projectSetup: projectSetupController,
  projects: projectController,
  previewServers: previewServersController,
  tasks: taskController,
  conversations: conversationController,
  terminals: terminalsController,
  mcp: mcpController,
  telemetry: telemetryController,
  pullRequests: pullRequestController,
  viewState: viewStateController,
  search: searchController,
  projectSettings: projectSettingsController,
  rig: createRPCNamespace({
    // `askAgent` and the `rig_comments_cache` reads/writes sit alongside the
    // relay reads/writes they build on, so the renderer sees one comments
    // surface rather than three.
    comments: { ...rigCommentsController, ...rigCommentAgentController, ...rigCommentsCacheController },
    // Account sign-in is its own surface: it drives the `rig` CLI rather than
    // the relay, and everything else rig-related depends on it having run.
    auth: rigAuthController,
    // Account-scoped relay reads (who's signed in, which workspaces they're
    // on) — no workspace involved, unlike `comments`, so it's its own key
    // rather than folded into that surface.
    account: rigAccountController,
    // Local, offline binding detection for the "Open Folder…" flow — is the
    // picked directory (or an ancestor) a bound rig, and if so, its name.
    // Also where a successful open is recorded (see `recentRigs` below).
    workspace: rigWorkspaceController,
    // Read side of the same `rig_rigs` table `workspace.detect` writes to —
    // its own key rather than folded into `workspace` since it's a plain
    // list read, not part of the detect/bind flow itself.
    recent: rigRecentController,
    // Real filesystem access (list/read/write/watch) scoped to a bound rig's
    // own folder — see `shared/rig/files.ts` for why this doesn't reuse the
    // emdash project/workspace-registry `workspace.files` surface below.
    files: rigFilesController,
    // Main-owned app preferences (`userData/settings.json`) — see
    // `persistence-design.md`'s "Preferences" layer. Deliberately separate
    // from the `appSettings` surface above, which is Emdash's inherited
    // SQLite-backed store.
    settings: rigSettingsController,
    // `rig_sessions`/`rig_session_events` — the writer lives in the
    // renderer (transcript events never reach main over the wire), so this
    // is main answering batched appends, not observing anything live.
    sessions: rigSessionsController,
    // Public share links (mint/list/revoke) for the currently-open file —
    // its own key rather than folded into `comments` (own resource, own
    // error shape: 403 for a viewer-only member, 404 for an untracked
    // path) even though it resolves bindingId/relPath the same way
    // (`resolveCommentTarget`, reused from `./comments`) — see
    // `share-links.ts`'s own header comment.
    shareLinks: rigShareLinksController,
    // Rig-level sharing (the file browser header's Share button): members +
    // outgoing invites, keyed by workspace ROOT rather than a file path —
    // membership is a rig-level fact. Different resource plane than
    // `shareLinks` (people on the rig, not public links to one file) — see
    // `rig-share.ts`'s own header comment.
    share: rigShareController,
    // Self-service local setup for a relay-only binding the caller is a
    // member of (round H2's Home "Set up locally", generalized to every
    // role by `rig attach`) — its own key: a one-shot action driving the
    // bundled CLI, not a data surface like everything else in this
    // namespace. See `join.ts`'s own header comment.
    join: rigJoinController,
    // Home's "New rig" dialog — drives the bundled CLI headlessly
    // (`rig init --json`, then `rig sync --json` when the toggle is on).
    // Its own key, like `join` above: a one-shot creation action, not a
    // data surface. See `create.ts`'s own header comment.
    create: rigCreateController,
    // Google Docs / .docx → markdown import into a bound rig (the create
    // dialog's "Start from a Google Doc" section and the open-rig Import
    // action). One-shot action like `create` above — see `import-doc.ts`'s
    // own header comment for the pipeline and its honest error taxonomy.
    importDoc: rigImportController,
    // Round H3 — the relay's read-plane intelligence (semantic cross-fabric
    // briefing + grounded Q&A), the same feed the web home is built on. Its
    // own key: account-scoped like `account` above, but a genuinely
    // different relay resource (`/v1/me/pulse`, `/v1/me/ask`) with its own
    // (much longer) timeouts — see `pulse.ts`'s own header comment.
    pulse: rigPulseController,
    // Settings → About's rig/tapd version rows — package.json reads only,
    // see `bundled-cli.ts`'s own header comment for why this never spawns
    // either binary.
    bundledCli: rigBundledCliController,
  }),
  workspace: createRPCNamespace({
    gitWorktree: gitWorktreeController,
    files: workspaceFileSystemController,
    fileTree: fileTreeController,
    editor: editorBufferController,
  }),
});

export type RpcRouter = typeof rpcRouter;
