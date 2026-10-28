import { describe, expect, it } from 'vitest';
import { deriveCatalogFootnote } from './catalog-footnote';

describe('deriveCatalogFootnote', () => {
  it('subtracts the icon-shown examples from the real registry count', () => {
    expect(deriveCatalogFootnote(35)).toBe('and 32 more agents are detected automatically once installed.');
  });

  it('singularizes "agent"/"is" when exactly one other is left', () => {
    expect(deriveCatalogFootnote(4)).toBe('and 1 more agent is detected automatically once installed.');
  });

  it('never goes negative — clamps to 0 if the registry ever shrank below the shown examples', () => {
    expect(deriveCatalogFootnote(1)).toBe('and 0 more agents are detected automatically once installed.');
  });
});
