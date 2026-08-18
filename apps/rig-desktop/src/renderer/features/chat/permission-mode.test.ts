import { describe, expect, it } from 'vitest';
import { decideModeSelect, isDangerousMode, shouldPersistMode } from './permission-mode';

describe('isDangerousMode', () => {
  it('flags the two confirmed-dangerous ids from the real adapters', () => {
    expect(isDangerousMode('bypassPermissions')).toBe(true); // claude-agent-acp
    expect(isDangerousMode('agent-full-access')).toBe(true); // codex-acp
  });

  it('does not flag any of Claude\'s other real modes', () => {
    expect(isDangerousMode('auto')).toBe(false);
    expect(isDangerousMode('default')).toBe(false);
    expect(isDangerousMode('acceptEdits')).toBe(false);
    expect(isDangerousMode('plan')).toBe(false);
    expect(isDangerousMode('dontAsk')).toBe(false);
  });

  it('does not flag any of Codex\'s other real modes', () => {
    expect(isDangerousMode('read-only')).toBe(false);
    expect(isDangerousMode('agent')).toBe(false);
  });

  it('an unrecognized id (an unbundled adapter, or a future mode) is honestly unclassified — no friction, not a guess', () => {
    expect(isDangerousMode('some-future-mode')).toBe(false);
    expect(isDangerousMode('')).toBe(false);
  });
});

describe('decideModeSelect', () => {
  it('a non-dangerous pick always applies immediately, regardless of any pending confirm', () => {
    expect(decideModeSelect('default', null)).toEqual({ kind: 'apply', modeId: 'default' });
    expect(decideModeSelect('plan', 'bypassPermissions')).toEqual({ kind: 'apply', modeId: 'plan' });
  });

  it('the FIRST pick on a dangerous mode arms the confirm step, never applies immediately', () => {
    expect(decideModeSelect('bypassPermissions', null)).toEqual({
      kind: 'confirm',
      modeId: 'bypassPermissions',
    });
    expect(decideModeSelect('agent-full-access', null)).toEqual({
      kind: 'confirm',
      modeId: 'agent-full-access',
    });
  });

  it('a SECOND pick on the SAME already-armed dangerous mode applies it', () => {
    expect(decideModeSelect('bypassPermissions', 'bypassPermissions')).toEqual({
      kind: 'apply',
      modeId: 'bypassPermissions',
    });
  });

  it('picking a DIFFERENT dangerous mode while another is armed re-arms the new one — never confirms the wrong mode off a stale click', () => {
    expect(decideModeSelect('agent-full-access', 'bypassPermissions')).toEqual({
      kind: 'confirm',
      modeId: 'agent-full-access',
    });
  });
});

describe('shouldPersistMode', () => {
  it('a dangerous mode is NEVER persisted — the whole point of the gate', () => {
    expect(shouldPersistMode('bypassPermissions')).toBe(false);
    expect(shouldPersistMode('agent-full-access')).toBe(false);
  });

  it('every real safe mode from both adapters persists', () => {
    expect(shouldPersistMode('auto')).toBe(true);
    expect(shouldPersistMode('default')).toBe(true);
    expect(shouldPersistMode('acceptEdits')).toBe(true);
    expect(shouldPersistMode('plan')).toBe(true);
    expect(shouldPersistMode('dontAsk')).toBe(true);
    expect(shouldPersistMode('read-only')).toBe(true);
    expect(shouldPersistMode('agent')).toBe(true);
  });

  it('an unrecognized id persists too — same "unknown is not dangerous" stance isDangerousMode already takes', () => {
    expect(shouldPersistMode('some-future-mode')).toBe(true);
  });
});
