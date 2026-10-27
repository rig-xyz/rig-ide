import { describe, expect, it, vi } from 'vitest';
import { readSnapshot } from './snapshot';

describe('readSnapshot', () => {
  it("lists the Feed, the open situations and GitHub's open asks, one line each", async () => {
    const query = vi.fn(async (kind: string) =>
      kind === 'feed'
        ? { success: true as const, data: { kind, rows: [{ ref: 'sit_1', title: 'Review #212', state: 'visible', decision: 'ask_you 0.90' }] } }
        : { success: true as const, data: { kind, rows: [{ ref: 'sit_1', title: 'Rate limits PR', topic: 'API', decision: 'ask_you', feed: 'visible', people: ['Tom Becker'], line: 'Tom asked for a review.' }] } }
    );
    const github = vi.fn(async () => ({ success: true as const, data: JSON.stringify([{ repository: { nameWithOwner: 'acme/api' }, number: 212, title: 'Rate limits', author: { login: 'tom' }, updatedAt: '2026-10-24T09:00:00Z' }]) }));
    const s = await readSnapshot(query, github);
    expect(s).toEqual({
      github: ['github:acme/api#212 "Rate limits" by tom, updated 2026-10-24T09:00:00Z'],
      feed: ['sit_1 [visible] "Review #212" · ask_you 0.90'],
      situations: ['sit_1 "Rate limits PR" · API · do ask_you · feed visible · Tom Becker · Tom asked for a review.'],
    });
    expect(github).toHaveBeenCalledWith(expect.stringMatching(/^gh search prs --review-requested=@me/));
  });

  it("is null when Rig's state can't be read, and leaves GitHub out when gh can't", async () => {
    expect(await readSnapshot(async () => ({ success: false as const }))).toBeNull();
    const ok = async (kind: string) => ({ success: true as const, data: { kind, rows: [] } });
    expect((await readSnapshot(ok, async () => ({ success: false as const })))?.github).toBeNull();
  });
});
