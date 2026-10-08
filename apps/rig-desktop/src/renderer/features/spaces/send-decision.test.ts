import { describe, expect, it } from 'vitest';
import { decideSend, routeFromPreview, type ComposerRoute } from './send-decision';

const base = {
  text: 'can you look at the churn numbers',
  ownAgents: ['claude', 'codex'] as const,
  tagged: null,
  pill: null,
  route: null,
  override: null,
  replying: false,
};
const asks: ComposerRoute = { action: 'ask', agent: 'claude' };
const suggests: ComposerRoute = { action: 'suggest', agent: 'claude' };
const none: ComposerRoute = { action: 'none', agent: null };

describe('decideSend', () => {
  it('an @tag of your agent asks it, whatever the relay says', () => {
    expect(decideSend({ ...base, tagged: 'codex', route: asks })).toEqual({ label: 'Ask Codex', mode: 'ask', agent: 'codex', meta: {} });
  });

  it("asks your agent when the relay's routing says ask", () => {
    expect(decideSend({ ...base, route: asks })).toEqual({ label: 'Ask Claude', mode: 'ask', agent: 'claude', meta: {} });
  });

  it('a suggest, a none or no routing at all (older relay) is a plain send', () => {
    for (const route of [suggests, none, null]) {
      expect(decideSend({ ...base, route })).toEqual({ label: 'Send', mode: 'send', agent: null, meta: {} });
    }
    expect(decideSend({ ...base, replying: true }).label).toBe('Reply');
  });

  it('never asks an agent that is not yours', () => {
    expect(decideSend({ ...base, ownAgents: ['codex'], route: asks }).mode).toBe('send');
    expect(decideSend({ ...base, ownAgents: ['codex'], override: { kind: 'agent', agent: 'claude' } }).mode).toBe('send');
  });

  it('an agent of yours this Mac can\'t run is a plain send, kept from the router, and named', () => {
    expect(decideSend({ ...base, runnable: ['codex'], tagged: 'claude' })).toEqual({
      label: 'Send',
      mode: 'send',
      agent: null,
      meta: { route: 'none' },
      unavailable: 'claude',
    });
    expect(decideSend({ ...base, runnable: [], route: asks })).toMatchObject({ mode: 'send', unavailable: 'claude' });
    expect(decideSend({ ...base, runnable: [], pill: 'claude' })).toMatchObject({ mode: 'send', unavailable: 'claude' });
    expect(decideSend({ ...base, runnable: ['codex'], override: { kind: 'agent', agent: 'claude' } }).mode).toBe('send');
    // One it can run still asks.
    expect(decideSend({ ...base, runnable: ['codex'], tagged: 'codex' })).toMatchObject({ mode: 'ask', agent: 'codex' });
  });

  it('the no-@ pill (a reply to its turn, or its name first) asks its agent', () => {
    expect(decideSend({ ...base, pill: 'claude', route: none })).toMatchObject({ mode: 'ask', agent: 'claude' });
  });

  it('picking Send while the relay would ask or suggest marks the message route none', () => {
    expect(decideSend({ ...base, route: asks, override: { kind: 'send' } })).toEqual({
      label: 'Send',
      mode: 'send',
      agent: null,
      meta: { route: 'none' },
    });
    expect(decideSend({ ...base, route: suggests, override: { kind: 'send' } }).meta).toEqual({ route: 'none' });
    // Nothing to tell the router when it wouldn't have acted, or doesn't route.
    expect(decideSend({ ...base, route: none, override: { kind: 'send' } }).meta).toEqual({});
    expect(decideSend({ ...base, pill: 'claude', override: { kind: 'send' } })).toMatchObject({ mode: 'send', meta: {} });
  });

  it('picking an agent asks it, even when the relay said none', () => {
    expect(decideSend({ ...base, route: none, override: { kind: 'agent', agent: 'codex' } })).toEqual({
      label: 'Ask Codex',
      mode: 'ask',
      agent: 'codex',
      meta: {},
    });
    expect(decideSend({ ...base, pill: 'claude', override: { kind: 'agent', agent: 'codex' } }).agent).toBe('codex');
  });

  it('an empty draft is just Send', () => {
    expect(decideSend({ ...base, text: '  ', route: asks, override: { kind: 'agent', agent: 'claude' } })).toEqual({
      label: 'Send',
      mode: 'send',
      agent: null,
      meta: {},
    });
  });
});

describe('routeFromPreview', () => {
  const recipient = { kind: 'agent' as const, agentId: 'ag1', agent: 'codex' as const, ownerUserId: 'me' };
  const preview = { answersTo: null, agent: null, confidence: 0 };

  it('is null from a relay that does not route', () => {
    expect(routeFromPreview(preview, 'me')).toBeNull();
  });

  it('reads ask and suggest for your own agent', () => {
    expect(routeFromPreview({ ...preview, recipient, action: 'ask' }, 'me')).toEqual({ action: 'ask', agent: 'codex' });
    expect(routeFromPreview({ ...preview, recipient, action: 'suggest' }, 'me')).toEqual({ action: 'suggest', agent: 'codex' });
  });

  it("reads anything about someone else's agent, or a person, as none", () => {
    expect(routeFromPreview({ ...preview, recipient, action: 'ask' }, 'someone-else')).toEqual({ action: 'none', agent: null });
    expect(routeFromPreview({ ...preview, recipient: { kind: 'person', userId: 'u2' }, action: 'none' }, 'me')).toEqual({
      action: 'none',
      agent: null,
    });
  });
});
