import { describe, expect, it } from 'vitest';
import { newestFirst, type MySession } from './my-sessions-model';

describe('a space’s own sessions', () => {
  it('go newest first, the one just started on top', () => {
    const at = (id: string, t: number) => ({ id, title: id, state: 'idle', approval: null, at: t }) as MySession;
    expect(newestFirst([at('old', 1), at('just-started', 3), at('yesterday', 2)]).map((s) => s.id)).toEqual(['just-started', 'yesterday', 'old']);
  });
});
