import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { richText } from '@renderer/features/spaces/components/transcript-items';

vi.mock('@renderer/lib/ipc', () => ({ rpc: { app: { openExternal: async () => {} } } }));

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
    expect(highlighted('/summarize the plan')).toEqual(['/summarize']);
    expect(highlighted('read the file /etc/hosts and run /date')).toEqual([]);
    expect(highlighted('see https://userig.xyz/join/abc and docs/plan')).toEqual([]);
  });

  it('still highlights a mention after opening punctuation', () => {
    expect(highlighted('(@codex) hi')).toEqual(['@codex']);
  });
});

/**
 * 0.4.4: Tab-completing "@Hu" inserts the member's display name ("@Hugo
 * Renaudin"), but the bubble only recognised lowercase single-word handles,
 * so a person mention rendered as plain text.
 */
describe('richText person mentions', () => {
  const members = [
    { id: 'u_hugo', name: 'Hugo Renaudin' },
    { id: 'u_hugo2', name: 'Hugo' },
    { id: 'bob', name: 'Bob Stone' },
  ];
  const spans = (text: string, ownId = 'bob') => {
    const html = renderToStaticMarkup(<>{richText(text, ownId, members)}</>);
    return [...html.matchAll(/<span([^>]*)>([^<]*)<\/span>/g)].map((m) => ({ attrs: m[1]!, text: m[2]! }));
  };

  it('highlights a multi-word member name as one mention, without swallowing the next word', () => {
    expect(
      spans('Actually can you just run @Hugo Renaudin through the changes in 0.4.3?').map((s) => s.text)
    ).toEqual(['@Hugo Renaudin']);
  });

  it('resolves names that prefix each other to the longest', () => {
    expect(spans('@Hugo Renaudin and @Hugo, both').map((s) => s.text)).toEqual(['@Hugo Renaudin', '@Hugo']);
  });

  it('keeps trailing punctuation and possessives outside the mention', () => {
    expect(spans("ask @Hugo Renaudin's agent, or @Hugo Renaudin.").map((s) => s.text)).toEqual([
      '@Hugo Renaudin',
      '@Hugo Renaudin',
    ]);
  });

  it('matches the name case-insensitively but not as a prefix of a longer word', () => {
    expect(spans('@hugo renaudin hi').map((s) => s.text)).toEqual(['@hugo renaudin']);
    // "@Hugonaut" is not "@Hugo": no person mention, and not the lowercase agent-style shape either.
    expect(spans('@Hugonaut hi')).toEqual([]);
  });

  it('marks a mention of the viewer', () => {
    const [you] = spans('thanks @Bob Stone');
    expect(you!.text).toBe('@Bob Stone');
    expect(you!.attrs).toContain('bg-accent-subtle');
    const [other] = spans('thanks @Hugo Renaudin');
    expect(other!.attrs).not.toContain('bg-accent-subtle');
  });

  it('keeps agent mentions and email addresses as before', () => {
    expect(spans('@claude ping hugo.renaudin@gmail.com and @Hugo').map((s) => s.text)).toEqual(['@claude', '@Hugo']);
  });
});

describe('richText links', () => {
  const render = (text: string) => {
    const host = document.createElement('div');
    host.innerHTML = renderToStaticMarkup(<>{richText(text, 'bob')}</>);
    return host;
  };

  it('makes a plain web link clickable, leaving the sentence punctuation outside it', () => {
    const host = render('see https://userig.xyz/download.');
    const link = host.querySelector<HTMLAnchorElement>('[data-testid="message-link"]')!;
    expect(link.getAttribute('href')).toBe('https://userig.xyz/download');
    expect(link.textContent).toBe('https://userig.xyz/download');
    expect(host.textContent).toBe('see https://userig.xyz/download.');
  });

  it('shows known links as a chip named for what they are, keeping the URL on hover', () => {
    const host = render(
      '@claude https://claude.ai/artifact/6NZfLXaEewFt55zQ5tMn7d vs https://docs.google.com/document/d/1AbC/edit and https://github.com/rig-xyz/rig-ide'
    );
    const chips = [...host.querySelectorAll<HTMLAnchorElement>('[data-testid="message-link-chip"]')];
    expect(chips.map((c) => [c.dataset.kind, c.textContent])).toEqual([
      ['claude-artifact', 'Claude artifact'],
      ['google-doc', 'Google Doc'],
      ['github', 'rig-xyz/rig-ide'],
    ]);
    expect(chips[0]!.title).toBe('https://claude.ai/artifact/6NZfLXaEewFt55zQ5tMn7d');
    // The mention still reads as one; nothing inside the URLs does.
    expect(host.querySelector('span.text-accent')?.textContent).toBe('@claude');
  });
});
