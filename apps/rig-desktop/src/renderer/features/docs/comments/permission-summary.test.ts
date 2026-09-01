import { describe, expect, it } from 'vitest';
import type { RigCommentPermissionDetail } from '@shared/rig/comments';
import { alwaysAllowLabel, rawPermissionDetailText, summarizePermissionDetail } from './permission-summary';

// The same realistic base64url target ref `comment-agent-auto-approve.test.ts`
// uses — the actual shape of the one Bash command this app's own hidden
// context prompt tells the model to run. Normally auto-approved before it
// ever reaches a card, but the summarizer must still never leak it into a
// headline if this shape (or one that merely resembles it) ever does.
const TARGET_REF =
  'eyJ2ZXJzaW9uIjoxLCJ3b3Jrc3BhY2VCaW5kaW5nSWQiOiJibmRfY29udGV4dCIsInBhdGgiOiJkb2NzL2ZvcmVjYXN0Lm1kIn0';

describe('summarizePermissionDetail — execute', () => {
  it('names the rig CLI sentinel as "rig" and never leaks the base64 target', () => {
    const summary = summarizePermissionDetail({
      kind: 'execute',
      command: `"$RIG_CLI_PATH" context trace --target ${TARGET_REF} --json`,
    });
    expect(summary.headline).toBe('Wants to run rig');
    expect(summary.headline).not.toContain(TARGET_REF);
    expect(summary.secondary).toBeUndefined();
  });

  it('names a plain command by its first token', () => {
    expect(summarizePermissionDetail({ kind: 'execute', command: 'npm test' }).headline).toBe(
      'Wants to run npm'
    );
  });

  it('unquotes and basenames a quoted absolute path', () => {
    expect(
      summarizePermissionDetail({ kind: 'execute', command: '"/usr/bin/node" server.js' }).headline
    ).toBe('Wants to run node');
  });

  it('falls back to the generic phrasing for a compound shell construct', () => {
    const summary = summarizePermissionDetail({
      kind: 'execute',
      command: 'for f in a b c; do echo "$f"; done',
    });
    expect(summary.headline).toBe('Wants to run a command in this workspace');
  });

  it('falls back to the generic phrasing for an env-var assignment prefix', () => {
    expect(
      summarizePermissionDetail({ kind: 'execute', command: 'NODE_ENV=production node app.js' })
        .headline
    ).toBe('Wants to run a command in this workspace');
  });

  it('falls back to the generic phrasing for chained/substituted commands', () => {
    expect(
      summarizePermissionDetail({ kind: 'execute', command: '$(cat secret) --run' }).headline
    ).toBe('Wants to run a command in this workspace');
  });

  it('falls back to the generic phrasing when there is no command at all', () => {
    expect(summarizePermissionDetail({ kind: 'execute' }).headline).toBe(
      'Wants to run a command in this workspace'
    );
  });

  it('falls back when the first token itself looks like an opaque blob', () => {
    expect(summarizePermissionDetail({ kind: 'execute', command: `${TARGET_REF} --json` }).headline).toBe(
      'Wants to run a command in this workspace'
    );
  });
});

describe('summarizePermissionDetail — edit', () => {
  const workspaceRoot = '/Users/dylan/rig-workspace';

  it('renders an in-workspace path relative, with the diff count as secondary', () => {
    const summary = summarizePermissionDetail(
      { kind: 'edit', path: `${workspaceRoot}/docs/forecast.md`, summary: '+3 −1' },
      workspaceRoot
    );
    expect(summary).toEqual({ headline: 'Wants to edit docs/forecast.md', secondary: '+3 −1' });
  });

  it('renders a delete distinctly, with no redundant secondary', () => {
    const summary = summarizePermissionDetail(
      { kind: 'edit', path: `${workspaceRoot}/docs/forecast.md`, summary: 'delete file' },
      workspaceRoot
    );
    expect(summary).toEqual({ headline: 'Wants to delete docs/forecast.md' });
  });

  it('keeps the path absolute when it is outside the given workspace root', () => {
    const summary = summarizePermissionDetail(
      { kind: 'edit', path: '/etc/hosts', summary: '+1 −1' },
      workspaceRoot
    );
    expect(summary.headline).toBe('Wants to edit /etc/hosts');
  });

  it('falls back to a generic phrasing when the edit carries no path', () => {
    expect(summarizePermissionDetail({ kind: 'edit', summary: '+1 −0' }).headline).toBe(
      'Wants to edit a file'
    );
  });
});

describe('summarizePermissionDetail — read', () => {
  const workspaceRoot = '/Users/dylan/rig-workspace';

  it('renders an in-workspace read relative, with no secondary needed', () => {
    const summary = summarizePermissionDetail(
      { kind: 'read', path: `${workspaceRoot}/docs/forecast.md` },
      workspaceRoot
    );
    expect(summary).toEqual({ headline: 'Wants to read docs/forecast.md' });
  });

  it('flags a read outside the workspace distinctly, with the real path as secondary', () => {
    const summary = summarizePermissionDetail(
      { kind: 'read', path: '/etc/passwd' },
      workspaceRoot
    );
    expect(summary).toEqual({
      headline: 'Wants to read a file outside this workspace',
      secondary: '/etc/passwd',
    });
  });

  it('treats an already-relative path as inside the workspace', () => {
    const summary = summarizePermissionDetail({ kind: 'read', path: 'README.md' }, workspaceRoot);
    expect(summary).toEqual({ headline: 'Wants to read README.md' });
  });

  it('falls back to a generic phrasing when the read carries no path', () => {
    expect(summarizePermissionDetail({ kind: 'read' }).headline).toBe('Wants to read a file');
  });
});

describe('summarizePermissionDetail — fetch', () => {
  it('names the host, keeping the full URL as secondary', () => {
    const summary = summarizePermissionDetail({
      kind: 'fetch',
      url: 'https://example.com/pricing?ref=agent',
    });
    expect(summary).toEqual({
      headline: 'Wants to fetch example.com',
      secondary: 'https://example.com/pricing?ref=agent',
    });
  });

  it('falls back to a generic phrasing for an unparseable URL, keeping it as secondary', () => {
    const summary = summarizePermissionDetail({ kind: 'fetch', url: 'not a url' });
    expect(summary).toEqual({ headline: 'Wants to fetch a web page', secondary: 'not a url' });
  });

  it('falls back to a generic phrasing when the fetch carries no URL', () => {
    expect(summarizePermissionDetail({ kind: 'fetch' }).headline).toBe('Wants to fetch a web page');
  });
});

describe('summarizePermissionDetail — fallback', () => {
  it('names the tool when the detail carries one', () => {
    expect(summarizePermissionDetail({ kind: 'other', name: 'notion-search' }).headline).toBe(
      'Wants to use notion-search'
    );
  });

  it('uses the safe generic fallback with no detail at all', () => {
    expect(summarizePermissionDetail(undefined).headline).toBe('Wants to use this tool');
  });

  it('uses the safe generic fallback for an "other" detail with no name', () => {
    expect(summarizePermissionDetail({ kind: 'other' }).headline).toBe('Wants to use this tool');
  });
});

describe('rawPermissionDetailText', () => {
  it('returns the exact command for execute, base64 target included', () => {
    const command = `"$RIG_CLI_PATH" context trace --target ${TARGET_REF} --json`;
    expect(rawPermissionDetailText({ kind: 'execute', command })).toBe(command);
  });

  it('joins path and summary for edit/read', () => {
    expect(
      rawPermissionDetailText({ kind: 'edit', path: 'docs/forecast.md', summary: '+3 −1' })
    ).toBe('docs/forecast.md  +3 −1');
    expect(rawPermissionDetailText({ kind: 'read', path: 'docs/forecast.md' })).toBe(
      'docs/forecast.md'
    );
  });

  it('returns the URL for fetch', () => {
    expect(rawPermissionDetailText({ kind: 'fetch', url: 'https://example.com' })).toBe(
      'https://example.com'
    );
  });

  it('returns null when there is nothing to show', () => {
    expect(rawPermissionDetailText(undefined)).toBeNull();
    expect(rawPermissionDetailText({ kind: 'execute' })).toBeNull();
    expect(rawPermissionDetailText({ kind: 'other' })).toBeNull();
  });
});

describe('alwaysAllowLabel', () => {
  it.each<[RigCommentPermissionDetail['kind'], string]>([
    ['execute', 'Always allow — applies to all commands this agent runs, beyond this thread'],
    ['edit', 'Always allow — applies to all edits this agent makes, beyond this thread'],
    ['read', 'Always allow — applies to all files this agent reads, beyond this thread'],
    ['fetch', 'Always allow — applies to all pages this agent fetches, beyond this thread'],
    ['other', 'Always allow — applies to everything this agent does, beyond this thread'],
  ])('is sober and scope-explicit for kind %s', (kind, expected) => {
    expect(alwaysAllowLabel({ kind })).toBe(expected);
  });

  it('is scope-explicit even with no detail at all', () => {
    expect(alwaysAllowLabel(undefined)).toBe(
      'Always allow — applies to everything this agent does, beyond this thread'
    );
  });
});
