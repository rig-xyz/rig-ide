import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { markMissingTools, toolOnPath } from './install-tools';

describe('markMissingTools', () => {
  it('marks npm and Homebrew ways when their program is missing, and leaves the rest alone', () => {
    const options = [
      { method: 'npm' as const, command: 'npm install -g @openai/codex' },
      { method: 'curl' as const, command: 'curl -fsSL https://chatgpt.com/codex/install.sh | sh', recommended: true },
      { method: 'homebrew' as const, command: 'brew install --cask codex' },
    ];
    expect(markMissingTools(options, (tool) => tool === 'brew')).toEqual([
      { ...options[0], missingTool: 'npm' },
      options[1],
      options[2],
    ]);
  });
});

describe('toolOnPath', () => {
  it('finds an executable in a PATH directory, and not a missing one', () => {
    const dir = mkdtempSync(join(tmpdir(), 'rig-tools-'));
    writeFileSync(join(dir, 'npm-fake'), '#!/bin/sh\n', { mode: 0o755 });
    expect(toolOnPath('npm-fake', dir)).toBe(true);
    expect(toolOnPath('definitely-not-a-tool-xyz', dir)).toBe(false);
  });
});
