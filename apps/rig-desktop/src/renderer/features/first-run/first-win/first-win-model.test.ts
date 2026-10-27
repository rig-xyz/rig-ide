import { describe, expect, it } from 'vitest';
import { FIRST_WIN_CARDS } from './fixtures';
import { firstWinOrder, firstWinReducer, initialFirstWin } from './first-win-model';

const [reply, review, fix] = FIRST_WIN_CARDS;

describe('First win', () => {
  it('shows a drafted answer first, then what needs you, then the rest', () => {
    const undrafted = { ...review!, id: 'plain', choices: [{ ...review!.choices[0]!, verb: 'reply' as const, draft: undefined }] };
    expect(firstWinOrder([fix!, undrafted, reply!]).map((i) => i.id)).toEqual(['sim:reply', 'plain', 'sim:fix']);
  });

  it('moves a sent card above, done, and brings the next one forward', () => {
    let s = firstWinReducer(initialFirstWin, { type: 'loaded', items: [reply!, review!, fix!] });
    s = firstWinReducer(s, { type: 'pick', choiceId: 'c1', slide: 'left' });
    s = firstWinReducer(s, { type: 'edit-draft', text: 'Friday at 10?' });
    expect(s.queue![0]).toMatchObject({ pick: 'c1', draftEdit: 'Friday at 10?' });
    s = firstWinReducer(s, { type: 'starting' });
    s = firstWinReducer(s, { type: 'failed', error: 'Slack said no' });
    expect(s.queue![0]).toMatchObject({ starting: false, failed: 'Slack said no' });
    s = firstWinReducer(s, { type: 'sent', result: { said: 'Sent in #product', link: null } });
    expect(s.done.map((e) => [e.item.id, e.sent?.said])).toEqual([['sim:reply', 'Sent in #product']]);
    expect(s.queue!.map((e) => e.item.id)).toEqual(['sim:review', 'sim:fix']);
    expect(s.queue![0]!.fresh).toBe(true);
    expect(s.front).toBe('next');
  });

  it('Show me another sends the front card to the back; Not now drops it; a new choice drops the edits', () => {
    let s = firstWinReducer(initialFirstWin, { type: 'loaded', items: [reply!, review!] });
    s = firstWinReducer(s, { type: 'another' });
    expect(s.queue!.map((e) => e.item.id)).toEqual(['sim:review', 'sim:reply']);
    expect(s.front).toBe('another');
    s = firstWinReducer(s, { type: 'edit-draft', text: 'x' });
    s = firstWinReducer(s, { type: 'pick', choiceId: 'c1', slide: 'left' });
    expect(s.queue![0]!.draftEdit).toBeNull();
    s = firstWinReducer(s, { type: 'drop' });
    expect(s.queue!.map((e) => e.item.id)).toEqual(['sim:reply']);
    // One card left: nothing to show instead.
    expect(firstWinReducer(s, { type: 'another' })).toBe(s);
  });
});
