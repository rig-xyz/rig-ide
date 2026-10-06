import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import Markdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { describe, expect, it } from 'vitest';
import { remarkRoomTokens } from './message-tokens';

const members = [
  { id: 'u_hugo', name: 'Hugo Renaudin' },
  { id: 'u_bob', name: 'Bob' },
];

/** The same pipeline as a Room message (`richText`), with the tokens left as their marked spans. */
function render(text: string): string {
  return renderToStaticMarkup(
    createElement(
      Markdown,
      {
        remarkPlugins: [
          [remarkGfm, { singleTilde: false }],
          [remarkRoomTokens, { members }],
        ],
      },
      text
    )
  );
}

function tokens(text: string): Array<[string, string]> {
  return [...render(text).matchAll(/data-room-token="([^"]+)" data-value="([^"]*)"/g)].map((m) => [
    m[1]!,
    m[2]!,
  ]);
}

describe('remarkRoomTokens', () => {
  it('leaves code alone: no mention, path or link inside it', () => {
    const html = render('si tu fais `npm install -g @openai/codex@latest` sur ta machine');
    expect(html).toBe(
      '<p>si tu fais <code>npm install -g @openai/codex@latest</code> sur ta machine</p>'
    );
    expect(tokens('```\n@claude /Users/hugo/Rig/a/b.md https://x.dev\n```')).toEqual([]);
    expect(tokens('`/summarize` this')).toEqual([]);
  });

  it('picks out mentions in ordinary text, display names first, and keeps emails plain', () => {
    expect(tokens('@claude ask @Hugo Renaudin, not hugo@gmail.com')).toEqual([
      ['mention', '@claude'],
      ['mention', '@Hugo Renaudin'],
    ]);
    expect(render('@Bob hi')).toContain('data-member="u_bob"');
    // Inside emphasis is still ordinary text.
    expect(tokens('**@claude** please')).toEqual([['mention', '@claude']]);
    // Only agents' handles read as mentions without a member behind them.
    expect(tokens('npm i @rigxyz/cli and ask @someone')).toEqual([]);
    expect(tokens('@codex and @claude/x')).toEqual([['mention', '@codex']]);
  });

  it('takes a /command only at the very start of the message', () => {
    expect(tokens('/summarize the plan')).toEqual([['command', '/summarize']]);
    expect(tokens('please /summarize')).toEqual([]);
    expect(tokens('hi\n\n/summarize')).toEqual([]);
    expect(tokens('hi\n/summarize')).toEqual([]);
    expect(tokens('*/summarize* it')).toEqual([]);
    expect(tokens('/etc/hosts is a file')).toEqual([]);
  });

  it('picks out file tags, reviews and absolute paths', () => {
    expect(tokens('see +notes/plan.md and +"Q3 board deck.pdf"')).toEqual([
      ['file-tag', 'notes/plan.md'],
      ['file-tag', 'Q3 board deck.pdf'],
    ]);
    expect(tokens('read reviews/0.4.9.md')).toEqual([['review', 'reviews/0.4.9.md']]);
    expect(tokens('Put it in /Users/hugo/Rig/clear-harbor/notes/plan.md, thanks')).toEqual([
      ['path', '/Users/hugo/Rig/clear-harbor/notes/plan.md'],
    ]);
  });

  it('keeps the Room’s own link rules for bare URLs, and leaves www and emails as text', () => {
    expect(
      tokens('see https://userig.xyz/download. and https://en.wikipedia.org/wiki/Foo_(bar)')
    ).toEqual([
      ['link', 'https://userig.xyz/download'],
      ['link', 'https://en.wikipedia.org/wiki/Foo_(bar)'],
    ]);
    const html = render('www.userig.xyz or hugo@gmail.com');
    expect(html).toBe('<p>www.userig.xyz or hugo@gmail.com</p>');
    // A written link keeps its words; nothing inside it is a token.
    expect(render('[the plan @claude](https://x.dev/plan)')).toBe(
      '<p><a href="https://x.dev/plan">the plan @claude</a></p>'
    );
  });

  it('breaks the line at a single newline', () => {
    expect(render('one\ntwo')).toBe('<p>one<br/>\ntwo</p>');
    expect(render('one  \ntwo')).toBe('<p>one<br/>\ntwo</p>');
    expect(render('one\n\ntwo')).toBe('<p>one</p>\n<p>two</p>');
    expect(render('@claude\nhi')).toMatch(/@claude<\/span><br\/>\nhi<\/p>$/);
  });

  it('renders light markdown, never raw HTML, images or indented code', () => {
    expect(render('**bold** _it_ ~~gone~~ ~5 min ~10 min')).toBe(
      '<p><strong>bold</strong> <em>it</em> <del>gone</del> ~5 min ~10 min</p>'
    );
    expect(render('<b>hi</b>')).toBe('<p>&lt;b&gt;hi&lt;/b&gt;</p>');
    expect(render('    indented')).toBe('<p>indented</p>');
    expect(render('![chart](https://x.dev/c.png)')).toBe(
      '<p><a href="https://x.dev/c.png">chart</a></p>'
    );
    expect(render('- a\n- b')).toBe('<ul>\n<li>a</li>\n<li>b</li>\n</ul>');
    expect(render('> quoted')).toBe('<blockquote>\n<p>quoted</p>\n</blockquote>');
  });
});

describe('mentions by id (meta.mentions)', () => {
  const alexes = [
    { id: 'u_alex_a', name: 'Alex Martin' },
    { id: 'u_alex_b', name: 'Alex Martin' },
    { id: 'u_jer', name: 'Jérémie Rappaz' },
  ];

  /** Each mention's text and whose it is. */
  function whose(text: string, mentions: Array<{ id: string; name: string }>, people = alexes): Array<[string, string]> {
    const html = renderToStaticMarkup(
      createElement(Markdown, { remarkPlugins: [[remarkRoomTokens, { members: people, mentions }]] }, text)
    );
    return [...html.matchAll(/data-room-token="mention" data-value="([^"]*)" data-member="([^"]*)"/g)].map((m) => [
      m[1]!,
      m[2]!,
    ]);
  }

  it('gives each of two people with the same name their own mention, in order', () => {
    expect(
      whose('@Alex Martin and @Alex Martin', [
        { id: 'u_alex_b', name: 'Alex Martin' },
        { id: 'u_alex_a', name: 'Alex Martin' },
      ])
    ).toEqual([
      ['@Alex Martin', 'u_alex_b'],
      ['@Alex Martin', 'u_alex_a'],
    ]);
  });

  it('prefers the tagged id over the roster when names tie', () => {
    expect(whose('ping @Alex Martin', [{ id: 'u_alex_b', name: 'Alex Martin' }])).toEqual([['@Alex Martin', 'u_alex_b']]);
  });

  it('still finds a person who has since been renamed', () => {
    const renamed = [{ id: 'u_jer', name: 'Jérémie R.' }];
    expect(whose('@Jérémie Rappaz can you look?', [{ id: 'u_jer', name: 'Jérémie Rappaz' }], renamed)).toEqual([
      ['@Jérémie Rappaz', 'u_jer'],
    ]);
  });

  it('finds someone outside the space by the name written', () => {
    expect(whose('@Sam Outside hello', [{ id: 'u_sam', name: 'Sam Outside' }])).toEqual([['@Sam Outside', 'u_sam']]);
  });

  it('falls back to names without meta.mentions', () => {
    expect(whose('@Jérémie Rappaz hi', [])).toEqual([['@Jérémie Rappaz', 'u_jer']]);
  });
});
