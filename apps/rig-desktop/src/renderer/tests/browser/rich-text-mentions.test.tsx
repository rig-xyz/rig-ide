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
