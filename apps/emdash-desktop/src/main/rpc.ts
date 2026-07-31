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
import { rigCommentAgentController } from './rig/comment-agent';
import { rigCommentsController } from './rig/comments';

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
    // `askAgent` sits alongside the relay reads/writes it builds on, so the
    // renderer sees one comments surface rather than two.
    comments: { ...rigCommentsController, ...rigCommentAgentController },
    // Account sign-in is its own surface: it drives the `rig` CLI rather than
    // the relay, and everything else rig-related depends on it having run.
    auth: rigAuthController,
    // Account-scoped relay reads (who's signed in, which workspaces they're
    // on) — no workspace involved, unlike `comments`, so it's its own key
    // rather than folded into that surface.
    account: rigAccountController,
  }),
  workspace: createRPCNamespace({
    gitWorktree: gitWorktreeController,
    files: workspaceFileSystemController,
    fileTree: fileTreeController,
    editor: editorBufferController,
  }),
});

export type RpcRouter = typeof rpcRouter;
