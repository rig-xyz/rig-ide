import { describe, expect, it } from 'vitest';
import {
  applyMentionText,
  mentionPeople,
  mentionQueryOf,
  nameMatches,
  parseMessageMentions,
  presentMentions,
} from './mentions';

describe('mentionQueryOf', () => {
  const names = ['claude', 'Hugo Renaudin', 'Jérémie Rappaz'];

  it('opens on any letters, accents included', () => {
    expect(mentionQueryOf('hey @Jé', names)).toBe('Jé');
    expect(mentionQueryOf('@élodie', names)).toBe('élodie');
    expect(mentionQueryOf('@', names)).toBe('');
  });

  it('keeps matching across a space', () => {
    expect(mentionQueryOf('ping @Jérémie Ra', names)).toBe('Jérémie Ra');
    expect(mentionQueryOf('ping @Jérémie ', names)).toBe('Jérémie ');
  });

  it('closes after a whole name and a space, so Enter sends', () => {
    expect(mentionQueryOf('ping @Hugo Renaudin ', names)).toBeNull();
    expect(mentionQueryOf('ping @jeremie rappaz ', names)).toBeNull();
    expect(mentionQueryOf('ping @claude ', names)).toBeNull();
  });

  it('never opens inside an email or after a lone "@ "', () => {
    expect(mentionQueryOf('mail sam@north', names)).toBeNull();
    expect(mentionQueryOf('@ ', names)).toBeNull();
  });
});

describe('nameMatches', () => {
  it('matches any word of the name, ignoring case and accents', () => {
    expect(nameMatches('Jérémie Rappaz', 'jer')).toBe(true);
    expect(nameMatches('Jérémie Rappaz', 'JÉR')).toBe(true);
    expect(nameMatches('Jérémie Rappaz', 'rap')).toBe(true);
    expect(nameMatches('Jérémie Rappaz', 'Jérémie Ra')).toBe(true);
    expect(nameMatches('Jean-Pierre Dupont', 'pierre')).toBe(true);
  });

  it('needs the words in order and side by side', () => {
    expect(nameMatches('Jérémie Rappaz', 'Rappaz Jé')).toBe(false);
    expect(nameMatches('Jérémie Rappaz', 'emie')).toBe(false);
    expect(nameMatches('Jérémie Rappaz', 'Jérémie thanks')).toBe(false);
  });

  it('matches an email used as a name by its start', () => {
    expect(nameMatches('sam@northwind.io', 'sam')).toBe(true);
  });

  it('matches everyone on an empty query', () => {
    expect(nameMatches('Anyone', '')).toBe(true);
  });
});

describe('applyMentionText', () => {
  it('replaces the query, spaces and all, with the full name', () => {
    expect(applyMentionText('hey @Jérémie Ra', 'Jérémie Rappaz')).toBe('hey @Jérémie Rappaz ');
    expect(applyMentionText('@sa', 'sam@northwind.io')).toBe('@sam@northwind.io ');
  });
});

describe('presentMentions', () => {
  const ana = { id: 'usr_a', name: 'Alex Martin' };
  const bob = { id: 'usr_b', name: 'Alex Martin' };
  const jer = { id: 'usr_j', name: 'Jérémie Rappaz' };

  it('keeps the picks still written, in the order they appear', () => {
    expect(presentMentions('@Jérémie Rappaz and @Alex Martin', [ana, jer])).toEqual([jer, ana]);
  });

  it('drops a pick the person deleted or edited away', () => {
    expect(presentMentions('thanks Jérémie', [jer])).toEqual([]);
    expect(presentMentions('@Jérémie Rappazzz', [jer])).toEqual([]);
  });

  it('keeps two people with the same name apart', () => {
    expect(presentMentions('@Alex Martin and @Alex Martin', [ana, bob])).toEqual([ana, bob]);
  });

  it('finds an email used as a name', () => {
    const sam = { id: 'usr_s', name: 'sam@northwind.io' };
    expect(presentMentions('cc @sam@northwind.io', [sam])).toEqual([sam]);
  });
});

describe('parseMessageMentions', () => {
  it('pairs ids with the names as written, skipping anything malformed', () => {
    expect(parseMessageMentions(['usr_a', 'usr_b', 7], ['Alex', '', 'x'])).toEqual([
      { id: 'usr_a', name: 'Alex' },
    ]);
    expect(parseMessageMentions(undefined, ['Alex'])).toEqual([]);
  });
});

describe('mentionPeople', () => {
  it('offers pending person invites, then your people outside the space, each once', () => {
    const people = mentionPeople(
      [
        { status: 'sent', target: { userId: 'usr_inv', name: 'Ines Invited', avatarUrl: null } },
        {
          status: 'sent',
          revoked: true,
          target: { userId: 'usr_rev', name: 'Rex Revoked', avatarUrl: null },
        },
        { status: 'joined', target: { userId: 'usr_joined', name: 'Jo Joined', avatarUrl: null } },
        { status: 'sent' },
      ],
      new Set(['usr_me', 'usr_member']),
      [
        { userId: 'usr_member', name: 'Mia Member', avatarUrl: null, sharedSpaces: [1] },
        { userId: 'usr_inv', name: 'Ines Invited', avatarUrl: null, sharedSpaces: [1] },
        { userId: 'usr_j', name: 'Jérémie Rappaz', avatarUrl: null, sharedSpaces: [1, 2] },
        { userId: 'usr_nameless', name: null, avatarUrl: null, sharedSpaces: [] },
      ]
    );
    expect(people).toEqual([
      { id: 'usr_inv', name: 'Ines Invited', avatarUrl: null, group: 'invited' },
      {
        id: 'usr_j',
        name: 'Jérémie Rappaz',
        avatarUrl: null,
        group: 'outside',
        detail: '2 spaces with you',
      },
    ]);
  });
});
