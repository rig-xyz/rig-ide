import { describe, expect, it } from 'vitest';
import { deriveAskChips, FALLBACK_ASK_CHIPS, type AskChipInput } from './ask-chips';

const empty: AskChipInput = { spaces: [], mentions: [], topics: [] };

describe('deriveAskChips', () => {
  it('nothing new: the standing three questions', () => {
    expect(deriveAskChips(empty)).toEqual(FALLBACK_ASK_CHIPS);
    expect(
      deriveAskChips({
        spaces: [{ bindingId: 'b1', name: 'rig-ops', unread: 0 }],
        mentions: [],
        topics: [{ bindingId: 'b1', spaceName: 'rig-ops', name: 'Failed Runs Report', isNew: false, people: [] }],
      })
    ).toEqual(FALLBACK_ASK_CHIPS);
  });

  it('from what is on screen: the busiest space, who mentioned you on their topic, then a topic new to you', () => {
    const chips = deriveAskChips({
      spaces: [
        { bindingId: 'b-ops', name: 'rig-ops', unread: 3 },
        { bindingId: 'b-mkt', name: 'rig-marketing', unread: 25 },
      ],
      mentions: [{ bindingId: 'b-mkt', spaceName: 'rig-marketing', who: 'Hugo Renaudin' }],
      topics: [
        { bindingId: 'b-ops', spaceName: 'rig-ops', name: 'Failed Runs Report', isNew: true, people: ['Dylan'] },
        { bindingId: 'b-mkt', spaceName: 'rig-marketing', name: 'Pricing', isNew: true, people: ['Ana'] },
        { bindingId: 'b-mkt', spaceName: 'rig-marketing', name: 'Onboarding Strategy', isNew: true, people: ["Hugo's Claude"] },
      ],
    });
    expect(chips).toEqual([
      { question: 'Catch me up on rig-marketing', why: '25 new' },
      { question: 'What did Hugo decide on Onboarding Strategy?', why: 'mentioned you' },
      { question: "What's left on Failed Runs Report?", why: '#rig-ops' },
    ]);
  });

  it('a mention in a space with no topic today asks about the space', () => {
    expect(
      deriveAskChips({ ...empty, mentions: [{ bindingId: 'b1', spaceName: 'rig-jay', who: 'Jay' }] })
    ).toEqual([{ question: 'What did Jay ask me in rig-jay?', why: 'mentioned you' }]);
  });

  it('caps the count at 99+, and never offers the same topic twice', () => {
    const chips = deriveAskChips({
      spaces: [{ bindingId: 'b1', name: 'launch', unread: 140 }],
      mentions: [{ bindingId: 'b1', spaceName: 'launch', who: 'Ana' }],
      topics: [{ bindingId: 'b1', spaceName: 'launch', name: 'Launch plan', isNew: true, people: ['Ana'] }],
    });
    expect(chips).toEqual([
      { question: 'Catch me up on launch', why: '99+ new' },
      { question: 'What did Ana decide on Launch plan?', why: 'mentioned you' },
    ]);
  });
});
