import { ChevronRight } from 'lucide-react';
import {
  forwardRef,
  useImperativeHandle,
  useLayoutEffect,
  useRef,
  useState,
  type Ref,
} from 'react';
import ReactMarkdown, { type Components } from 'react-markdown';
import rehypeKatex from 'rehype-katex';
import remarkGfm from 'remark-gfm';
import remarkMath from 'remark-math';
import 'katex/dist/katex.min.css';
import {
  posAttr,
  positionComponents,
} from '@renderer/features/docs/preview/markdown-position-components';
import { buildPositionIndex, type PositionIndex } from '@renderer/features/docs/preview/position-index';
import { rpc } from '@renderer/lib/ipc';
import { cn } from '@renderer/lib/utils';
import { splitFrontmatter } from './frontmatter';

/**
 * The read-only rendered view of a markdown document (`preview-mode-spec.md`
 * "Shape"): react-markdown + remark-gfm + remark-math, centered at the same
 * ~68ch column and padding as the editor's own `.cm-content`
 * (`doc-editor-theme.ts`) so toggling Preview ⇄ Edit never reflows the page.
 *
 * Wires in Lane 1's `positionComponents` (`features/docs/preview/`) so every
 * rendered element carries `data-pos`, and rebuilds the position index after
 * every render (`PreviewHandle.getIndex()`, below) — the "core mechanism"
 * `preview-mode-spec.md` names. `PreviewPane` itself stays comments-agnostic
 * (no import from `docs/comments/`): the index is exposed on the ref for
 * whoever wants it (Lane 3's `artifact-view.tsx`), and is simply unused —
 * built for nothing — when nobody asks, so this component is equally usable
 * with no comments store at all.
 *
 * Math resolution: `remark-math` was already called out in the bundle, and
 * `katex`/`rehype-katex`/`@types/katex` are already dependencies with no
 * other caller — real KaTeX rendering rather than the spec's fallback
 * ("styled code blocks until demand"). Mermaid stays the fallback: it isn't
 * in the bundle, so a ```mermaid fence renders as a plain code block, per
 * the spec's own non-goals.
 */

const PREVIEW_BODY_CLASS = cn(
  'text-base leading-[1.7] text-text-primary',
  // Heading scale matches `docHighlightStyle` in doc-editor-theme.ts exactly
  // (1.6em/1.35em/1.15em, weight 650) — Edit mode scales the whole heading
  // LINE (marks included) to the same sizes, so Preview reads at the same
  // visual weight rather than merely a similar one.
  '[&_h1]:mt-8 [&_h1]:mb-3 [&_h1]:text-[1.6em] [&_h1]:font-[650] [&_h1]:leading-[1.3] [&_h1:first-child]:mt-0',
  '[&_h2]:mt-7 [&_h2]:mb-2.5 [&_h2]:text-[1.35em] [&_h2]:font-[650] [&_h2]:leading-[1.35]',
  '[&_h3]:mt-6 [&_h3]:mb-2 [&_h3]:text-[1.15em] [&_h3]:font-[650]',
  '[&_h4]:mt-5 [&_h4]:mb-1.5 [&_h4]:font-[650]',
  '[&_h5]:mt-5 [&_h5]:mb-1.5 [&_h5]:font-[650]',
  '[&_h6]:mt-5 [&_h6]:mb-1.5 [&_h6]:font-[650]',
  '[&_p]:my-3 [&_p:first-child]:mt-0 [&_p:last-child]:mb-0',
  '[&_strong]:font-[650] [&_em]:italic [&_del]:line-through',
  '[&_a]:text-accent [&_a]:underline [&_a]:underline-offset-2 [&_a]:cursor-pointer',
  '[&_ul]:my-3 [&_ol]:my-3 [&_li]:my-1 [&_ul]:list-disc [&_ol]:list-decimal [&_ul]:pl-5 [&_ol]:pl-5',
  '[&_li>ul]:my-1 [&_li>ol]:my-1',
  // Task-list items (GFM): the checkbox itself already renders `disabled` —
  // this only clears the bullet marker and gives the checkbox room, the
  // usual GFM task-list treatment.
  '[&_li.task-list-item]:list-none [&_li.task-list-item]:-ml-5',
  '[&_input]:mr-1.5 [&_input]:align-middle [&_input]:accent-accent',
  // Inline code — same tag values as `docHighlightStyle`'s `t.monospace`.
  "[&_code]:font-mono [&_code]:text-[0.9em] [&_code]:bg-bg-2 [&_code]:rounded-[3px] [&_code]:px-[0.3em] [&_code]:py-[0.1em]",
  // Fenced code blocks: same Geist Mono/13px the non-markdown code pane uses
  // (`docCodeTypography`) — no syntax highlighting, matching Edit mode's own
  // markdown grammar, which has no embedded-language parser configured either.
  '[&_pre]:my-3 [&_pre]:bg-bg-2 [&_pre]:rounded-control [&_pre]:p-3 [&_pre]:overflow-x-auto',
  '[&_pre_code]:bg-transparent [&_pre_code]:p-0 [&_pre_code]:text-sm [&_pre_code]:leading-[1.6]',
  '[&_blockquote]:my-3 [&_blockquote]:border-l-2 [&_blockquote]:border-border-strong [&_blockquote]:pl-3 [&_blockquote]:text-text-secondary [&_blockquote]:italic',
  '[&_hr]:my-6 [&_hr]:border-border-hairline',
  '[&_table]:w-full [&_table]:border-collapse [&_table]:text-sm',
  '[&_th]:border [&_th]:border-border-hairline [&_th]:bg-bg-2 [&_th]:px-2.5 [&_th]:py-1.5 [&_th]:text-left [&_th]:font-[650]',
  '[&_td]:border [&_td]:border-border-hairline [&_td]:px-2.5 [&_td]:py-1.5'
);

/** Imperative surface exposed to whoever wants the position index (Lane 3's comments wiring — see this file's own doc comment). */
export interface PreviewHandle {
  /** The rendered markdown's DOM root — every `data-pos`-stamped element lives under here. */
  getRoot(): HTMLElement | null;
  /**
   * The current position index, or null before the first render has
   * committed. Offsets are in the SAME coordinate space as the full
   * document content passed to `PreviewPane` (frontmatter included) — see
   * `shiftIndex` below, which is what makes that true even though the index
   * itself is built against the frontmatter-STRIPPED `body`.
   */
  getIndex(): PositionIndex | null;
}

/**
 * `positionComponents` stamps `data-pos` using each node's position in
 * whatever string was parsed — `body`, with frontmatter already stripped —
 * so a position out of `buildPositionIndex(root, body)` is body-relative.
 * The comments layer (and everyone else calling `PreviewHandle.getIndex()`)
 * works in FULL document offsets (frontmatter included) — the same space
 * `DocCommentsStore`'s anchors and CM6's own offsets already use. This
 * shifts every offset crossing the index's public API by the frontmatter
 * block's length, so that mismatch never leaks past this file.
 */
function shiftIndex(index: PositionIndex, offset: number): PositionIndex {
  if (offset === 0) return index;
  return {
    domToSource: (node, o) => {
      const src = index.domToSource(node, o);
      return src === null ? null : src + offset;
    },
    rangeToSource: (range) => {
      const r = index.rangeToSource(range);
      return r === null ? null : { start: r.start + offset, end: r.end + offset };
    },
    sourceToDom: (start, end) => index.sourceToDom(start - offset, end - offset),
  };
}

const positionedComponents: Components = {
  ...positionComponents,
  // External links open in the system browser, never navigate the renderer
  // — same convention `comment-markdown.tsx` already uses. Stamps `data-pos`
  // itself (rather than delegating to `positionComponents.a`) since it also
  // needs the click-intercept `positionComponents.a` doesn't know about.
  a: ({ node, href, children, ...rest }) => (
    <a
      {...rest}
      href={href}
      data-pos={posAttr(node)}
      onClick={(event) => {
        event.preventDefault();
        if (href) void rpc.app.openExternal(href);
      }}
    >
      {children}
    </a>
  ),
  // A wide GFM table scrolls in its own box rather than blowing out the
  // 68ch column — the same convention code blocks use. The `<table>`
  // element itself is kept (and stamped) rather than replaced by the
  // wrapper `div`, so a table's own `data-pos` — and the index's own
  // table/tr/td/th coverage — survive this override.
  table: ({ node, children, ...rest }) => (
    <div className="my-3 overflow-x-auto">
      <table {...rest} data-pos={posAttr(node)}>
        {children}
      </table>
    </div>
  ),
};

function PreviewPaneInner(
  { content }: { content: string },
  ref: Ref<PreviewHandle>
) {
  const { raw: frontmatter, body } = splitFrontmatter(content);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const indexRef = useRef<PositionIndex | null>(null);

  useImperativeHandle(
    ref,
    () => ({
      getRoot: () => rootRef.current,
      getIndex: () => indexRef.current,
    }),
    []
  );

  // Rebuilds on every content change — react-markdown re-renders the whole
  // tree on new `body` text, and this runs (as a layout effect) right after
  // that commits, before the browser paints. See
  // `features/docs/preview/use-preview-comments.ts` for why the comments
  // layer's OWN repaint is also a layout effect: it depends on this one
  // having already run.
  useLayoutEffect(() => {
    const root = rootRef.current;
    indexRef.current = root ? shiftIndex(buildPositionIndex(root, body), frontmatter?.length ?? 0) : null;
  }, [body, frontmatter]);

  return (
    <div className="mx-auto max-w-[68ch] px-6 pt-12 pb-[60vh]">
      {frontmatter && <PropertiesChip raw={frontmatter} />}
      <div ref={rootRef} className={PREVIEW_BODY_CLASS}>
        <ReactMarkdown
          remarkPlugins={[remarkGfm, remarkMath]}
          rehypePlugins={[rehypeKatex]}
          components={positionedComponents}
        >
          {body}
        </ReactMarkdown>
      </div>
    </div>
  );
}

export const PreviewPane = forwardRef(PreviewPaneInner);

/**
 * Frontmatter never renders as body text (this file's own strip above) —
 * instead a quiet collapsed chip sits above the document, expanding to the
 * raw block in monospace on click. Delimiters trimmed off the expanded view;
 * the reader wants to see their own YAML, not the fence around it.
 */
function PropertiesChip({ raw }: { raw: string }) {
  const [open, setOpen] = useState(false);
  const inner = raw.replace(/^---\n/, '').replace(/\n---\n$/, '');

  return (
    <div className="mt-2 mb-6">
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        aria-expanded={open}
        className="flex items-center gap-1 rounded-chip border border-border-hairline px-2 py-0.5 text-xs text-text-muted transition-colors hover:bg-bg-2 hover:text-text-primary"
      >
        <ChevronRight
          className={cn('size-3 transition-transform', open && 'rotate-90')}
          strokeWidth={1.5}
        />
        Properties
      </button>
      {open && (
        <pre className="mt-2 overflow-x-auto rounded-control border border-border-hairline bg-bg-2 p-3 font-mono text-xs text-text-secondary">
          {inner}
        </pre>
      )}
    </div>
  );
}
