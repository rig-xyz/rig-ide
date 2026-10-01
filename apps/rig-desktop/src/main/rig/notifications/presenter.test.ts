import { describe, expect, it } from 'vitest';
import { row } from '@shared/rig/notification-fixture';
import { BannerPresenter, type BannerSpec } from './presenter';

function setup() {
  let now = 1_000_000;
  const shown: Array<BannerSpec & { closed: boolean }> = [];
  const clicked: string[][] = [];
  const presenter = new BannerPresenter({
    factory: (spec) => {
      const entry = { ...spec, closed: false };
      shown.push(entry);
      return {
        close() {
          entry.closed = true;
        },
      };
    },
    now: () => now,
    sound: () => true,
    onClick: (rows) => clicked.push(rows.map((r) => r.id)),
  });
  return { presenter, shown, clicked, advance: (ms: number) => (now += ms) };
}

describe('BannerPresenter', () => {
  it('bundles ambient rows of one space inside the window, replacing the banner', () => {
    const { presenter, shown, clicked, advance } = setup();
    presenter.present(row({ id: '1' }));
    advance(5_000);
    presenter.present(row({ id: '2', body: 'second', actor: { kind: 'user', userId: 'u', name: 'Maya', agent: null } }));
    expect(shown).toHaveLength(2);
    expect(shown[0]!.closed).toBe(true);
    expect(shown[1]).toMatchObject({ title: '2 new messages in Launch', body: 'Maya: second', silent: false });
    expect(presenter.liveCount).toBe(1);
    shown[1]!.onClick();
    expect(clicked).toEqual([['1', '2']]);
    expect(presenter.liveCount).toBe(0);
  });

  it('starts a new banner after the window, and never bundles direct rows or other spaces', () => {
    const { presenter, shown, advance } = setup();
    presenter.present(row({ id: '1' }));
    advance(31_000);
    presenter.present(row({ id: '2' }));
    presenter.present(row({ id: '3', bindingId: 'bnd_b' }));
    presenter.present(row({ id: '4', type: 'mention', tier: 'direct', title: 'Hugo mentioned you in Launch' }));
    expect(shown.map((s) => s.title)).toEqual([
      'Hugo in Launch',
      'Hugo in Launch',
      'Hugo in Launch',
      'Hugo mentioned you in Launch',
    ]);
    expect(shown.filter((s) => s.closed)).toHaveLength(0);
  });

  it('closes banners read elsewhere, by id, by space, or all', () => {
    const { presenter, shown } = setup();
    presenter.present(row({ id: '1', type: 'mention', tier: 'direct' }));
    presenter.present(row({ id: '2', type: 'reply', tier: 'direct', bindingId: 'bnd_b' }));
    presenter.present(row({ id: '3', type: 'agent_finished', tier: 'direct', bindingId: 'bnd_c' }));
    presenter.closeIds(['1']);
    expect(shown[0]!.closed).toBe(true);
    presenter.closeSpace('bnd_b');
    expect(shown[1]!.closed).toBe(true);
    presenter.closeAll();
    expect(shown[2]!.closed).toBe(true);
  });

  it('labels a guest comment and follows the sound setting', () => {
    let sound = true;
    const shown: BannerSpec[] = [];
    const presenter = new BannerPresenter({
      factory: (spec) => {
        shown.push(spec);
        return { close() {} };
      },
      now: () => 0,
      sound: () => sound,
      onClick: () => {},
    });
    sound = false;
    presenter.present(
      row({ type: 'comment', actor: { kind: 'guest', userId: null, name: 'Ana', agent: null }, title: 'Ana commented on a.md in Launch' })
    );
    expect(shown[0]).toMatchObject({ subtitle: 'Guest via a share link', silent: true });
  });
});
