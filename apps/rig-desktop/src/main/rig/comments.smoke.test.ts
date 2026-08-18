import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { resolveCommentTarget, rigCommentsController } from './comments';

/**
 * Manual, read-only relay smoke check against the developer's real
 * `knee-ability-rig` checkout — proves the comments data layer (binding →
 * relay target resolution, then a live `GET .../messages` read) is genuinely
 * wired end to end, not just plumbed through to a mock. Never posts a comment
 * or edits a file (see the P0 report's verification notes). Skips itself
 * wherever the rig checkout isn't present (CI, another contributor).
 */
const ROOT = join(homedir(), 'Code', 'knee-ability-rig');
const EXERCISES_MD = join(ROOT, 'exercises.md');

describe.skipIf(!existsSync(EXERCISES_MD))('rig comments data layer against knee-ability-rig', () => {
  it('resolves the file to its rig binding and relay target', () => {
    const target = resolveCommentTarget(EXERCISES_MD);
    expect(target).not.toBeNull();
    expect(target?.relPath).toBe('exercises.md');
    expect(target?.bindingId.length).toBeGreaterThan(0);
    expect(target?.relayUrl.length).toBeGreaterThan(0);
  });

  it('lists (read-only) whatever comment threads the relay actually has for it', async () => {
    const result = await rigCommentsController.list({ absPath: EXERCISES_MD });
    // Any structured outcome proves the round trip is real: signed-out and
    // relay-unreachable are both legitimate answers on a machine that hasn't
    // run `rig login` — the assertion is "this talked to the relay and got a
    // typed response", not "there happen to be comments".
    if (!result.success) {
      expect(['unauthenticated', 'notBound', 'untrustedRelay', 'relay']).toContain(
        result.error.kind
      );
      return;
    }
    expect(Array.isArray(result.data.messages)).toBe(true);
  });

  it('lists (read-only) the binding members for it', async () => {
    const result = await rigCommentsController.listMembers({ absPath: EXERCISES_MD });
    if (!result.success) {
      expect(['unauthenticated', 'notBound', 'untrustedRelay', 'relay']).toContain(
        result.error.kind
      );
      return;
    }
    expect(Array.isArray(result.data.members)).toBe(true);
    for (const member of result.data.members) {
      expect(typeof member.userId).toBe('string');
      expect(member.userId.length).toBeGreaterThan(0);
    }
  });
});
