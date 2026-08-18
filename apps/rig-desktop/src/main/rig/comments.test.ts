import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { resolveCommentTarget, resolveCommentWorkspaceRoot, toMessage } from './comments';

/**
 * Pure resolution-logic coverage for the P0 fix: `askAgent`'s dispatch cwd
 * now comes from the file itself (`resolveCommentWorkspaceRoot`), not from
 * emdash's task/workspace registry.
 *
 * Deliberately tests `comments.ts` directly rather than importing
 * `rigCommentAgentController` from `comment-agent.ts`: that module's static
 * imports reach `agent-hook-service.ts` → `@main/db/client`, which touches
 * `electron.app.getPath()` and opens a real SQLite connection at import
 * time — Electron-app-only wiring this plain-Node vitest project doesn't
 * have (other main-process tests that need it mock all of `electron`; doing
 * that just to reach two guard-clause returns would trade a "pure resolution
 * logic" test for a heavier, DB-touching one). `askAgent`'s `notBound` branch
 * is a direct, unconditional `return err(...)` off `resolveCommentTarget`/
 * `resolveCommentWorkspaceRoot` (see `comment-agent.ts`), so proving those two
 * agree — both null for the same unbound path — proves that branch correct
 * without needing to spawn anything or touch the DB.
 */

let tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
  tempDirs = [];
});

/** A minimal bound-rig fixture: `.rig/tap-binding.local.json` + a nested file. */
function makeBoundRig(): { root: string; file: string } {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'rig-comment-agent-')));
  tempDirs.push(root);
  mkdirSync(join(root, '.rig'), { recursive: true });
  writeFileSync(
    join(root, '.rig', 'tap-binding.local.json'),
    JSON.stringify({
      bindingId: 'binding-test-1',
      relayUrl: 'https://relay.example.test',
      deviceId: 'device-test-1',
      token: 'tap_cap_test',
    })
  );
  mkdirSync(join(root, 'docs'), { recursive: true });
  const file = join(root, 'docs', 'spec.md');
  writeFileSync(file, '# Spec\n');
  return { root, file };
}

describe('resolveCommentWorkspaceRoot', () => {
  it('resolves a file under a bound rig to that rig\'s workspace root — the agent dispatch cwd', () => {
    const { root, file } = makeBoundRig();
    expect(resolveCommentWorkspaceRoot(file)).toBe(root);
  });

  it('returns null for a file outside any rig binding', () => {
    const outside = realpathSync(mkdtempSync(join(tmpdir(), 'rig-comment-agent-unbound-')));
    tempDirs.push(outside);
    const file = join(outside, 'notes.md');
    writeFileSync(file, 'hello\n');
    expect(resolveCommentWorkspaceRoot(file)).toBeNull();
  });
});

describe('askAgent\'s notBound branch, via the resolvers it is a direct return off of', () => {
  it('agrees with resolveCommentTarget: an unbound path fails the same way for both', () => {
    // `askAgent` (comment-agent.ts) does:
    //   const target = resolveCommentTarget(absPath);
    //   if (!target) return err({ kind: 'notBound', message: "This workspace isn't synced to a rig" });
    //   ...
    //   const cwd = resolveCommentWorkspaceRoot(absPath);
    //   if (!cwd) return err({ kind: 'notBound', message: "This workspace isn't synced to a rig" });
    // Both guards are unconditional returns off these two resolvers, so an
    // unbound path producing null from both — proven here — is what makes
    // askAgent's error clean and structured, with nothing session-shaped
    // reached in between.
    const outside = realpathSync(mkdtempSync(join(tmpdir(), 'rig-comment-agent-unbound-')));
    tempDirs.push(outside);
    const file = join(outside, 'notes.md');
    writeFileSync(file, 'hello\n');

    expect(resolveCommentTarget(file)).toBeNull();
    expect(resolveCommentWorkspaceRoot(file)).toBeNull();
  });

  it('agrees with resolveCommentTarget on the bound case too: same root behind both', () => {
    const { root, file } = makeBoundRig();
    expect(resolveCommentTarget(file)).toEqual({
      bindingId: 'binding-test-1',
      relayUrl: 'https://relay.example.test',
      relPath: 'docs/spec.md',
    });
    expect(resolveCommentWorkspaceRoot(file)).toBe(root);
  });
});

/** A minimal raw relay message payload, with `author` overridable per test. */
function rawMessage(author: unknown): unknown {
  return {
    id: 'm1',
    seq: '1',
    bindingId: 'binding-1',
    author,
    kind: 'text',
    body: 'hello',
    createdAt: '2026-08-15T00:00:00Z',
  };
}

describe('toMessage: author.kind coercion (guest authorship)', () => {
  it('carries a guest row through as-is — the third, literal case', () => {
    const message = toMessage(
      rawMessage({ userId: null, name: 'Alex the reviewer', avatarUrl: null, kind: 'guest' })
    );
    expect(message?.author).toEqual({
      userId: null,
      name: 'Alex the reviewer',
      avatarUrl: null,
      kind: 'guest',
    });
  });

  it('still recognizes agent authorship, unaffected by the new case', () => {
    const message = toMessage(
      rawMessage({ userId: 'u1', name: 'Dylan', avatarUrl: null, kind: 'agent' })
    );
    expect(message?.author.kind).toBe('agent');
  });

  it('an old-deploy relay that never sends `kind: "guest"` still coerces to user — no client-side guessing', () => {
    // The defensive case: a share-link comment from a relay that hasn't
    // shipped guest support yet arrives shaped exactly like a member's —
    // this must render as one, not be second-guessed into a fake guest.
    const message = toMessage(
      rawMessage({ userId: null, name: 'Someone', avatarUrl: null, kind: 'user' })
    );
    expect(message?.author.kind).toBe('user');
  });

  it('an unrecognized or missing kind also falls back to user, same as before this change', () => {
    expect(toMessage(rawMessage({ name: 'No kind field' }))?.author.kind).toBe('user');
    expect(toMessage(rawMessage(undefined))?.author.kind).toBe('user');
  });

  it('a guest author keeps its own name/avatarUrl fields verbatim — no member enrichment happens here', () => {
    const message = toMessage(
      rawMessage({ userId: null, name: 'Guest Name', avatarUrl: 'https://example.test/a.png', kind: 'guest' })
    );
    expect(message?.author.name).toBe('Guest Name');
    expect(message?.author.avatarUrl).toBe('https://example.test/a.png');
  });
});
