import { execFile } from 'node:child_process';
import { createRPCController } from '@shared/lib/ipc/rpc';
import type { ConnectorCheck } from '@shared/rig/first-run';
import { globalSetup } from '../connectors/connections-instance';
import { ghAuthFrom, runPreflight, type GhAuth } from './preflight';

const GH_TIMEOUT_MS = 5_000;

/** `gh auth status`, never with `--show-token`: only whether it's signed in. No `gh` on this Mac is not signed in. */
function ghAuth(): Promise<GhAuth> {
  return new Promise((resolve) => {
    execFile(
      'gh',
      ['auth', 'status'],
      { timeout: GH_TIMEOUT_MS, env: { ...process.env, GH_PROMPT_DISABLED: '1', NO_COLOR: '1' } },
      (error, stdout, stderr) =>
        resolve(ghAuthFrom({ ok: !error, output: `${String(stdout)}\n${String(stderr)}` }))
    );
  });
}

/** `rpc.rig.firstRun`: what the first run asks of this Mac. */
export const rigFirstRunController = createRPCController({
  /** Connect's pre-flight: each tool's state for the person's Claude, read fresh. */
  preflight: (): Promise<ConnectorCheck[]> =>
    runPreflight({
      invalidate: () => globalSetup.invalidate(),
      claudeEntries: () => globalSetup.claudeEntries(undefined),
      ghAuth,
    }),
});
