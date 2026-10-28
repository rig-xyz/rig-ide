import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import type { IExecutionContext } from '../../exec/execution-context';
import {
  cliPathIsGone,
  resolveExtraLocationGlob,
  resolveExtraLocationPath,
  resolveExtraLocationPaths,
} from './probe';

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

describe('resolveExtraLocationGlob', () => {
  const base = '/Users/me/Library/Application Support/Claude/claude-code';
  const pattern = `${base}/*/*/claude.app/Contents/MacOS/claude`;

  it('picks the executable match with the highest version, quoting the literal segments', async () => {
    let script = '';
    const ctx = makeCtx(async (command, args) => {
      if (command !== 'sh') throw new Error(`Unexpected: ${command}`);
      script = args[1]!;
      return {
        stdout: [
          `${base}/2.1.289/ee67/claude.app/Contents/MacOS/claude`,
          `${base}/2.1.293/8433/claude.app/Contents/MacOS/claude`,
          `${base}/2.1.30/aaaa/claude.app/Contents/MacOS/claude`,
        ].join('\n'),
        stderr: '',
      };
    });
    expect(await resolveExtraLocationGlob(pattern, ctx)).toBe(`${base}/2.1.293/8433/claude.app/Contents/MacOS/claude`);
    expect(script).toContain("'Application Support'/'Claude'/'claude-code'/*/*/'claude.app'");
  });

  it('is null when nothing matches or the shell fails, and resolveExtraLocationPath routes a * to it', async () => {
    expect(await resolveExtraLocationGlob(pattern, makeCtx(async () => ({ stdout: '', stderr: '' })))).toBeNull();
    const failing = makeCtx(async () => {
      throw new Error('no sh');
    });
    expect(await resolveExtraLocationPath(pattern, failing)).toBeNull();
  });
});

describe('cliPathIsGone', () => {
  it('is true for a local path whose file was deleted, false while it exists', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'cli-gone-'));
    const cli = path.join(dir, 'claude');
    await writeFile(cli, '');
    const ctx = { ...makeCtx(async () => ({ stdout: '', stderr: '' })), supportsLocalSpawn: true };
    try {
      await expect(cliPathIsGone(cli, ctx)).resolves.toBe(false);
      await rm(cli);
      await expect(cliPathIsGone(cli, ctx)).resolves.toBe(true);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('never calls a bare command name gone — PATH finds it at spawn time', async () => {
    const ctx = makeCtx(async () => ({ stdout: 'gone\n', stderr: '' }));
    await expect(cliPathIsGone('claude', ctx)).resolves.toBe(false);
    expect(ctx.exec).not.toHaveBeenCalled();
  });

  it('asks a remote host and trusts only its answer, not a failed check', async () => {
    const answers = makeCtx(async (_command, args) => ({
      stdout: args.at(-1) === '/gone/claude' ? 'gone\n' : 'present\n',
      stderr: '',
    }));
    await expect(cliPathIsGone('/gone/claude', answers)).resolves.toBe(true);
    await expect(cliPathIsGone('/usr/bin/claude', answers)).resolves.toBe(false);

    const failing = makeCtx(async () => {
      throw new Error('timed out');
    });
    await expect(cliPathIsGone('/usr/bin/claude', failing)).resolves.toBe(false);
  });
});
