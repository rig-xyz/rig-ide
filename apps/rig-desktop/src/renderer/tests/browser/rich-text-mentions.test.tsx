import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { richText } from '@renderer/features/spaces/components/transcript-items';

/** 0.4.3: "@gmail" inside an email address was styled as an @mention. */
function highlighted(text: string): string[] {
  const html = renderToStaticMarkup(<>{richText(text, 'bob')}</>);
  return [...html.matchAll(/<span[^>]*>([^<]*)<\/span>/g)].map((m) => m[1]!);
}

describe('richText mentions', () => {
  it('highlights a mention but not the @ inside an email address', () => {
    expect(highlighted('@claude can you invite Hugo hmr.renaudin@gmail.com?')).toEqual(['@claude']);
  });

  it('highlights a /command but not path or URL segments', () => {
    expect(highlighted('try /summarize now')).toEqual(['/summarize']);
    expect(highlighted('see https://userig.xyz/join/abc and docs/plan')).toEqual([]);
  });

  it('still highlights a mention after opening punctuation', () => {
    expect(highlighted('(@codex) hi')).toEqual(['@codex']);
  });
});
