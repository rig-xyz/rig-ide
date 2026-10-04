import { describe, expect, it } from 'vitest';
import { roomSeesFor } from './room-sees';

describe('roomSeesFor', () => {
  it("uses a space's own pick first", () => {
    expect(roomSeesFor({ bnd_a: 'everything' }, 'bnd_a', 'answer')).toBe('everything');
  });

  it("falls back to the person's default for a space never set", () => {
    expect(roomSeesFor({ bnd_a: 'everything' }, 'bnd_b', 'answer')).toBe('answer');
    expect(roomSeesFor(undefined, 'bnd_b', 'everything')).toBe('everything');
  });

  it('falls back to steps when no default is given or it is not a level', () => {
    expect(roomSeesFor({}, 'bnd_a')).toBe('steps');
    expect(roomSeesFor({}, 'bnd_a', 'nothing' as never)).toBe('steps');
  });
});
