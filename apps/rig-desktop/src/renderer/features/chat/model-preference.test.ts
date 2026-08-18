import { describe, expect, it } from 'vitest';
import { deriveAutoApplyOption } from './model-preference';

describe('deriveAutoApplyOption', () => {
  it('nothing remembered — never applies anything', () => {
    expect(deriveAutoApplyOption(null, [{ id: 'sonnet' }, { id: 'haiku' }], false)).toBeNull();
  });

  it('remembered id is present in the advertised options — applies it', () => {
    expect(deriveAutoApplyOption('haiku', [{ id: 'sonnet' }, { id: 'haiku' }], false)).toBe('haiku');
  });

  it('remembered id is NOT among the advertised options — never fabricates a match', () => {
    expect(deriveAutoApplyOption('opus', [{ id: 'sonnet' }, { id: 'haiku' }], false)).toBeNull();
  });

  it('no options advertised yet — nothing to apply', () => {
    expect(deriveAutoApplyOption('haiku', [], false)).toBeNull();
  });

  it('already applied once — never re-applies, even though the remembered id is still valid (never fights a later in-session choice)', () => {
    expect(deriveAutoApplyOption('haiku', [{ id: 'sonnet' }, { id: 'haiku' }], true)).toBeNull();
  });
});
