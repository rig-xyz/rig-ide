import { forwardRef, useImperativeHandle, useMemo, useRef } from 'react';
import { highlightJson, prettyJson } from './json-preview';
import type { PreviewHandle } from './preview-pane';

/**
 * Preview for a JSON file (`json-preview.ts`): pretty printed and colored,
 * read only, live with the file. Text that doesn't parse shows as it is
 * under a one-line note. The handle gives reading find its root; there is no
 * position index, since JSON files take no comments.
 */
export const JsonPreviewPane = forwardRef<PreviewHandle, { content: string }>(function JsonPreviewPane({ content }, ref) {
  const rootRef = useRef<HTMLPreElement | null>(null);
  useImperativeHandle(ref, () => ({ getRoot: () => rootRef.current, getIndex: () => null }), []);
  const pretty = useMemo(() => prettyJson(content), [content]);
  const lines = useMemo(() => highlightJson(pretty ?? content), [pretty, content]);
  return (
    <div data-testid="json-preview">
      {pretty === null && (
        <div className="border-b border-border-hairline bg-bg-1 px-6 py-1.5 text-xs text-text-muted" data-testid="json-preview-invalid">
          This isn't valid JSON, so it shows as written.
        </div>
      )}
      <pre ref={rootRef} className="px-6 pt-6 pb-[60vh] font-mono text-[13px] leading-[1.6] whitespace-pre-wrap break-words text-text-primary select-text">
        {lines.map((line, i) => (
          <div key={i}>
            {line.length === 0 ? '\n' : line.map((span, j) => (span.className ? <span key={j} className={span.className}>{span.text}</span> : span.text))}
          </div>
        ))}
      </pre>
    </div>
  );
});
