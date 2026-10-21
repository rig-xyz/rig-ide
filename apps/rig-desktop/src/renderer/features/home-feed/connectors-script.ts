import type { Arrival, ConnectorsState, Topic } from './connectors-model';
import type { SourceConnector } from './model';

/**
 * The scripted day behind the Connectors view: three watch sessions, the
 * topics their items were sorted into, and the checks that run while you
 * watch. The same topics and items as the approved prototype's Inbox.
 */

const MIN = 60_000;

type Seed = Omit<Topic, 'fresh' | 'bump'>;

const TOPICS: Seed[] = [
  {
    id: 'earn',
    name: 'Earn Vault Bugs',
    hue: 3,
    count: 12,
    state: 'feed',
    items: [
      {
        ref: 'ULY-487',
        title: 'BTC buy funded from Earn shows a phantom “Received $7.50”',
        connector: 'linear',
      },
      {
        ref: 'ULY-430',
        title: 'Disabling Earn sends a “You’ve received crypto” email',
        connector: 'linear',
      },
    ],
  },
  {
    id: 'loyalty',
    name: 'Season 1 Loyalty Launch',
    hue: 1,
    count: 42,
    state: 'feed',
    items: [
      {
        ref: 'ULY-455',
        title: 'Alpha user group: recruit first 10 onto TestFlight',
        connector: 'linear',
      },
      {
        ref: 'ULY-344',
        title: 'Launch announcement thread and partner boost',
        connector: 'linear',
      },
    ],
  },
  {
    id: 'release',
    name: 'Desktop Release',
    hue: 7,
    count: 6,
    state: 'feed',
    items: [
      {
        ref: 'v0.4.15',
        title: 'Release is still a draft; the tag was never pushed',
        connector: 'github',
      },
    ],
  },
  {
    id: 'investors',
    name: 'Investor Follow-ups',
    hue: 5,
    count: 4,
    state: 'none',
    items: [
      {
        ref: 'call',
        title: 'Lumen Ventures asked for usage by company domain',
        connector: 'granola',
      },
    ],
  },
  {
    id: 'deletion',
    name: 'Account Deletion',
    hue: 2,
    count: 21,
    state: 'held',
    why: 'Moving fine: Riyad updated 6 tickets today.',
    items: [
      { ref: 'ULY-503', title: 'Soft-delete financial records with a reason', connector: 'linear' },
    ],
  },
  {
    id: 'robinhood',
    name: 'Robinhood Chain Prep',
    hue: 4,
    count: 18,
    state: 'held',
    why: 'Parked since Aug 18; no one is working on it.',
    items: [
      { ref: 'ULY-184', title: 'Market data: Robinhood REST price adapter', connector: 'linear' },
    ],
  },
  {
    id: 'kyc',
    name: 'KYC and Fraud',
    hue: 8,
    count: 5,
    state: 'none',
    items: [
      {
        ref: 'ULY-176',
        title: 'Mobile: device-session module for a real Sardine key',
        connector: 'linear',
      },
    ],
  },
  {
    id: 'holdings',
    name: 'Holdings and Prices',
    hue: 6,
    count: 18,
    state: 'none',
    items: [
      {
        ref: 'ULY-418',
        title: 'Fully sold tokens never leave the cached balance',
        connector: 'linear',
      },
    ],
  },
  {
    id: 'payfriends',
    name: 'Pay Friends',
    hue: 3,
    count: 13,
    state: 'none',
    items: [
      { ref: 'ULY-485', title: 'Recipients don’t see crypto sent to them', connector: 'linear' },
    ],
  },
  {
    id: 'zwift',
    name: 'Zwift Setup',
    hue: 6,
    count: 3,
    state: 'held',
    why: 'Janis’s thread, not yours.',
    items: [
      { ref: 'call', title: 'Janis: Claude not connecting after reinstall', connector: 'granola' },
    ],
  },
];

/** Today's items so far, as topic ids, oldest first. */
const TODAY =
  'earn loyalty loyalty release earn loyalty investors deletion holdings payfriends kyc loyalty deletion holdings robinhood loyalty earn deletion zwift payfriends loyalty kyc holdings deletion';

export function initialConnectorsState(now: number): ConnectorsState {
  const topics = TOPICS.map((t) => ({ ...t, fresh: 0, bump: 0 }));
  const byId = new Map(topics.map((t) => [t.id, t]));
  const cells = TODAY.split(' ').map((topic, i) => {
    const t = byId.get(topic)!;
    const item = t.items[i % t.items.length]!;
    return {
      id: `seed-${i}`,
      topic,
      ref: item.ref,
      title: item.title,
      connector: item.connector,
      fresh: false,
    };
  });
  const count = (c: SourceConnector) => cells.filter((x) => x.connector === c).length;
  return {
    focus: null,
    topics,
    cells,
    connectors: [
      {
        id: 'linear',
        connector: 'linear',
        name: 'Linear',
        scope: 'Ulys',
        cadence: 'every 30 min',
        checking: false,
        lastCheckAt: now - 4 * MIN,
        today: count('linear'),
        lastResult: { added: 2, toFeed: 1, held: 0 },
      },
      {
        id: 'github',
        connector: 'github',
        name: 'GitHub',
        scope: 'rig-xyz/rig-ide',
        cadence: 'every hour',
        checking: false,
        lastCheckAt: now - 20 * MIN,
        today: count('github'),
        lastResult: { added: 1, toFeed: 1, held: 0 },
      },
      {
        id: 'granola',
        connector: 'granola',
        name: 'Granola',
        scope: 'your meetings',
        cadence: 'after each call',
        checking: false,
        lastCheckAt: now - 52 * MIN,
        today: count('granola'),
        lastResult: { added: 1, toFeed: 0, held: 1 },
      },
    ],
  };
}

/** A check: which connector Claude checks, how long it takes, and what it brings back. */
export interface ScriptedCheck {
  connector: SourceConnector;
  arrivals: Arrival[];
}

/** The checks that play while you watch, in order; after them, quiet checks keep going round. */
export const CHECKS: ScriptedCheck[] = [
  {
    connector: 'linear',
    arrivals: [
      {
        connector: 'linear',
        ref: 'ULY-521',
        title: 'Earn: APY shows 0% right after the vault migration',
        topic: 'earn',
      },
    ],
  },
  {
    connector: 'github',
    arrivals: [
      {
        connector: 'github',
        ref: '#212',
        title: 'Spaces: request claim retries forever after a sign-in failure',
        topic: 'spaces',
        born: { name: 'Spaces Reliability', hue: 7 },
      },
    ],
  },
  {
    connector: 'granola',
    arrivals: [
      {
        connector: 'granola',
        ref: 'call',
        title: 'Riyad 1:1: Sardine checkpoint still gets no device data',
        topic: 'kyc',
        held: true,
      },
    ],
  },
  {
    connector: 'linear',
    arrivals: [
      {
        connector: 'linear',
        ref: 'ULY-523',
        title: 'Disabling Earn shows half the withdrawn USDC (again)',
        topic: 'earn',
        flag: 'looks like ULY-245',
      },
      {
        connector: 'linear',
        ref: 'ULY-524',
        title: 'Pay Friends: invite SMS sent twice on retry',
        topic: 'payfriends',
      },
    ],
  },
  {
    connector: 'github',
    arrivals: [
      {
        connector: 'github',
        ref: '#213',
        title: 'Requests stay queued when the only Mac signs out',
        topic: 'spaces',
        toFeed: true,
      },
    ],
  },
];

/** When the first check starts, the gap between checks, and how long Claude takes over one. */
export const TIMING = { firstMs: 2500, gapMs: 7000, checkMs: 2200, quietGapMs: 30_000 } as const;
