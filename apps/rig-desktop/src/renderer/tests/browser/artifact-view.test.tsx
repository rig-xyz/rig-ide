import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { ArtifactView } from '@renderer/features/artifact/artifact-view';
import { ImageArtifact } from '@renderer/features/artifact/image-artifact';
import { resetPreviewModeMemoryForTests } from '@renderer/features/artifact/preview-mode-memory';
// Real tokens, not a stub — the mono/highlight assertions below check actual
// resolved `--accent`/`--text-primary` CSS custom properties, which only
// exist once this stylesheet (normally loaded once at app boot) is present.
import '@renderer/tokens.css';

/**
 * Regression coverage for the live "rig.toml stuck on Loading… forever" bug:
 * `EditableArtifactPane` (the pane hosting markdown AND every other
 * text/code/config file, `artifact-view.tsx`) reads `DocTabResource`'s mobx
 * observables (`isLoading`/`loadError`/`saveState`/`hasDiskUpdate`) directly
 * in its render body, but was a PLAIN function component rather than one
 * wrapped in `mobx-react-lite`'s `observer()` — unlike `ArtifactView` itself,
 * which is `observer()`-wrapped but never reads those fields (they're all
 * read one level down, inside the pane). Without `observer()` on the pane,
 * mobx has no subscription on those reads, so `_loadInitial()`'s
 * `runInAction(() => { this.isLoading = false; ... })` (`doc-file-sync.ts`)
 * never triggers a re-render of the pane: it freezes on whatever was true
 * at its own last render — `isLoading: true` for the body ("Loading…"
 * forever) and `saveState: 'saved'` for the header (the class field's
 * default, coincidentally already correct, not a live read).
 *
 * The mocked disk read below resolves via a macrotask (`setTimeout`, not a
 * bare microtask) specifically so it lands AFTER the one incidental extra
 * render `use-file-type.ts`'s effect causes on mount (a real, separate,
 * smaller inefficiency — see that file) — otherwise this test could pass by
 * accident even on the unfixed pane, by catching that one lucky re-render.
 * This mirrors why the real bug reads as flaky-by-file rather than
 * deterministic: that incidental render's timing, not the file's type, is
 * what decided whether a given open "looked fine" before this fix.
 */

const mocks = vi.hoisted(() => ({
  read: vi.fn<(args: unknown) => Promise<unknown>>(),
  write: vi.fn<(args: unknown) => Promise<unknown>>(),
  watch: vi.fn<(args: unknown) => void>(),
  unwatch: vi.fn<(args: unknown) => void>(),
  readBinary: vi.fn<(args: unknown) => Promise<unknown>>(),
  // A `.md` path is `commentsEnabled` (`artifact-view.tsx`), so opening one
  // attaches a real `DocCommentsStore` (`comments-store.ts`) — it needs
  // enough of `rpc.rig.comments` to settle without unhandled rejections, not
  // because any test here exercises comments themselves.
  commentsCacheGet: vi.fn<(args: unknown) => Promise<unknown>>(),
  commentsCacheSet: vi.fn<(args: unknown) => Promise<unknown>>(),
  commentsResolveTarget: vi.fn<(args: unknown) => Promise<unknown>>(),
  commentsList: vi.fn<(args: unknown) => Promise<unknown>>(),
  commentsCreate: vi.fn<(args: unknown) => Promise<unknown>>(),
  contextCreateTarget: vi.fn<(args: unknown) => Promise<unknown>>(),
}));

vi.mock('@renderer/lib/ipc', () => ({
  rpc: {
    rig: {
      files: {
        read: (...args: unknown[]) => mocks.read(args[0]),
        write: (...args: unknown[]) => mocks.write(args[0]),
        watch: (...args: unknown[]) => mocks.watch(args[0]),
        unwatch: (...args: unknown[]) => mocks.unwatch(args[0]),
        readBinary: (...args: unknown[]) => mocks.readBinary(args[0]),
      },
      comments: {
        cacheGet: (...args: unknown[]) => mocks.commentsCacheGet(args[0]),
        cacheSet: (...args: unknown[]) => mocks.commentsCacheSet(args[0]),
        resolveTarget: (...args: unknown[]) => mocks.commentsResolveTarget(args[0]),
        list: (...args: unknown[]) => mocks.commentsList(args[0]),
        create: (...args: unknown[]) => mocks.commentsCreate(args[0]),
        // Only reached once a thread actually renders a `ThreadCard`
        // (`comments-margin.tsx`'s `useThreadAgent`/`useMentionableAgents`) —
        // none of the earlier tests in this file populate any threads, only
        // the new Preview↔Edit round-trip regression test below does.
        listMembers: vi.fn(async () => ({ success: true, data: { members: [] } })),
      },
      context: {
        createTarget: (...args: unknown[]) => mocks.contextCreateTarget(args[0]),
      },
    },
    agents: {
      list: vi.fn(async () => []),
      listMetadata: vi.fn(async () => []),
    },
    app: {
      openPath: vi.fn(async () => ({ success: true, data: undefined })),
      showItemInFolder: vi.fn(async () => ({ success: true, data: undefined })),
    },
  },
  events: {
    on: vi.fn(() => () => {}),
  },
}));

beforeAll(() => {
  (
    globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
});

/** Resolves on a macrotask, after any same-tick/microtask re-render churn has already settled — see the file-level comment on why this matters for the primary regression test. */
function resolveOnMacrotask<T>(value: T): Promise<T> {
  return new Promise((resolve) => setTimeout(() => resolve(value), 20));
}

async function waitFor(predicate: () => boolean, timeoutMs = 3000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
  }
  throw new Error('waitFor timed out');
}

function loadingGone(host: HTMLDivElement): boolean {
  return !host.textContent?.includes('Loading…');
}

describe('ArtifactView — beyond-markdown file types render, never hang on Loading…', () => {
  let host: HTMLDivElement;
  let root: Root;
  let queryClient: QueryClient;

  beforeEach(() => {
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    queryClient = new QueryClient();
    // Session mode memory is module state — without this, a test that
    // toggles a file to Edit changes every later test's cold-open mode.
    resetPreviewModeMemoryForTests();
    mocks.read.mockReset();
    mocks.write.mockReset().mockResolvedValue({ success: true, data: undefined });
    mocks.watch.mockReset();
    mocks.unwatch.mockReset();
    mocks.readBinary.mockReset();
    mocks.commentsCacheGet.mockReset().mockResolvedValue(null);
    mocks.commentsCacheSet.mockReset().mockResolvedValue({ success: true, data: undefined });
    // Settles the store into a terminal, non-polling state immediately —
    // none of these tests exercise comments, only the pane hosting them.
    mocks.commentsResolveTarget.mockReset().mockResolvedValue({
      success: false,
      error: { kind: 'notBound', message: 'Not bound' },
    });
    mocks.commentsList.mockReset().mockResolvedValue({ success: true, data: { messages: [] } });
    mocks.commentsCreate.mockReset();
    mocks.contextCreateTarget.mockReset().mockResolvedValue({
      success: true,
      data: { targetRef: 'test-target' },
    });
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    host.remove();
  });

  async function renderArtifact(path: string): Promise<void> {
    await act(async () => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <ArtifactView root="/repo" rootId="repo-1" path={path} onNavigateFolder={() => {}} />
        </QueryClientProvider>
      );
    });
  }

  it('renders rig.toml content instead of hanging on Loading… forever (the reported bug)', async () => {
    mocks.read.mockImplementation(() =>
      resolveOnMacrotask({ success: true, data: { content: 'key = "value"\n', truncated: false } })
    );

    await renderArtifact('/repo/rig.toml');
    expect(host.textContent).toContain('Loading…');

    await waitFor(() => loadingGone(host));

    expect(host.textContent).not.toContain('Loading…');
    const content = host.querySelector('.cm-content');
    expect(content?.textContent).toContain('key = "value"');
    // The header and the body must agree the load actually completed.
    // Session-first round 2: "Saved" is a transient moment now, not a
    // resident label — a completed, untouched load shows NO save status at
    // all. What would betray the frozen-default bug today is a stuck
    // "Saving…" indicator.
    expect(host.textContent).not.toContain('Saving…');

    // Follow-up from Dylan: rig.toml was rendering as unformatted
    // proportional-font prose. Pin both halves of the fix — mono/code
    // presentation (`docCodeTypography`, applied whenever `language !==
    // 'markdown'`) and real toml syntax highlighting (the legacy-modes
    // `StreamLanguage` grammar, `doc-editor.tsx`'s `languageExtension`).
    const scroller = host.querySelector('.cm-scroller');
    expect(getComputedStyle(scroller!).fontFamily).toContain('Geist Mono');
    expect(getComputedStyle(host.querySelector('.cm-editor')!).fontSize).toBe('13px');

    const baseColor = getComputedStyle(content!).color;
    const keySpan = Array.from(content!.querySelectorAll('span')).find(
      (el) => el.textContent === 'key'
    );
    expect(keySpan).toBeTruthy();
    expect(getComputedStyle(keySpan!).color).not.toBe(baseColor);
  });

  it('renders image content instead of hanging on Loading… forever', async () => {
    mocks.readBinary.mockImplementation(() =>
      resolveOnMacrotask({
        success: true,
        data: { data: btoa('not-real-png-bytes'), truncated: false, size: 19 },
      })
    );

    await renderArtifact('/repo/photo.png');
    expect(host.textContent).toContain('Loading…');

    await waitFor(() => loadingGone(host));

    expect(host.textContent).not.toContain('Loading…');
    expect(host.querySelector('img')?.getAttribute('src')).toContain('data:image/png;base64,');
  });

  it('settles the image error state when reading the image rejects', async () => {
    mocks.readBinary.mockRejectedValue(new Error('read failed'));

    await act(async () => {
      root.render(
        <ImageArtifact root="/repo" rootId="root-1" path="/repo/photo.png" mime="image/png" />
      );
    });

    await waitFor(() => !host.textContent?.includes('Loading…'));

    expect(host.textContent).toContain("Couldn't read this image.");
  });

  it('renders the unsupported empty state instead of hanging on Loading… forever', async () => {
    // An unrecognized extension routes through the binary sniff
    // (`use-file-type.ts`); a null byte in the sample is what earns it
    // `category: 'unsupported'` (`file-type.ts`'s `looksBinary`).
    mocks.readBinary.mockImplementation(() =>
      resolveOnMacrotask({
        success: true,
        data: { data: btoa('\0\x01\x02binarydata'), truncated: false, size: 12 },
      })
    );

    await renderArtifact('/repo/data.xyz');
    expect(host.textContent).toContain('Loading…');

    await waitFor(() => loadingGone(host));

    expect(host.textContent).not.toContain('Loading…');
    expect(host.textContent).toContain('No preview for this file type.');
  });

  it('renders extensionless text content instead of hanging on Loading… forever', async () => {
    // No extension at all (e.g. a `README`) also routes through the sniff;
    // plain-text bytes (no null byte) resolve to the SAME editable pane
    // `rig.toml` uses, via a different path through `use-file-type.ts`.
    mocks.readBinary.mockImplementation(() =>
      resolveOnMacrotask({
        success: true,
        data: { data: btoa('hello from an extensionless file\n'), truncated: false, size: 34 },
      })
    );
    mocks.read.mockImplementation(() =>
      resolveOnMacrotask({
        success: true,
        data: { content: 'hello from an extensionless file\n', truncated: false },
      })
    );

    await renderArtifact('/repo/README');
    expect(host.textContent).toContain('Loading…');

    await waitFor(() => loadingGone(host));

    expect(host.textContent).not.toContain('Loading…');
    expect(host.querySelector('.cm-content')?.textContent).toContain(
      'hello from an extensionless file'
    );
  });

  it('defaults a markdown file to Preview, and the toggle switches to Edit (preview-mode-spec.md)', async () => {
    mocks.read.mockImplementation(() =>
      resolveOnMacrotask({
        success: true,
        data: { content: '# Hello\n\nWorld body text.\n', truncated: false },
      })
    );

    await renderArtifact('/repo/notes.md');
    await waitFor(() => loadingGone(host));

    // Preview by default: rendered markdown, no CM6 editor mounted at all.
    // (Tailwind's generated utility layer isn't loaded in this harness — only
    // `tokens.css` is imported above, same as every other test in this file
    // — so this checks structure/content, not the Tailwind-driven typography
    // itself.)
    expect(host.querySelector('.cm-content')).toBeNull();
    expect(host.querySelector('h1')?.textContent).toBe('Hello');
    expect(host.textContent).toContain('World body text.');

    const editButton = Array.from(host.querySelectorAll('button')).find(
      (button) => button.getAttribute('aria-label') === 'Edit'
    );
    expect(editButton).toBeTruthy();
    await act(async () => {
      editButton!.click();
    });

    // Edit is CM6, byte-for-byte the raw source — no rendered heading.
    expect(host.querySelector('.cm-content')?.textContent).toContain('# Hello');
    expect(host.querySelector('h1')).toBeNull();
  });

  it('turns one Preview selection into both a comment affordance and a passage context target', async () => {
    const sourceSelection = 'The Q3\nforecast is $4.2m.';
    mocks.read.mockResolvedValue({
      success: true,
      data: { content: `# Forecast\n\n${sourceSelection}\n`, truncated: false },
    });
    mocks.commentsResolveTarget.mockResolvedValue({
      success: true,
      data: {
        target: {
          bindingId: 'binding-1',
          relayUrl: 'https://relay.example',
          relPath: 'forecast.md',
        },
        selfUserId: 'user-1',
      },
    });

    await renderArtifact('/repo/forecast.md');
    await waitFor(() => loadingGone(host));

    const paragraphText = Array.from(host.querySelectorAll('p'))
      .flatMap((paragraph) => Array.from(paragraph.childNodes))
      .find(
        (node): node is Text =>
          node.nodeType === Node.TEXT_NODE && node.textContent?.includes('The Q3') === true
      );
    expect(paragraphText).toBeTruthy();

    await act(async () => {
      const range = document.createRange();
      range.selectNodeContents(paragraphText!);
      const selection = window.getSelection();
      selection?.removeAllRanges();
      selection?.addRange(range);
      document.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
    });

    await waitFor(() =>
      mocks.contextCreateTarget.mock.calls.some(([input]) => {
        const anchor = (input as { anchor?: { exact?: string } }).anchor;
        return anchor?.exact === sourceSelection;
      })
    );
    const commentButton = Array.from(document.body.querySelectorAll('button')).find(
      (button) => button.textContent?.trim() === 'Comment'
    );
    expect(commentButton).toBeTruthy();

    await act(async () => commentButton!.click());
    await waitFor(
      () =>
        host.querySelector('[data-comments-rail]')?.textContent?.includes('The Q3') === true &&
        host.querySelector('textarea[placeholder="Add a comment — @ to mention"]') !== null
    );
  });

  it('repaints CM6 markers and the margin after a Preview → Edit round-trip, with no content change (preview-mode-spec.md rollout step 3)', async () => {
    mocks.read.mockImplementation(() =>
      resolveOnMacrotask({
        success: true,
        data: {
          content: '# Notes\n\nThis paragraph has a commented phrase inside it.\n',
          truncated: false,
        },
      })
    );
    mocks.commentsResolveTarget.mockReset().mockResolvedValue({
      success: true,
      data: {
        target: { bindingId: 'binding-1', relayUrl: 'https://relay.example', relPath: 'notes.md' },
        selfUserId: 'user-1',
      },
    });
    mocks.commentsList.mockReset().mockResolvedValue({
      success: true,
      data: {
        messages: [
          {
            id: 'msg-1',
            seq: '1',
            bindingId: 'binding-1',
            author: { userId: 'user-1', name: 'Dylan', avatarUrl: null, kind: 'user' },
            kind: 'comment',
            body: 'Nice catch!',
            parentId: null,
            intentId: null,
            path: 'notes.md',
            meta: null,
            anchor: { exact: 'commented phrase' },
            resolvedAt: null,
            resolvedBy: null,
            createdAt: '2026-08-27T00:00:00.000Z',
            editedAt: null,
            deletedAt: null,
          },
        ],
      },
    });

    await renderArtifact('/repo/notes.md');
    await waitFor(() => loadingGone(host));

    const findButton = (label: string) =>
      Array.from(host.querySelectorAll('button')).find(
        (button) => button.getAttribute('aria-label') === label
      );

    // Preview by default — flip to Edit first, the CM6 view's FIRST mount,
    // to establish the marker/margin baseline before the round-trip this
    // test is actually about.
    await act(async () => {
      findButton('Edit')!.click();
    });
    // Generous timeout: this path chains two RPC round trips (resolveTarget,
    // then list) plus a CM6 mount before the first paint, on top of the
    // 20ms macrotask the disk-read mock already imposes.
    await waitFor(() => host.querySelectorAll('.cm-rigComment').length > 0, 8000);
    expect(host.querySelector('[data-comments-rail]')?.textContent).toContain('Nice catch!');

    // Preview → Edit: DocEditor unmounts and remounts with a fresh
    // EditorView that starts with NO markers — this is the exact case
    // `artifact-view.tsx`'s `useEffect(() => comments?.syncMarkers(), [comments, mode])`
    // exists to fix. No content change happens anywhere in this sequence.
    await act(async () => {
      findButton('Preview')!.click();
    });
    expect(host.querySelector('.cm-content')).toBeNull();

    await act(async () => {
      findButton('Edit')!.click();
    });

    // The regression: without the `mode`-keyed repaint, these would stay
    // empty until some unrelated content change happened to trigger a
    // re-anchor. No new network round trip is needed this time (the store
    // already has the threads), so this settles quickly.
    await waitFor(() => host.querySelectorAll('.cm-rigComment').length > 0);
    expect(host.querySelector('[data-comments-rail]')?.textContent).toContain('Nice catch!');
  });

  /** The one `[data-comments-rail]` card whose body includes `text`, or undefined if none is listed yet. */
  function findCard(text: string): HTMLElement | undefined {
    return Array.from(host.querySelectorAll('[data-comments-rail] > div')).find((div) =>
      div.textContent?.includes(text)
    ) as HTMLElement | undefined;
  }

  /** The card's own computed `top` (its inline `style.top`, set by `useMarginLayout`), or `NaN` if it isn't listed. */
  function cardTop(text: string): number {
    const card = findCard(text);
    return card ? Number.parseFloat(card.style.top) : Number.NaN;
  }

  /**
   * Whether the card is rendered in its active (accent-border) state.
   * `findCard`'s element is `MarginRail`'s own positioned wrapper div (it
   * owns `style.top`); the `border-accent` class lives one level down, on
   * `Card`'s own root — the actual `ThreadCard`/`NewThreadCard`.
   */
  function cardIsActive(text: string): boolean {
    const wrapper = findCard(text);
    const card = wrapper?.firstElementChild;
    return (card?.className ?? '').includes('border-accent');
  }

  function findButton(label: string): HTMLButtonElement | undefined {
    return Array.from(host.querySelectorAll('button')).find(
      (button) => button.getAttribute('aria-label') === label
    ) as HTMLButtonElement | undefined;
  }

  /**
   * Polls `cardTop(text)` across real animation frames until it holds the
   * same value for several frames in a row — the settle triggers this
   * round adds (`document.fonts.ready`, a `ResizeObserver`, the
   * surface-adapter epoch bump) each land on their OWN later frame, not
   * necessarily the next one, so a fixed frame count is exactly the kind
   * of timing assumption this fix removes from the production code and
   * shouldn't be reintroduced here.
   *
   * `0` is `useMarginLayout`'s own unmeasured fallback (`tops.get(key) ??
   * 0`) — indistinguishable, from the DOM alone, from a card that's
   * GENUINELY meant to sit at the very top. A brand-new card reads `0` for
   * at least the first frame or two before any measurement has landed,
   * which would otherwise read as "stable" by pure luck if that happened
   * to be the first value sampled. Requiring the FIRST plateau to be
   * non-zero sidesteps that false read without needing to guess how many
   * frames the real settle chain takes.
   */
  async function waitForStableTop(text: string, timeoutMs = 4000): Promise<number> {
    const deadline = Date.now() + timeoutMs;
    let last = cardTop(text);
    let stableFrames = 0;
    while (Date.now() < deadline) {
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
      const next = cardTop(text);
      const settled = Number.isFinite(next) && next !== 0 && next === last;
      stableFrames = settled ? stableFrames + 1 : 0;
      last = next;
      if (stableFrames >= 5) return next;
    }
    throw new Error(`card top for "${text}" never stabilized (last=${last})`);
  }

  it('settles the Preview margin card beside its anchor on cold open — no Edit round trip needed (DEFECT 1)', async () => {
    // Twelve filler paragraphs push the anchor well below the top of the
    // pane — the bug this covers pins the card near `top: 0` regardless of
    // where its anchor actually is, so a short document could pass by
    // accident even when broken.
    const filler = Array.from({ length: 12 }, (_, i) => `Filler paragraph number ${i + 1}.`).join(
      '\n\n'
    );
    mocks.read.mockImplementation(() =>
      resolveOnMacrotask({
        success: true,
        data: {
          content: `# Notes\n\n${filler}\n\nThis paragraph has a commented phrase inside it.\n`,
          truncated: false,
        },
      })
    );
    mocks.commentsResolveTarget.mockReset().mockResolvedValue({
      success: true,
      data: {
        target: { bindingId: 'binding-1', relayUrl: 'https://relay.example', relPath: 'notes.md' },
        selfUserId: 'user-1',
      },
    });
    mocks.commentsList.mockReset().mockResolvedValue({
      success: true,
      data: {
        messages: [
          {
            id: 'msg-1',
            seq: '1',
            bindingId: 'binding-1',
            author: { userId: 'user-1', name: 'Dylan', avatarUrl: null, kind: 'user' },
            kind: 'comment',
            body: 'Nice catch!',
            parentId: null,
            intentId: null,
            path: 'notes.md',
            meta: null,
            anchor: { exact: 'commented phrase' },
            resolvedAt: null,
            resolvedBy: null,
            createdAt: '2026-08-27T00:00:00.000Z',
            editedAt: null,
            deletedAt: null,
          },
        ],
      },
    });

    await renderArtifact('/repo/notes.md');
    await waitFor(() => loadingGone(host));

    // Preview is the default mode. Wait for the thread to actually be
    // listed (the relay round trip), then give the settle triggers
    // (`document.fonts.ready`, the preview-root `ResizeObserver`) a couple
    // of real frames to run — the whole point of this round's fix is that
    // NOTHING else needs to happen for the card to land correctly.
    await waitFor(
      () => (host.querySelector('[data-comments-rail]')?.textContent ?? '').includes('Nice catch!'),
      8000
    );
    // The comments round trip can beat the file read under suite load, and a
    // card whose document hasn't rendered yet stabilizes at the null-anchor
    // fallback position — a real, correct intermediate state, but not the
    // one this test measures. Cold open's subject is "card beside its anchor
    // once the document is on screen", so wait for the document too.
    await waitFor(() => host.querySelector('h1') !== null, 8000);
    // Real web-font loading (the custom faces `tokens.css` declares) can
    // genuinely reflow this much filler text — the exact "fonts loading"
    // case DEFECT 1 names — so wait on the SAME signal the fix itself
    // listens for (`use-preview-comments.ts`'s `document.fonts.ready.then`)
    // before measuring anything, same as a real reader's first paint would.
    await document.fonts.ready;

    const coldOpenTop = await waitForStableTop('Nice catch!');
    console.error(
      'DEBUG cold p count',
      host.querySelectorAll('p').length,
      'h1 count',
      host.querySelectorAll('h1').length,
      'h1 text',
      host.querySelector('h1')?.textContent,
      'first p text',
      host.querySelector('p')?.textContent
    );
    // Without the fix this stays pinned near 0 (`MarginRail`'s layout
    // effect runs — and bails, `surface.ready()` false — before the
    // parent's own effect has registered the real Preview surface adapter;
    // see `setSurfaceAdapter`'s doc comment) even though the anchor, 12
    // filler paragraphs down, sits well below.
    expect(coldOpenTop).toBeGreaterThan(150);

    // The spec's own acceptance bar: identical to what a Preview → Edit →
    // Preview round trip produces.
    await act(async () => {
      findButton('Edit')!.click();
    });
    await waitFor(() => host.querySelectorAll('.cm-rigComment').length > 0, 8000);
    await act(async () => {
      findButton('Preview')!.click();
    });
    await waitFor(
      () => (host.querySelector('[data-comments-rail]')?.textContent ?? '').includes('Nice catch!'),
      8000
    );

    await document.fonts.ready;
    const roundTripTop = await waitForStableTop('Nice catch!');
    console.error(
      'DEBUG roundtrip p count',
      host.querySelectorAll('p').length,
      'h1 count',
      host.querySelectorAll('h1').length,
      'h1 text',
      host.querySelector('h1')?.textContent,
      'first p text',
      host.querySelector('p')?.textContent
    );
    expect(roundTripTop).toBeCloseTo(coldOpenTop, 0);
  });

  it('keeps the margin card active (accent border) after switching Preview → Edit with a thread already active (DEFECT 3)', async () => {
    mocks.read.mockImplementation(() =>
      resolveOnMacrotask({
        success: true,
        data: {
          content: '# Notes\n\nThis paragraph has a commented phrase inside it.\n',
          truncated: false,
        },
      })
    );
    mocks.commentsResolveTarget.mockReset().mockResolvedValue({
      success: true,
      data: {
        target: { bindingId: 'binding-1', relayUrl: 'https://relay.example', relPath: 'notes.md' },
        selfUserId: 'user-1',
      },
    });
    mocks.commentsList.mockReset().mockResolvedValue({
      success: true,
      data: {
        messages: [
          {
            id: 'msg-1',
            seq: '1',
            bindingId: 'binding-1',
            author: { userId: 'user-1', name: 'Dylan', avatarUrl: null, kind: 'user' },
            kind: 'comment',
            body: 'Nice catch!',
            parentId: null,
            intentId: null,
            path: 'notes.md',
            meta: null,
            anchor: { exact: 'commented phrase' },
            resolvedAt: null,
            resolvedBy: null,
            createdAt: '2026-08-27T00:00:00.000Z',
            editedAt: null,
            deletedAt: null,
          },
        ],
      },
    });

    await renderArtifact('/repo/notes.md');
    await waitFor(() => loadingGone(host));
    await waitFor(
      () => (host.querySelector('[data-comments-rail]')?.textContent ?? '').includes('Nice catch!'),
      8000
    );
    // Let the card's own position settle before reading text coordinates
    // off the document below — both depend on the same layout pass.
    await waitForStableTop('Nice catch!');

    // Click the anchored phrase in the rendered Preview DOM — the same
    // path `use-preview-comments.ts`'s own click handler drives from a
    // real pointer event, via a `Range` over just that substring so the
    // synthetic click lands inside the painted highlight rather than
    // merely somewhere in its paragraph.
    await act(async () => {
      const walker = document.createTreeWalker(host, NodeFilter.SHOW_TEXT);
      let node: Text | null;
      let found = false;
      while ((node = walker.nextNode() as Text | null)) {
        const idx = node.data.indexOf('commented phrase');
        if (idx === -1) continue;
        const range = document.createRange();
        range.setStart(node, idx);
        range.setEnd(node, idx + 'commented phrase'.length);
        const rect = range.getBoundingClientRect();
        (node.parentElement ?? host).dispatchEvent(
          new MouseEvent('click', {
            bubbles: true,
            clientX: rect.left + rect.width / 2,
            clientY: rect.top + rect.height / 2,
          })
        );
        found = true;
        break;
      }
      expect(found).toBe(true);
    });

    await waitFor(() => cardIsActive('Nice catch!'));
    const previewTop = await waitForStableTop('Nice catch!');
    expect(previewTop).toBeGreaterThan(0);

    // Preview → Edit, with the thread already active: CM6's own gutter/
    // mark styling already gets this right (`comment-decorations.ts`); the
    // regression this covers is the margin card losing its accent border
    // (or landing somewhere unrelated to its anchor) on the same switch.
    await act(async () => {
      findButton('Edit')!.click();
    });
    await waitFor(() => host.querySelectorAll('.cm-rigCommentActive').length > 0, 8000);
    await waitForStableTop('Nice catch!');

    expect(cardIsActive('Nice catch!')).toBe(true);
    expect(cardTop('Nice catch!')).toBeGreaterThan(0);
  });
});
