import { describe, expect, it } from 'vitest';
import { deriveAvatarStack } from './avatar-stack';

const person = (userId: string) => ({ userId, name: userId, avatarUrl: null });

describe('deriveAvatarStack', () => {
  it('shows everyone with no overflow chip at or under the cap', () => {
    const three = [person('a'), person('b'), person('c')];
    expect(deriveAvatarStack(three)).toEqual({ visible: three, overflow: 0 });
    expect(deriveAvatarStack([])).toEqual({ visible: [], overflow: 0 });
    expect(deriveAvatarStack([person('a')])).toEqual({
      visible: [person('a')],
      overflow: 0,
    });
  });

  it('caps at three faces and counts the rest into one +N', () => {
    const five = ['a', 'b', 'c', 'd', 'e'].map(person);
    const stack = deriveAvatarStack(five);
    expect(stack.visible.map((p) => p.userId)).toEqual(['a', 'b', 'c']);
    expect(stack.overflow).toBe(2);
  });

  it('overflows by exactly one when there is one person past the cap', () => {
    const four = ['a', 'b', 'c', 'd'].map(person);
    expect(deriveAvatarStack(four).overflow).toBe(1);
  });

  it('preserves the given order — the stack must be stable across polls', () => {
    const people = ['z', 'a', 'm'].map(person);
    expect(deriveAvatarStack(people).visible.map((p) => p.userId)).toEqual(['z', 'a', 'm']);
  });

  it('respects a custom cap, including zero', () => {
    const people = ['a', 'b', 'c'].map(person);
    expect(deriveAvatarStack(people, 2)).toEqual({
      visible: [person('a'), person('b')],
      overflow: 1,
    });
    expect(deriveAvatarStack(people, 0)).toEqual({ visible: [], overflow: 3 });
  });
});
