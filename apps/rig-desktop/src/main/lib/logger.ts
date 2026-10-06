import { createVariadicAdapter } from '@emdash/shared/logger';
import { initProcessLogging } from '@emdash/shared/logger/node';
import { app } from 'electron';
import { getLogFileDestination } from './file-logger';

const debugFlag = process.argv.includes('--debug-logs');

/**
 * A packaged build writes `info` and up, so a problem report has Rig's own
 * story in it (still rotated at 5 MB × 5). `EMDASH_LOG_LEVEL`/`LOG_LEVEL` and
 * `--debug-logs` still win; dev builds keep the shared default (`warn`).
 */
export function defaultLogLevel(
  env: NodeJS.ProcessEnv,
  opts: { packaged: boolean; debugFlag: boolean }
): string | undefined {
  const explicit = env.EMDASH_LOG_LEVEL ?? env.LOG_LEVEL;
  if (explicit) return explicit;
  if (opts.debugFlag) return 'debug';
  return opts.packaged ? 'info' : undefined;
}

function isPackaged(): boolean {
  try {
    return app?.isPackaged === true;
  } catch {
    return false;
  }
}

const level = defaultLogLevel(process.env, { packaged: isPackaged(), debugFlag });

const inner = initProcessLogging({
  name: 'emdash-main',
  env: level ? { ...process.env, EMDASH_LOG_LEVEL: level } : process.env,
  debugFlag,
  destination: getLogFileDestination(),
});

export const log = createVariadicAdapter(inner);

export type Logger = typeof log;
