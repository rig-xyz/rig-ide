import { describe, expect, it } from 'vitest';
import { groupByTopic } from './following-model';

const row = (title: string, topic: string | null, at: string) => ({ ref: title, title, topic, line: '', people: [], at });

describe('the Following tab', () => {
  it('groups followed situations by topic, latest activity first, the untopiced last', () => {
    const groups = groupByTopic([
      row('ULY-430', 'Earn vault bugs', '2026-10-23T10:00:00Z'),
      row('Seamless USDC', null, '2026-10-23T12:00:00Z'),
      row('ULY-523', 'iOS 2.3.0 release', '2026-10-23T11:00:00Z'),
      row('ULY-487', 'Earn vault bugs', '2026-10-23T09:00:00Z'),
    ]);
    expect(groups.map((g) => [g.topic, g.rows.length])).toEqual([
      ['iOS 2.3.0 release', 1],
      ['Earn vault bugs', 2],
      ['No topic yet', 1],
    ]);
  });
});
