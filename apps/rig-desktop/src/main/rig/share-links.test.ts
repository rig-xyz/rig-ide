import { describe, expect, it } from 'vitest';
import { relayError, toShareLink } from './share-links';

describe('toShareLink', () => {
  it('parses a full share-link row', () => {
    expect(
      toShareLink({
        id: 'shl_1',
        bindingId: 'bnd_1',
        relPath: 'docs/spec.md',
        permission: 'comment',
        createdBy: 'usr_1',
        createdAt: '2026-01-01T00:00:00Z',
        revokedAt: null,
      })
    ).toEqual({
      id: 'shl_1',
      bindingId: 'bnd_1',
      relPath: 'docs/spec.md',
      permission: 'comment',
      createdBy: 'usr_1',
      createdAt: '2026-01-01T00:00:00Z',
      revokedAt: null,
    });
  });

  it('degrades an unrecognized permission to "read" rather than dropping the row', () => {
    expect(toShareLink({ id: 'shl_1', permission: 'weird' })?.permission).toBe('read');
    expect(toShareLink({ id: 'shl_1' })?.permission).toBe('read');
  });

  it('keeps a real revokedAt timestamp', () => {
    expect(toShareLink({ id: 'shl_1', revokedAt: '2026-02-01T00:00:00Z' })?.revokedAt).toBe(
      '2026-02-01T00:00:00Z'
    );
  });

  it('returns null for a shape with no id', () => {
    expect(toShareLink({})).toBeNull();
    expect(toShareLink(null)).toBeNull();
    expect(toShareLink('nope')).toBeNull();
  });
});

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status });
}

describe('relayError', () => {
  it('a 403 is always "forbidden" — the viewer-role-not-editor case', async () => {
    const error = await relayError(jsonResponse(403, { error: 'forbidden' }), 'create the share link');
    expect(error).toEqual({
      kind: 'forbidden',
      message: 'You need editor access on this rig to manage share links.',
    });
  });

  it('a 404 with code "path_not_found" names the untracked-file case specifically', async () => {
    const error = await relayError(jsonResponse(404, { error: 'path_not_found' }), 'create the share link');
    expect(error).toEqual({
      kind: 'notFound',
      message: "This file isn't tracked by the rig yet — save and sync it first.",
    });
  });

  it('a 404 with any other (or no) code is a generic not-found', async () => {
    const error = await relayError(jsonResponse(404, { error: 'not_found' }), 'revoke the share link');
    expect(error).toEqual({ kind: 'notFound', message: 'Could not revoke the share link — not found.' });
  });

  it('every other status falls back to the generic relay kind, status preserved', async () => {
    const error = await relayError(jsonResponse(429, { error: 'rate_limited' }), 'create the share link');
    expect(error).toEqual({
      kind: 'relay',
      status: 429,
      message: 'Could not create the share link (relay: rate_limited).',
    });
  });

  it('a non-JSON body still produces a message, from the status alone', async () => {
    const error = await relayError(new Response('not json', { status: 500 }), 'load share links');
    expect(error).toEqual({
      kind: 'relay',
      status: 500,
      message: 'Could not load share links (relay 500).',
    });
  });
});
