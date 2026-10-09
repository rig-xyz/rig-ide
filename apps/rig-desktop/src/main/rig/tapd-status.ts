import { execFile } from 'node:child_process';
import { resolveCliBin } from './bundled-cli';
import type { TapdStatus } from './sync-problems';

const TAPD_STATUS_TIMEOUT_MS = 15_000;

/** `tapd status --dir <root> --json` for one folder, or null when it can't answer. */
export function readTapdStatus(root: string): Promise<TapdStatus | null> {
  return new Promise((done) => {
    execFile(
      resolveCliBin('tapd'),
      ['status', '--dir', root, '--json'],
      { timeout: TAPD_STATUS_TIMEOUT_MS, maxBuffer: 4 * 1024 * 1024 },
      (error, stdout) => {
        if (error && !stdout) return done(null);
        try {
          const parsed: unknown = JSON.parse(String(stdout));
          done(typeof parsed === 'object' && parsed !== null ? (parsed as TapdStatus) : null);
        } catch {
          done(null);
        }
      }
    );
  });
}
