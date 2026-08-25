import { describe, expect, it } from 'vitest';
import type { Card } from '@shared/rig/card-rail';
import { reasonForCard } from './suggested-reason';

describe('reasonForCard', () => {
  it('an in-progress card always reads "Agent editing now", pulsing, regardless of recency', () => {
    const card: Card = { type: 'in-progress', relPath: 'draft.md', at: 0, sessionId: 's1' };
    expect(reasonForCard(card, 1_000_000)).toEqual({ text: 'Agent editing now', pulsing: true });
  });

  it('a pinned card with no other signal reads "Pinned"', () => {
    const card: Card = { type: 'pinned', relPath: 'quiet.md' };
    expect(reasonForCard(card, 1_000_000)).toEqual({ text: 'Pinned', pulsing: false });
  });

  it('a fresh card shows its actual recency, never a vague "new" label', () => {
    const now = 1_000_000_000;
    const card: Card = { type: 'fresh', relPath: 'new.md', at: now - 60_000 };
    expect(reasonForCard(card, now)).toEqual({ text: 'Updated 1m ago', pulsing: false });
  });

  it('an older fresh card reads "Updated <relative time>" too', () => {
    const now = 1_000_000_000;
    const twoDaysMs = 2 * 24 * 60 * 60 * 1000;
    const card: Card = { type: 'fresh', relPath: 'old.md', at: now - twoDaysMs };
    expect(reasonForCard(card, now)).toEqual({ text: 'Updated 2d ago', pulsing: false });
  });

  it('a pinned card that also has a known recency shows that recency like fresh does', () => {
    const now = 1_000_000_000;
    const card: Card = { type: 'pinned', relPath: 'pinned.md', at: now - 30_000 };
    expect(reasonForCard(card, now)).toEqual({ text: 'Updated now', pulsing: false });
  });
});
