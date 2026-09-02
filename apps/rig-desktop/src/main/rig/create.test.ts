import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { rigSlug, validateRigName } from '@shared/rig/create';
import { parseRigCliOutput, startHereDocContent, writeSeedDoc } from './create';

describe('parseRigCliOutput', () => {
  it('parses a success body (rig init --json)', () => {
    expect(
      parseRigCliOutput(
        '{"protocolVersion":1,"name":"knee-ability","sync":true,"live":false,"path":"/x/knee-ability"}\n'
      )
    ).toEqual({
      kind: 'ok',
      body: { protocolVersion: 1, name: 'knee-ability', sync: true, live: false, path: '/x/knee-ability' },
    });
  });

  it('surfaces the CLI error envelope verbatim — the dangerous-location guard shape', () => {
    const message =
      'Refusing to run rig init in your home directory (/Users/dylan). A rig belongs in its own project folder, not a directory full of personal data. Re-run with --allow-unsafe-location to override.';
    expect(parseRigCliOutput(JSON.stringify({ protocolVersion: 1, error: { code: 'error', message } }))).toEqual({
      kind: 'error',
      code: 'error',
      message,
    });
  });

  it('parses rig sync --json error envelopes with their code (not_logged_in, quota)', () => {
    expect(
      parseRigCliOutput(
        '{"protocolVersion":1,"error":{"code":"not_logged_in","message":"Not signed in to Rig Hub. Run `rig login` first."}}'
      )
    ).toEqual({
      kind: 'error',
      code: 'not_logged_in',
      message: 'Not signed in to Rig Hub. Run `rig login` first.',
    });
  });

  it('takes the LAST JSON object line, ignoring stray non-JSON noise', () => {
    const out = ['some stray warning', '{"old":true}', '{"protocolVersion":1,"state":"live","enabledSync":true}'].join(
      '\n'
    );
    expect(parseRigCliOutput(out)).toEqual({
      kind: 'ok',
      body: { protocolVersion: 1, state: 'live', enabledSync: true },
    });
  });

  it('reports unparseable output honestly', () => {
    expect(parseRigCliOutput('')).toEqual({ kind: 'unparseable' });
    expect(parseRigCliOutput('Created rig.toml\nReview package.include')).toEqual({ kind: 'unparseable' });
    expect(parseRigCliOutput('{broken json')).toEqual({ kind: 'unparseable' });
  });

  it('defaults a malformed envelope to a usable error', () => {
    expect(parseRigCliOutput('{"error":{}}')).toEqual({
      kind: 'error',
      code: 'error',
      message: 'The rig CLI reported an error.',
    });
  });
});

describe('rigSlug', () => {
  it("mirrors the CLI's naming rule (lowercase, invalid runs collapse to one hyphen)", () => {
    expect(rigSlug('Knee Ability Zero')).toBe('knee-ability-zero');
    expect(rigSlug('My Rig!!')).toBe('my-rig');
    expect(rigSlug('research.notes_v2')).toBe('research.notes_v2');
  });

  it('is a fixpoint of the CLI rule — no leading/trailing hyphens survive', () => {
    expect(rigSlug('--weird name--')).toBe('weird-name');
    expect(rigSlug('  spaced  ')).toBe('spaced');
    // Applying the slug to its own output changes nothing.
    for (const input of ['Knee Ability', '--a--', 'ALL CAPS 42']) {
      const once = rigSlug(input);
      expect(rigSlug(once)).toBe(once);
    }
  });

  it('returns empty when nothing sluggable remains', () => {
    expect(rigSlug('!!!')).toBe('');
    expect(rigSlug('   ')).toBe('');
  });
});

describe('validateRigName', () => {
  it('requires a name, and one that slugs to something', () => {
    expect(validateRigName('')).toBe('Give the rig a name.');
    expect(validateRigName('   ')).toBe('Give the rig a name.');
    expect(validateRigName('!!!')).toBe('The name needs at least one letter or number.');
    expect(validateRigName('Knee Ability')).toBeNull();
  });
});

describe('startHereDocContent', () => {
  it('names the onboarding flow\'s three real actions (docs/onboarding-flow-spec.md §3)', () => {
    const content = startHereDocContent();
    expect(content).toContain('# Welcome to your rig');
    expect(content).toContain('leave a comment');
    expect(content).toContain('@claude');
    expect(content).toContain('@codex');
    expect(content).toContain('**Share**');
  });
});

describe('writeSeedDoc', () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  it('writes the landing doc into the target directory and returns its path', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'rig-create-seed-doc-'));
    dirs.push(dir);
    const docPath = await writeSeedDoc(dir);
    expect(docPath).toBe(join(dir, 'Start here.md'));
    expect(readFileSync(join(dir, 'Start here.md'), 'utf8')).toBe(startHereDocContent());
  });

  it('is best-effort — a bad target directory returns null instead of throwing', async () => {
    await expect(
      writeSeedDoc(join(tmpdir(), 'rig-create-seed-doc-nonexistent', 'nested'))
    ).resolves.toBeNull();
  });
});
