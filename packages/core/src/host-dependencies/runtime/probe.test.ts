import os from 'node:os';
import { describe, expect, it, vi } from 'vitest';
import type { IExecutionContext } from '../../exec/execution-context';
import { resolveExtraLocationPath, resolveExtraLocationPaths } from './probe';

function makeCtx(
  handler: (command: string, args: string[]) => Promise<{ stdout: string; stderr: string }>
): IExecutionContext {
  return {
    root: undefined,
    supportsLocalSpawn: false,
    exec: vi.fn().mockImplementation(handler),
    execStreaming: vi.fn(),
    dispose: vi.fn(),
  } as unknown as IExecutionContext;
}

describe('resolveExtraLocationPath', () => {
  it('returns the path when `test -x` succeeds', async () => {
    const path = '/Applications/ChatGPT.app/Contents/Resources/codex';
    const ctx = makeCtx(async (command, args) => {
      if (command === 'test' && args[0] === '-x' && args[1] === path) {
        return { stdout: '', stderr: '' };
      }
      throw new Error(`Unexpected: ${command} ${args.join(' ')}`);
    });

    expect(await resolveExtraLocationPath(path, ctx)).toBe(path);
  });

  it('expands a leading ~ to the home directory before probing', async () => {
    const home = os.homedir();
    const expanded = `${home}/Applications/ChatGPT.app/Contents/Resources/codex`;
    const ctx = makeCtx(async (command, args) => {
      if (command === 'test' && args[0] === '-x' && args[1] === expanded) {
        return { stdout: '', stderr: '' };
      }
      throw new Error(`Unexpected: ${command} ${args.join(' ')}`);
    });

    expect(
      await resolveExtraLocationPath('~/Applications/ChatGPT.app/Contents/Resources/codex', ctx)
    ).toBe(expanded);
  });

  it('returns null when the location does not exist or is not executable — harmless, not thrown', async () => {
    const ctx = makeCtx(async () => {
      throw new Error('No such file or directory');
    });

    expect(
      await resolveExtraLocationPath('/Applications/ChatGPT.app/Contents/Resources/codex', ctx)
    ).toBeNull();
  });
});

describe('resolveExtraLocationPaths', () => {
  it('filters out missing locations and keeps ones that exist', async () => {
    const present = '/Applications/ChatGPT.app/Contents/Resources/codex';
    const missing = '/Applications/OtherApp.app/Contents/Resources/codex';
    const ctx = makeCtx(async (command, args) => {
      if (command === 'test' && args[1] === present) return { stdout: '', stderr: '' };
      throw new Error('No such file or directory');
    });

    expect(await resolveExtraLocationPaths([missing, present], ctx)).toEqual([present]);
  });

  it('returns an empty array when given no locations', async () => {
    const ctx = makeCtx(async () => ({ stdout: '', stderr: '' }));
    expect(await resolveExtraLocationPaths([], ctx)).toEqual([]);
  });
});
