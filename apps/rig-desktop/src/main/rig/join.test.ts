import { afterEach, describe, expect, it, vi } from 'vitest';

// C4: `outdatedCliMessage` (inside `classifyAttachFailure`) branches on
// `app.isPackaged` — mocked as a mutable object so individual tests can
// flip it, matching the convention other main-process tests use for
// `electron`'s `app` (e.g. `core/app/service.test.ts`).
const mockApp = vi.hoisted(() => ({ isPackaged: false }));
vi.mock('electron', () => ({ app: mockApp }));

import { classifyAttachFailure, deriveLocateOutcome, parseAttachSuccess } from './join';

afterEach(() => {
  mockApp.isPackaged = false;
});

describe('deriveLocateOutcome', () => {
  it('no binding config found at (or above) the picked directory — notFound', () => {
    expect(deriveLocateOutcome('bnd_target', null)).toEqual({ kind: 'notFound' });
  });

  it('a binding config found, matching the expected bindingId — matched, with the real workspace root', () => {
    expect(
      deriveLocateOutcome('bnd_target', { bindingId: 'bnd_target', workspaceRoot: '/Users/dylan/rigs/my-rig' })
    ).toEqual({ kind: 'matched', localPath: '/Users/dylan/rigs/my-rig' });
  });

  it('a binding config found for a DIFFERENT binding — mismatch, naming what was actually found', () => {
    expect(
      deriveLocateOutcome('bnd_target', { bindingId: 'bnd_other', workspaceRoot: '/Users/dylan/rigs/wrong-one' })
    ).toEqual({ kind: 'mismatch', foundBindingId: 'bnd_other' });
  });
});

describe('classifyAttachFailure', () => {
  it('an old CLI without `attach` — outdatedCli, with the honest upgrade instruction (dev build: the npm command is real advice, `resolveCliBin` falls back to PATH)', () => {
    const stdout =
      '{"protocolVersion":1,"error":{"code":"error","message":"Unknown command \\"attach\\". Run rig help."}}\n';
    expect(classifyAttachFailure(stdout, '', 1)).toEqual({
      kind: 'outdatedCli',
      message: 'Setting up rigs from the app needs a newer rig CLI. Update with: npm i -g @rigxyz/cli',
    });
  });

  it('C4 — a PACKAGED build gets an app-update message instead: the npm command can never work there (bundled-first resolution, PATH never consulted)', () => {
    mockApp.isPackaged = true;
    const stdout =
      '{"protocolVersion":1,"error":{"code":"error","message":"Unknown command \\"attach\\". Run rig help."}}\n';
    expect(classifyAttachFailure(stdout, '', 1)).toEqual({
      kind: 'outdatedCli',
      message: 'This version of Rig needs an update to set up rigs this way.',
    });
  });

  it('the unknown-command text alone (no JSON envelope, an even older CLI) — still outdatedCli', () => {
    expect(classifyAttachFailure('', 'Unknown command "attach". Run rig help.', 1)).toEqual({
      kind: 'outdatedCli',
      message: 'Setting up rigs from the app needs a newer rig CLI. Update with: npm i -g @rigxyz/cli',
    });
  });

  it('a similarly-worded but genuinely different message never trips the outdated-CLI classifier', () => {
    const stdout = '{"protocolVersion":1,"error":{"code":"not_a_member","message":"attach: unknown binding."}}\n';
    expect(classifyAttachFailure(stdout, '', 1)).toEqual({
      kind: 'notAMember',
      message: 'attach: unknown binding.',
    });
  });

  it('not_logged_in envelope — notSignedIn, carrying the CLI\'s own message', () => {
    const stdout = '{"protocolVersion":1,"error":{"code":"not_logged_in","message":"Not signed in to Rig Hub. Run `rig login` first."}}\n';
    expect(classifyAttachFailure(stdout, '', 1)).toEqual({
      kind: 'notSignedIn',
      message: 'Not signed in to Rig Hub. Run `rig login` first.',
    });
  });

  it('not_a_member envelope — notAMember, carrying the CLI\'s own message', () => {
    const stdout =
      '{"protocolVersion":1,"error":{"code":"not_a_member","message":"You\'re not a member of this rig. Ask the owner to invite you."}}\n';
    expect(classifyAttachFailure(stdout, '', 1)).toEqual({
      kind: 'notAMember',
      message: "You're not a member of this rig. Ask the owner to invite you.",
    });
  });

  it('an unrecognized error code in the envelope — attachFailed, still carrying the CLI\'s message', () => {
    const stdout = '{"protocolVersion":1,"error":{"code":"relay_unreachable","message":"Could not reach the relay."}}\n';
    expect(classifyAttachFailure(stdout, '', 1)).toEqual({
      kind: 'attachFailed',
      message: 'Could not reach the relay.',
    });
  });

  it('no JSON envelope at all — attachFailed, falling back to the last non-empty output line', () => {
    expect(classifyAttachFailure('', 'boom: something broke\n', 1)).toEqual({
      kind: 'attachFailed',
      message: 'boom: something broke',
    });
  });
});

describe('parseAttachSuccess', () => {
  it('reads dir/rigName/syncing off the CLI\'s --json envelope', () => {
    const stdout = JSON.stringify({
      protocolVersion: 1,
      bindingId: 'bnd_1',
      device: { id: 'dev_1', label: 'MacBook' },
      tokenSecret: 'tok_x',
      becameMember: true,
      dir: '/Users/dylan/Rigs/my-rig',
      rigName: 'My Rig',
      syncing: true,
      daemon: { outcome: 'started', pid: 123 },
    });
    expect(parseAttachSuccess(stdout, '/fallback')).toEqual({
      localPath: '/Users/dylan/Rigs/my-rig',
      rigName: 'My Rig',
      syncing: true,
    });
  });

  it('falls back to the target dir and null rigName when those fields are missing', () => {
    expect(parseAttachSuccess('{"protocolVersion":1}', '/fallback')).toEqual({
      localPath: '/fallback',
      rigName: null,
      syncing: false,
    });
  });

  it('unparseable output — null, not a thrown error', () => {
    expect(parseAttachSuccess('not json', '/fallback')).toBeNull();
  });
});
