import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { ArtifactView } from '@renderer/features/artifact/artifact-view';
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
  read: vi.fn<(path: string, maxBytes: number) => Promise<unknown>>(),
  write: vi.fn<(path: string, content: string) => Promise<unknown>>(),
  watch: vi.fn<(root: string) => void>(),
  unwatch: vi.fn<(root: string) => void>(),
  readBinary: vi.fn<(path: string, maxBytes: number) => Promise<unknown>>(),
}));

vi.mock('@renderer/lib/ipc', () => ({
  rpc: {
    rig: {
      files: {
        read: (...args: unknown[]) => mocks.read(...(args as [string, number])),
        write: (...args: unknown[]) => mocks.write(...(args as [string, string])),
        watch: (...args: unknown[]) => mocks.watch(...(args as [string])),
        unwatch: (...args: unknown[]) => mocks.unwatch(...(args as [string])),
        readBinary: (...args: unknown[]) => mocks.readBinary(...(args as [string, number])),
      },
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
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT =
    true;
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

  beforeEach(() => {
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    mocks.read.mockReset();
    mocks.write.mockReset().mockResolvedValue({ success: true, data: undefined });
    mocks.watch.mockReset();
    mocks.unwatch.mockReset();
    mocks.readBinary.mockReset();
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    host.remove();
  });

  async function renderArtifact(path: string): Promise<void> {
    await act(async () => {
      root.render(
        <ArtifactView root="/repo" path={path} onClose={() => {}} onNavigateFolder={() => {}} />
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
    // The header's Saved indicator and the body must agree — both reflecting
    // the same, actually-completed load, not the header's frozen default.
    expect(host.textContent).toContain('Saved');

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
});
