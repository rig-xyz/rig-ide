import { describe, expect, it } from 'vitest';
import { deriveMintedDisplay, deriveRevokeTarget, needsRemint, type MintedLink } from './share-mint-state';

const READ_LINK: MintedLink = { id: 'shl_1', permission: 'read', url: 'https://userig.xyz/a/tok1' };
const COMMENT_LINK: MintedLink = { id: 'shl_2', permission: 'comment', url: 'https://userig.xyz/a/tok2' };

describe('needsRemint', () => {
  it('false when nothing is minted yet — nothing to replace', () => {
    expect(needsRemint(null, 'read')).toBe(false);
    expect(needsRemint(null, 'comment')).toBe(false);
  });

  it('false when the new selection matches the minted link\'s own permission', () => {
    expect(needsRemint(READ_LINK, 'read')).toBe(false);
    expect(needsRemint(COMMENT_LINK, 'comment')).toBe(false);
  });

  it('true when the new selection differs from the minted link\'s permission', () => {
    expect(needsRemint(READ_LINK, 'comment')).toBe(true);
    expect(needsRemint(COMMENT_LINK, 'read')).toBe(true);
  });
});

describe('deriveMintedDisplay', () => {
  it('nothing minted, not reminting — none', () => {
    expect(deriveMintedDisplay(null, 'read', false)).toEqual({ kind: 'none' });
  });

  it('a minted link whose permission matches the current selection — shown', () => {
    expect(deriveMintedDisplay(READ_LINK, 'read', false)).toEqual({ kind: 'link', link: READ_LINK });
  });

  it('the core fix: a minted link whose permission no longer matches the selection is NEVER shown, even before a re-mint starts', () => {
    expect(deriveMintedDisplay(READ_LINK, 'comment', false)).toEqual({ kind: 'none' });
  });

  it('reminting always wins — "updating…", never the stale URL, never a not-yet-real new one', () => {
    expect(deriveMintedDisplay(READ_LINK, 'comment', true)).toEqual({ kind: 'updating' });
    expect(deriveMintedDisplay(null, 'read', true)).toEqual({ kind: 'updating' });
    expect(deriveMintedDisplay(READ_LINK, 'read', true)).toEqual({ kind: 'updating' });
  });
});

describe('deriveRevokeTarget', () => {
  it('a first-time mint (no staleId) never revokes anything', () => {
    expect(deriveRevokeTarget(null, 'comment', 'comment', 'shl_fresh')).toBeNull();
    expect(deriveRevokeTarget(null, 'comment', 'read', 'shl_fresh')).toBeNull();
  });

  it('the ordinary case — current selection still matches what this mint was FOR: revoke the old (stale) link', () => {
    expect(deriveRevokeTarget('shl_1', 'comment', 'comment', 'shl_fresh')).toEqual({ id: 'shl_1' });
  });

  it("A3(a) — the user toggled back to the OLD link's own permission while the re-mint was in flight: revoke the fresh mint instead, never the one matching current selection", () => {
    // Re-mint was for 'comment' (replacing a 'read' link, shl_1), but by
    // the time it resolves the user has toggled back to 'read' — shl_1 is
    // exactly what's wanted now, and must survive.
    expect(deriveRevokeTarget('shl_1', 'comment', 'read', 'shl_fresh')).toEqual({ id: 'shl_fresh' });
  });

  it('symmetric case — re-mint was for "read", user toggled back to "comment" before it resolved', () => {
    expect(deriveRevokeTarget('shl_2', 'read', 'comment', 'shl_fresh')).toEqual({ id: 'shl_fresh' });
  });
});
