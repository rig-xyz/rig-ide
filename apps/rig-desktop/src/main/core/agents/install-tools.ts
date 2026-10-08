import { accessSync, constants } from 'node:fs';
import { delimiter, join } from 'node:path';
import type { InstallOption } from '@shared/core/agents/agent-payload';

/** The program an install method runs, when it needs one a clean Mac may not have. */
const TOOL_BY_METHOD: Partial<Record<InstallOption['method'], string>> = {
  npm: 'npm',
  homebrew: 'brew',
  pip: 'pip3',
  cargo: 'cargo',
};

/** Where a Mac keeps these when a GUI app's PATH leaves them out. */
const USUAL_DIRS = ['/opt/homebrew/bin', '/usr/local/bin'];

/** Whether `tool` is an executable on PATH or in the usual places. */
export function toolOnPath(tool: string, pathEnv = process.env.PATH ?? ''): boolean {
  const dirs = [...pathEnv.split(delimiter).filter(Boolean), ...USUAL_DIRS];
  return dirs.some((dir) => {
    try {
      accessSync(join(dir, tool), constants.X_OK);
      return true;
    } catch {
      return false;
    }
  });
}

/**
 * Marks each install option whose program this computer lacks (npm with no
 * Node, Homebrew with no brew), so the install offer can leave it out and
 * show a way that works here instead.
 */
export function markMissingTools(options: InstallOption[], hasTool: (tool: string) => boolean): InstallOption[] {
  return options.map((option) => {
    const tool = TOOL_BY_METHOD[option.method];
    return tool && !hasTool(tool) ? { ...option, missingTool: tool } : option;
  });
}
