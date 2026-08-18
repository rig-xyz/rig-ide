import './app/configure-app-identity';
import './core/telemetry/automation-telemetry';
import './core/telemetry/task-telemetry';
import { join } from 'node:path';
import { config as dotenvConfig } from 'dotenv';
import { app, BrowserWindow, dialog, ipcMain } from 'electron';
import devIcon from '@/assets/images/rig/rig-dev.png?asset';
import { PRODUCT_NAME } from '@shared/app-identity';
import { registerRPCRouter } from '@shared/lib/ipc/rpc';
import { rigSettingsChangedChannel } from '@shared/rig/settings';
import { rigOpenRecentChannel } from '@shared/rig/workspace';
import { LIBSECRET_PASSWORD_STORE, shouldForceLibsecretBackend } from './app/linux-secret-storage';
import { setupApplicationMenu } from './app/menu';
import { registerAppScheme, setupAppProtocol } from './app/protocol';
import { registerQuitHandler } from './app/shutdown';
import { applyNativeTheme, createMainWindow } from './app/window';
import { acpAgentStatusBridge } from './core/acp/agent-status-bridge';
import { initializeAcpRuntimeProcess } from './core/acp/controller';
import { initializeAgentConfigRuntimeProcess } from './core/agent-config/controller';
import { agentHookService } from './core/agent-hooks/agent-hook-service';
import { appService } from './core/app/service';
import { automationsService } from './core/automations/automations-service';
import { cleanupLegacyBrowserPartitions } from './core/browser/browser-partition-cleanup';
import { setBrowserCorsRelaxationSettings } from './core/browser/browser-profile-session';
import { browserWebContentsRegistry } from './core/browser/browser-webcontents-registry';
import { resetStaleAcpAgentStatuses } from './core/conversations/reset-stale-acp-agent-statuses';
import { localDependencyManager } from './core/dependencies/dependency-managers';
import { editorBufferService } from './core/editor/editor-buffer-service';
import { projectSettingsService } from './core/projects/settings/project-settings-service';
import { promptLibraryService } from './core/prompt-library/service';
import { remoteTmuxReaperService } from './core/pty/remote-tmux-reaper-service';
import { prSyncScheduler } from './core/pull-requests/pr-sync-scheduler';
import { reconcileResourceSampler } from './core/resource-monitor/resource-sampler';
import { searchService } from './core/search/search-service';
import { workspaceFileIndexService } from './core/search/workspace-file-index-service';
import { appSettingsService } from './core/settings/settings-service';
import { updateService } from './core/updates/update-service';
import { viewStateService } from './core/view-state/view-state-service';
import { initializeDatabase } from './db/initialize';
import { events } from './lib/events';
import {
  initializeFileLogger,
  registerProcessErrorLogging,
  registerRendererLogHandler,
} from './lib/file-logger';
import { log } from './lib/logger';
import { withRpcLogging } from './lib/rpc-logging';
import { telemetryService } from './lib/telemetry';
import {
  ensureBundledRigBinInPath,
  installBundledRigSkill,
  logRigVersionSkew,
} from './rig/bundled-cli';
import { wireAgentRunnabilityPersistence } from './rig/agent-runnability';
import { registerRigBridge } from './rig/intent-bridge';
import { rigSettingsStore } from './rig/settings-instance';
import { bufferOpenFilePath } from './rig/workspace';
import { rpcRouter } from './rpc';
import { resolveUserEnv } from './utils/userEnv';

if (import.meta.env.DEV) {
  dotenvConfig({ path: '.env.local', override: false });
}

if (process.platform === 'linux') {
  app.commandLine.appendSwitch('ozone-platform-hint', 'auto');
  if (
    shouldForceLibsecretBackend(process.env, {
      passwordStoreSwitchPresent: app.commandLine.hasSwitch('password-store'),
    })
  ) {
    app.commandLine.appendSwitch('password-store', LIBSECRET_PASSWORD_STORE);
  }
}

registerAppScheme();

initializeFileLogger();
registerProcessErrorLogging(log);
registerRendererLogHandler(ipcMain);

// macOS: a rig folder chosen from the Dock icon's "Recent" list (or, once
// `menu.ts`'s `recentDocuments` role is wired, File → Open Recent).
// Registered before `app.whenReady()`, per Electron's own guidance, since a
// cold launch by picking a recent item fires this before any window (and
// its renderer) exists — `bufferOpenFilePath`/`consumePendingOpenFile` in
// `rig/workspace.ts` is how the renderer recovers it once mounted; the
// `events.emit` alongside it is a no-op if nothing's listening yet, and
// covers the already-running case, whose listener predates this call.
// Single window, v1: opening a recent rig replaces whatever is currently
// open rather than spawning a second window — multi-window is future work.
app.on('open-file', (event, path) => {
  event.preventDefault();
  bufferOpenFilePath(path);
  events.emit(rigOpenRecentChannel, path);
});

app.on('second-instance', () => {
  const win = BrowserWindow.getAllWindows()[0];
  if (win?.isMinimized()) win.restore();
  win?.focus();
});

if (!import.meta.env.DEV && !app.requestSingleInstanceLock()) {
  app.quit();
  process.exit(0);
}

if (import.meta.env.DEV) {
  try {
    app.dock?.setIcon(devIcon);
  } catch (err) {
    log.warn('Failed to set dock icon:', err);
  }
}

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    createMainWindow();
  }
});

void app.whenReady().then(async () => {
  // resolveUserEnv never throws (it falls back to process.env internally), so
  // the bundled-rig PATH prepend below runs on both its success and failure
  // paths — and must run after it, because it rebuilds PATH from the login shell.
  await resolveUserEnv();
  ensureBundledRigBinInPath();
  logRigVersionSkew();
  installBundledRigSkill();

  try {
    await initializeDatabase();
    await resetStaleAcpAgentStatuses();
    searchService.initialize();
    workspaceFileIndexService.initialize();
    void editorBufferService.pruneStale();
    void cleanupLegacyBrowserPartitions();
    try {
      viewStateService.pruneOrphans();
    } catch (e: unknown) {
      log.warn('view-state: failed to prune orphaned entries', { error: e });
    }
  } catch (error) {
    log.error('Failed to initialize database:', error);
    dialog.showErrorBox(
      'Database Initialization Failed',
      `${PRODUCT_NAME} could not start because the database failed to initialize.\n\n${error instanceof Error ? error.message : String(error)}`
    );
    app.quit();
    return;
  }

  try {
    await telemetryService.initialize({ installSource: app.isPackaged ? 'dmg' : 'dev' });
  } catch (e) {
    log.warn('telemetry init failed:', e);
  }

  rigSettingsStore.initialize();
  rigSettingsStore.subscribe((settings) => {
    events.emit(rigSettingsChangedChannel, settings);
  });

  projectSettingsService.initialize();
  prSyncScheduler.initialize();
  remoteTmuxReaperService.initialize();
  automationsService.start();
  appService.initialize();
  await appSettingsService.initialize();
  applyNativeTheme(await appSettingsService.get('theme'));
  browserWebContentsRegistry.setKeyboardSettings(await appSettingsService.get('keyboard'));
  setBrowserCorsRelaxationSettings(await appSettingsService.get('browser'));
  await promptLibraryService.initialize();

  agentHookService.initialize().catch((e) => {
    log.error('Failed to start agent event service:', e);
  });
  initializeAcpRuntimeProcess().catch((e) => {
    log.error('Failed to start ACP runtime process:', e);
  });
  initializeAgentConfigRuntimeProcess().catch((e) => {
    log.error('Failed to start agent-config runtime process:', e);
  });
  acpAgentStatusBridge.initialize();
  registerRigBridge();

  registerRPCRouter(rpcRouter, app.isPackaged ? ipcMain : withRpcLogging(ipcMain));

  void reconcileResourceSampler();

  // BEFORE probeAll, so no probe result can land between subscription and
  // the initial sweep — see `agent-runnability.ts`'s own header comment.
  wireAgentRunnabilityPersistence();

  localDependencyManager.probeAll().catch((e: unknown) => {
    log.error('Failed to probe dependencies:', e);
  });

  // Round (first-launch prompts): both blocks that used to sit here —
  // an unconditional `systemPreferences.askForMediaAccess('microphone')`
  // and an unconditional `githubAccountReconciliationService.reconcileAtStartup()`
  // — fired a real OS permission prompt (mic) or a real safeStorage/keychain
  // touch (GitHub reconciliation's CLI-account import, when `gh` is
  // installed and authenticated) on EVERY cold boot, before the user had
  // done anything. Investigated and removed:
  //   - Microphone: inherited from emdash's voice dictation/voice-mode
  //     feature, which rig-desktop never shipped — zero `getUserMedia`/
  //     `mediaDevices` callers anywhere in this app. Asking for mic access
  //     for a feature that doesn't exist is just a scary first-run prompt;
  //     the `NSMicrophoneUsageDescription`/`com.apple.security.device.audio-input`
  //     entitlement was removed too (`electron-builder.config.ts`,
  //     `build/entitlements.mac.plist`) — no usage description, no ability
  //     to ask at all, belt and suspenders.
  //   - GitHub account reconciliation: rig-desktop holds no secrets of its
  //     own (the PAT is CLI-owned, agent creds are harness-owned) — and
  //     confirmed by grep, nothing in the renderer ever calls `rpc.github.*`
  //     or `rpc.integrations.*`, and the `githubAccountsChangedChannel`
  //     event this emitted has zero listeners. The whole GitHub-account
  //     subsystem (device-flow auth, provider-account registry, legacy KV/
  //     safeStorage migration, silent `gh` CLI import) is dead weight in
  //     the shipped product; running it eagerly at boot bought nothing but
  //     an unconsented keychain touch. `encryptedAppSecretsStore` itself
  //     stays fully lazy — see its own file — this was the only boot-time
  //     caller. Not deleted outright (a bigger change than this round), but
  //     no longer runs unless something calls it — grep
  //     `githubAccountReconciliationService`/`reconcileAtStartup` before
  //     resurrecting this.

  setupAppProtocol(join(app.getAppPath(), 'out', 'renderer'));
  setupApplicationMenu();
  createMainWindow();

  try {
    await updateService.initialize();
  } catch (error) {
    if (app.isPackaged) {
      log.error('Failed to initialize auto-update service:', error);
    }
  }
});

registerQuitHandler();
