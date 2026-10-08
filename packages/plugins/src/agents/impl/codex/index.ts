import { createRequire } from 'node:module';
import { definePlugin, registerPluginBehavior } from '@emdash/core/agents/plugins';
import {
  buildStandardCommand,
  codexMcpAdapter,
  homebrewOption,
  npmDependency,
} from '@emdash/core/agents/plugins/helpers';
import { connectStdioAcp } from '../../helpers/acp-stdio';
import { authenticatedFromEnv, commandAuthStatus } from '../../helpers/auth';
import { buildCodexHookConfig } from './hooks';
import { icon } from './icon';

const _require = createRequire(import.meta.url);

function resolveCodexAcpEntry(): string {
  return _require.resolve('@agentclientprotocol/codex-acp/dist/index.js');
}

/** The namespace Codex gives the tools of rig's own MCP server (`rig`): `mcp__` plus the server name. */
const RIG_TOOLS_NAMESPACE = 'mcp__rig';

function asObject(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

/**
 * codex-acp's `CODEX_CONFIG` (JSON it merges into every thread's config), with
 * CLAUDE.md added to Codex's `project_doc_fallback_filenames`: Codex then reads
 * a folder's CLAUDE.md when it has no AGENTS.md, as Claude reads CLAUDE.md.
 *
 * And rig's own tools listed upfront: Codex defers every MCP tool behind tool
 * search (its `tool_search_always_defer_mcp_tools` is on and can't be turned
 * off), so the agent never sees their descriptions until it goes looking. A
 * namespace in `features.code_mode.direct_only_tool_namespaces` skips that and
 * is a top-level tool instead. Only the `rig` server's tools, which only a
 * space session has, so other sessions are unchanged.
 *
 * Anything already in `existing` is kept.
 */
export function codexConfigWithClaudeMd(existing: string | undefined): string {
  let config: Record<string, unknown> = {};
  if (existing) {
    try {
      const parsed: unknown = JSON.parse(existing);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) config = parsed as Record<string, unknown>;
    } catch {
      // Not JSON: codex-acp would fail to start on it anyway.
    }
  }
  const current = config.project_doc_fallback_filenames;
  const fallbacks = Array.isArray(current) ? current.filter((name): name is string => typeof name === 'string') : [];
  const features = asObject(config.features);
  // `code_mode = true` is the same feature with no settings: keep it on.
  const codeMode = typeof features.code_mode === 'boolean' ? { enabled: features.code_mode } : asObject(features.code_mode);
  const direct = Array.isArray(codeMode.direct_only_tool_namespaces)
    ? codeMode.direct_only_tool_namespaces.filter((name): name is string => typeof name === 'string')
    : [];
  return JSON.stringify({
    ...config,
    project_doc_fallback_filenames: fallbacks.includes('CLAUDE.md') ? fallbacks : [...fallbacks, 'CLAUDE.md'],
    features: {
      ...features,
      code_mode: {
        ...codeMode,
        direct_only_tool_namespaces: direct.includes(RIG_TOOLS_NAMESPACE) ? direct : [...direct, RIG_TOOLS_NAMESPACE],
      },
    },
  });
}

/** OpenAI's standalone installer: a native binary in ~/.local/bin, no Node or npm needed. */
const CODEX_NATIVE_INSTALLER = {
  method: 'curl' as const,
  command: 'curl -fsSL https://chatgpt.com/codex/install.sh | CODEX_NON_INTERACTIVE=1 sh',
  recommended: true,
};

export const plugin = definePlugin(
  {
    id: 'codex',
    name: 'Codex',
    description:
      'CLI that connects to OpenAI models for project-aware code assistance and terminal workflows.',
    websiteUrl: 'https://github.com/openai/codex',
  },
  {
    acp: {
      kind: 'supported',
    },
    autoApprove: {
      kind: 'supported',
    },
    auth: {
      kind: 'supported',
      methods: [
        {
          kind: 'cli-login',
          id: 'codex-login',
          name: 'Sign in with Codex',
          args: ['login'],
          description: 'Open the Codex CLI sign-in flow in a terminal.',
        },
        {
          kind: 'api-key',
          id: 'openai-api-key',
          name: 'Use an OpenAI API key',
          envVars: [{ name: 'OPENAI_API_KEY', label: 'OpenAI API key' }],
          helpUrl: 'https://platform.openai.com/api-keys',
        },
      ],
    },
    models: {
      kind: 'selectable',
      modelOptions: {
        'gpt-5.6-sol': {
          name: 'GPT-5.6 Sol',
          description: 'Flagship GPT-5.6 model for the hardest agentic coding workflows.',
          modelFeatures: { intelligence: 5, speed: 2 },
        },
        'gpt-5.6-terra': {
          name: 'GPT-5.6 Terra',
          description: 'Balanced GPT-5.6 model for everyday coding work with lower cost.',
          modelFeatures: { intelligence: 5, speed: 4 },
        },
        'gpt-5.6-luna': {
          name: 'GPT-5.6 Luna',
          description: 'Fast and cost-efficient GPT-5.6 model for lighter coding tasks.',
          modelFeatures: { intelligence: 4, speed: 5 },
        },
        'gpt-5.5': {
          name: 'GPT-5.5',
          description: 'Recommended Codex model for complex coding and agentic workflows.',
          modelFeatures: { intelligence: 5, speed: 3 },
        },
        'gpt-5.4-mini': {
          name: 'GPT-5.4 Mini',
          description: 'Faster Codex model for lighter coding tasks and subagents.',
          modelFeatures: { intelligence: 4, speed: 5 },
        },
        'gpt-5.3-codex-spark': {
          name: 'GPT-5.3 Codex Spark',
          description: 'Research-preview Codex model optimized for near-instant iteration.',
          modelFeatures: { intelligence: 2, speed: 5 },
        },
      },
    },
    hooks: {
      kind: 'config',
      scope: 'global',
      supportedEvents: ['start', 'notification', 'stop', 'session'],
    },
    hostDependency: npmDependency({
      id: 'codex',
      package: '@openai/codex',
      // OpenAI's own installer needs no Node, which a clean Mac lacks: it's
      // the one offered first. npm stays for people who already use it.
      recommended: false,
      extraOptions: {
        macos: [CODEX_NATIVE_INSTALLER, homebrewOption({ formula: 'codex', cask: true })],
        linux: [CODEX_NATIVE_INSTALLER, homebrewOption({ formula: 'codex', cask: true })],
        windows: [
          {
            method: 'powershell',
            command:
              'powershell -ExecutionPolicy ByPass -c "irm https://chatgpt.com/codex/install.ps1 | iex"',
            updateCommand:
              'powershell -ExecutionPolicy ByPass -c "irm https://chatgpt.com/codex/install.ps1 | iex"',
          },
        ],
      },
      // The ChatGPT desktop app bundles its own codex-cli, off PATH, which `which -a`
      // never sees. It's frequently newer than a stale global npm/homebrew install and
      // is the only one that knows about ChatGPT-account-only models (e.g. gpt-6-sol)
      // — so it's worth discovering as a candidate even though emdash didn't install it.
      // Since ChatGPT 26.928 (2026-10) it lives under `codex-cli/bin/`; the old path
      // stays for older app versions.
      extraLocations: {
        macos: [
          // Where OpenAI's own installer puts it, for an app that doesn't see the shell's PATH.
          '~/.local/bin/codex',
          '/Applications/ChatGPT.app/Contents/Resources/codex-cli/bin/codex',
          '~/Applications/ChatGPT.app/Contents/Resources/codex-cli/bin/codex',
          '/Applications/ChatGPT.app/Contents/Resources/codex',
          '~/Applications/ChatGPT.app/Contents/Resources/codex',
        ],
      },
      // Auto-resolution (no user pin/override) should prefer whichever discovered
      // codex is newest rather than whichever happens to be first on PATH — a global
      // npm install commonly shadows the ChatGPT app's newer bundled binary otherwise.
      preferNewest: true,
    }),
    mcp: {
      kind: 'supported',
      scope: 'global',
      supportedTransports: ['stdio', 'http'],
    },
    prompt: {
      kind: 'argv',
      flag: '',
    },
    sessions: {
      kind: 'resumable',
    },
  },
  { icon }
);

export const provider = registerPluginBehavior(plugin, {
  acp: {
    buildSpawn: (ctx) => ({
      command: process.execPath,
      args: [resolveCodexAcpEntry()],
      env: {
        ELECTRON_RUN_AS_NODE: '1',
        CODEX_PATH: ctx.cli,
        // codex-acp otherwise drops a per-session MCP server (e.g. rig's own `rig`
        // tools) whose name matches one in the user's own Codex config
        // (`shouldDeduplicateMcpConflicts` in its dist/index.js).
        DISABLE_MCP_CONFIG_FILTERING: 'true',
        CODEX_CONFIG: codexConfigWithClaudeMd(ctx.env.CODEX_CONFIG),
      },
    }),
    connect: (io, toClient) => {
      return connectStdioAcp(io, toClient);
    },
  },
  auth: {
    checkStatus: async (ctx) => {
      const envStatus = authenticatedFromEnv(ctx, ['OPENAI_API_KEY']);
      if (envStatus.kind === 'authenticated') return envStatus;
      return commandAuthStatus(ctx, ['login', 'status'], {
        authenticatedPattern: /authenticated|logged in|signed in/i,
        unauthenticatedPattern: /not authenticated|not logged in|not signed in|login required/i,
      });
    },
  },
  prompt: {
    buildCommand: (ctx) =>
      buildStandardCommand(ctx, {
        autoApproveFlag:
          '-c approval_policy="never" -c sandbox_mode="danger-full-access" --dangerously-bypass-hook-trust',
        initialPromptFlag: '',
        resumeFlag: 'resume',
        sessionIdFlag: ' ',
        sessionIdOnResumeOnly: true,
        resumeWithoutSessionFlag: 'resume --last',
        deduplicateFlags: ['--dangerously-bypass-approvals-and-sandbox'],
        modelFlag: '-m',
      }),
  },
  hooks: buildCodexHookConfig(),
  mcp: codexMcpAdapter(),
});
