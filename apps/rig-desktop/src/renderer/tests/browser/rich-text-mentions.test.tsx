import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { OpenPageContext, richText } from '@renderer/features/spaces/components/transcript-items';

const linkTitle = vi.hoisted(() => vi.fn(async ({ url }: { url: string }) => (url.includes('/artifact/') ? 'Homepage explorations' : null)));
const openExternal = vi.hoisted(() => vi.fn(async (_url: string) => {}));
vi.mock('@renderer/lib/ipc', () => ({ rpc: { app: { openExternal }, rig: { pages: { linkTitle } } } }));

/** The agents a space has: `@claude` and `@codex` name them. */
const AGENTS = ['claude', 'codex'];

/** 0.4.3: "@gmail" inside an email address was styled as an @mention. */
function highlighted(text: string): string[] {
  const html = renderToStaticMarkup(<>{richText(text, 'bob', [], [], AGENTS)}</>);
  return [...html.matchAll(/<span[^>]*>([^<]*)<\/span>/g)].map((m) => m[1]!);
}

describe('richText mentions', () => {
  it('highlights a mention but not the @ inside an email address', () => {
    expect(highlighted('@claude can you invite Hugo hmr.renaudin@gmail.com?')).toEqual(['@claude']);
  });

  it('highlights a /command but not path or URL segments', () => {
    expect(highlighted('/summarize the plan')).toEqual(['/summarize']);
    expect(highlighted('read the file /etc/hosts and run /date')).toEqual([]);
    // Only the link's own chip label: nothing inside the URL reads as a /command.
    expect(highlighted('see https://userig.xyz/join/abc and docs/plan')).toEqual(['userig.xyz/join']);
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
    const html = renderToStaticMarkup(<>{richText(text, ownId, members, [], AGENTS)}</>);
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
    host.innerHTML = renderToStaticMarkup(<>{richText(text, 'bob', [], [], AGENTS)}</>);
    return host;
  };

  it('shows a plain web link as a chip named for its site, leaving the sentence punctuation outside it', () => {
    const host = render('see https://www.userig.xyz/download. and https://example.com');
    const chips = [...host.querySelectorAll<HTMLAnchorElement>('[data-testid="message-link-chip"]')];
    expect(chips.map((c) => [c.dataset.kind, c.textContent, c.getAttribute('href'), c.title])).toEqual([
      ['web', 'userig.xyz/download', 'https://www.userig.xyz/download', 'https://www.userig.xyz/download'],
      ['web', 'example.com', 'https://example.com', 'https://example.com'],
    ]);
    expect(host.textContent).toBe('see userig.xyz/download. and example.com');
    // A globe, never a favicon fetched from the site; one line, cut short rather than wrapped mid-address.
    expect(chips[0]!.querySelector('svg.lucide-globe')).not.toBeNull();
    expect(chips[0]!.querySelector('img')).toBeNull();
    expect(host.innerHTML).not.toContain('break-all');
    expect(chips[0]!.querySelector('span')!.className).toContain('truncate');
  });

  it("opens a web link beside the chat; ⌘/ctrl- or middle-click, a meeting or a download go to the browser, and nothing asks the site for a title", async () => {
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);
    const openPage = vi.fn();
    openExternal.mockClear();
    linkTitle.mockClear();
    await act(async () => {
      root.render(
        <OpenPageContext.Provider value={openPage}>
          {richText('see https://www.userig.xyz/download#top, https://zoom.us/j/123 and https://dl.userig.xyz/Rig-0.4.5.dmg', 'bob', [], [], AGENTS)}
        </OpenPageContext.Provider>
      );
    });
    const [page, meeting, download] = [...host.querySelectorAll<HTMLAnchorElement>('[data-testid="message-link-chip"]')];
    const click = (el: Element, init: MouseEventInit = {}, type = 'click') =>
      act(async () => {
        el.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, ...init }));
      });

    await click(page!);
    expect(openPage).toHaveBeenCalledExactlyOnceWith('https://www.userig.xyz/download', 'userig.xyz/download');
    expect(openExternal).not.toHaveBeenCalled();

    await click(page!, { metaKey: true });
    await click(page!, { ctrlKey: true });
    await click(page!, { button: 1 }, 'auxclick');
    await click(meeting!);
    await click(download!);
    await vi.waitFor(() => expect(openExternal).toHaveBeenCalledTimes(5));
    // Each click loads the bridge lazily, so the calls can land in any order.
    expect(openExternal.mock.calls.map(([url]) => url).sort()).toEqual([
      'https://dl.userig.xyz/Rig-0.4.5.dmg',
      'https://www.userig.xyz/download#top',
      'https://www.userig.xyz/download#top',
      'https://www.userig.xyz/download#top',
      'https://zoom.us/j/123',
    ]);
    expect(openPage).toHaveBeenCalledOnce();
    expect(linkTitle).not.toHaveBeenCalled();
    await act(async () => root.unmount());
    host.remove();
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

  it("names a Claude artifact's chip after the artifact once its title is known, and keeps the kind in the tooltip", async () => {
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);
    await act(async () => {
      root.render(<>{richText('see https://claude.ai/artifact/AbC123?x=1 and https://docs.google.com/document/d/1AbC/edit', 'bob', [], [], AGENTS)}</>);
    });
    await vi.waitFor(() => expect(host.querySelector('[data-kind="claude-artifact"]')?.textContent).toBe('Homepage explorations'));
    const chip = host.querySelector<HTMLAnchorElement>('[data-kind="claude-artifact"]')!;
    expect(chip.title).toBe('Claude artifact · https://claude.ai/artifact/AbC123?x=1');
    // Asked for the link's canonical form; a doc that can't be named keeps its kind.
    expect(linkTitle).toHaveBeenCalledWith({ url: 'https://claude.ai/artifact/AbC123' });
    expect(host.querySelector('[data-kind="google-doc"]')?.textContent).toBe('Google Doc');
    await act(async () => root.unmount());
    host.remove();
  });
});
