import { describe, expect, it } from 'vitest';
import { FIRST_WIN_CARDS } from './fixtures';
import { firstWinOrder, firstWinReducer, frontOf, initialFirstWin } from './first-win-model';

const [reply, review, fix] = FIRST_WIN_CARDS;

describe('First win', () => {
  it('shows a drafted answer first, then what needs you, then the rest', () => {
    const undrafted = { ...review!, id: 'plain', choices: [{ ...review!.choices[0]!, verb: 'reply' as const, draft: undefined }] };
    expect(firstWinOrder([fix!, undrafted, reply!]).map((i) => i.id)).toEqual(['sim:reply', 'plain', 'sim:fix']);
  });

  it('a sent card is the win: done, and nothing else moves after it', () => {
    let s = firstWinReducer(initialFirstWin, { type: 'loaded', items: [reply!, review!, fix!] });
    s = firstWinReducer(s, { type: 'pick', choiceId: 'c1', slide: 'left' });
    s = firstWinReducer(s, { type: 'edit-draft', text: 'Friday at 10?' });
    expect(frontOf(s)).toMatchObject({ pick: 'c1', draftEdit: 'Friday at 10?' });
    s = firstWinReducer(s, { type: 'starting' });
    s = firstWinReducer(s, { type: 'failed', error: 'Slack said no' });
    expect(frontOf(s)).toMatchObject({ starting: false, failed: 'Slack said no' });
    s = firstWinReducer(s, { type: 'sent', result: { said: 'Sent in #product', link: null } });
    expect(s.done.map((e) => [e.item.id, e.sent?.said])).toEqual([['sim:reply', 'Sent in #product']]);
    expect(s.won).toBe(true);
    // Won: the rest wait on the Feed, and the controls do nothing.
    expect(firstWinReducer(s, { type: 'step', by: 1 })).toBe(s);
  });

  it('‹ › cycle through the cards round the end; Not now drops the front one; a new choice drops the edits', () => {
    let s = firstWinReducer(initialFirstWin, { type: 'loaded', items: [reply!, review!, fix!] });
    s = firstWinReducer(s, { type: 'step', by: 1 });
    expect([frontOf(s)!.item.id, s.at]).toEqual(['sim:review', 1]);
    expect(frontOf(s)!.fresh).toBe(true);
    s = firstWinReducer(s, { type: 'step', by: -1 });
    s = firstWinReducer(s, { type: 'step', by: -1 });
    expect([frontOf(s)!.item.id, s.at]).toEqual(['sim:fix', 2]);
    s = firstWinReducer(s, { type: 'edit-draft', text: 'x' });
    s = firstWinReducer(s, { type: 'pick', choiceId: 'c0', slide: 'left' });
    expect(frontOf(s)!.draftEdit).toBeNull();
    // The last one dropped: round to the first.
    s = firstWinReducer(s, { type: 'drop' });
    expect([s.cards!.map((e) => e.item.id), s.at]).toEqual([['sim:reply', 'sim:review'], 0]);
    s = firstWinReducer(s, { type: 'drop' });
    // One card left: nothing to cycle to.
    expect(firstWinReducer(s, { type: 'step', by: 1 })).toBe(s);
  });

  it('cards that land while it reads join the end, and the one in front stays', () => {
    let s = firstWinReducer(initialFirstWin, { type: 'loaded', items: [review!] });
    s = firstWinReducer(s, { type: 'loaded', items: [review!, fix!, reply!] });
    expect([s.cards!.map((e) => e.item.id), s.at]).toEqual([['sim:review', 'sim:reply', 'sim:fix'], 0]);
    // Read again with nothing new: nothing changes.
    expect(firstWinReducer(s, { type: 'loaded', items: [reply!] })).toBe(s);
  });
});
