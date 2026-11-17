import { describe, expect, it } from 'vitest';
import { generateSpaceName } from '@renderer/features/home/space-create';
import { ADJECTIVES, isGeneratedSpaceName, NOUNS } from './space-names';

describe('isGeneratedSpaceName', () => {
  it('knows a name made from the word lists', () => {
    for (const name of ['bright-harbor', 'Bright-Harbor', ' calm-ridge-2 ']) {
      expect(isGeneratedSpaceName(name), name).toBe(true);
    }
  });
  it('leaves a name a person chose alone', () => {
    for (const name of ['PR reviews', 'bright', 'harbor-bright', '', 'bright-harbor-x', 'bright-harbor-2-3']) {
      expect(isGeneratedSpaceName(name), name).toBe(false);
    }
  });
  it('accepts every name generateSpaceName returns', () => {
    for (const adjective of ADJECTIVES) {
      for (const noun of NOUNS) {
        const seed = ADJECTIVES.indexOf(adjective) / ADJECTIVES.length;
        const other = NOUNS.indexOf(noun) / NOUNS.length;
        let call = 0;
        const name = generateSpaceName(new Set(), () => (call++ % 2 === 0 ? seed : other));
        expect(isGeneratedSpaceName(name), name).toBe(true);
      }
    }
    const taken = new Set<string>();
    for (let i = 0; i < 300; i++) {
      const name = generateSpaceName(taken);
      expect(isGeneratedSpaceName(name), name).toBe(true);
      taken.add(name);
    }
  });
});
