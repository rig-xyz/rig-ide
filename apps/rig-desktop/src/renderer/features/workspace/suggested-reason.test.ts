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

  it('a fresh card less than a day old reads "New today"', () => {
    const now = 1_000_000_000;
    const card: Card = { type: 'fresh', relPath: 'new.md', at: now - 60_000 };
    expect(reasonForCard(card, now)).toEqual({ text: 'New today', pulsing: false });
  });

  it('a fresh card a day or more old reads "Updated <relative time>"', () => {
    const now = 1_000_000_000;
    const twoDaysMs = 2 * 24 * 60 * 60 * 1000;
    const card: Card = { type: 'fresh', relPath: 'old.md', at: now - twoDaysMs };
    expect(reasonForCard(card, now)).toEqual({ text: 'Updated 2d ago', pulsing: false });
  });

  it('a pinned card that also has a known recency follows the same age rule as fresh', () => {
    const now = 1_000_000_000;
    const card: Card = { type: 'pinned', relPath: 'pinned.md', at: now - 30_000 };
    expect(reasonForCard(card, now)).toEqual({ text: 'New today', pulsing: false });
  });
});
