/**
 * Execute — SolidJS components for ChatExecute rows (design-system Rule 9:
 * "quiet lines, not boxes — full fidelity, layered rendering").
 *
 *   Ran `pnpm run build --filter=...`                       ✓   ← primary line, always
 *   ⤷ live last output line while running / purpose once settled  ← subtext, collapsed only
 *
 *   Ran `pnpm run build --filter=...`                       ✓   ← expanded: primary line
 *   │  pnpm run build --filter=...                              ← inset: full command (muted)
 *   │  Building 4 packages…                                     ← inset: full output (primary)
 *   │  ...
 *
 * The header (primary line) is `CollapsibleCard`'s `chrome="line"` — no
 * border, no card shell. `ExecuteBody` renders ONLY the expanded inset (a
 * subtle left hairline, not a box) — the collapsed subtext ticker is a
 * plain single line rendered directly by `execute.def.tsx`, not through
 * this component.
 */

import { useCaches } from '@components/contexts/CachesContext';
import { cancelIdle, scheduleIdle } from '@components/engine/dom-utils';
import { applyTokensToElement, type CodeToken } from '@core/highlight/apply-tokens';
import { For, createEffect, onCleanup } from 'solid-js';
import type { ChatExecute } from '@/model';
import {
  executeBody,
  executeCommandLine,
  executeInset,
  executeLine,
  executeSpacerLine,
} from './execute.css';

// ── ExecuteBody (expanded inset only) ───────────────────────────────────────────

export type ExecuteDisplayLine = {
  kind: 'command' | 'spacer' | 'output';
  text: string;
};

export type ExecuteBodyProps = {
  item: ChatExecute;
  lines: ExecuteDisplayLine[];
  bodyH: number;
  contentH: number;
  codeLineH: number;
  linePadX: number;
  scrollbarH: number;
  scrollbarGap: number;
};

export function ExecuteBody(props: ExecuteBodyProps) {
  const caches = useCaches();
  const lineEls = new Map<number, HTMLElement>();

  createEffect(() => {
    const commandLines = props.lines
      .map((line, index) => ({ line, index }))
      .filter(({ line }) => line.kind === 'command');
    const command = commandLines.map(({ line }) => line.text).join('\n');
    if (!command || !lineEls.size) return;

    function paint(tokenLines: CodeToken[][]): void {
      for (let i = 0; i < commandLines.length; i++) {
        const el = lineEls.get(commandLines[i].index);
        const tokens = tokenLines[i];
        if (el && tokens) applyTokensToElement(el, tokens);
      }
    }

    const cached = caches.peekHighlight(command, 'bash');
    if (cached) {
      paint(cached.lines);
      return;
    }

    let cancelled = false;
    const handle = scheduleIdle(() => {
      if (cancelled) return;
      const result = caches.highlight(command, 'bash');
      if (cancelled || !result) return;
      paint(result.lines);
    });

    onCleanup(() => {
      cancelled = true;
      cancelIdle(handle);
    });
  });

  const overflows = () => props.contentH > props.bodyH;

  return (
    <div class={executeInset}>
      <div
        class={executeBody}
        style={{
          height: `${props.bodyH}px`,
          'padding-bottom': `${props.scrollbarH + props.scrollbarGap}px`,
          '--execute-scrollbar-size': `${props.scrollbarH}px`,
          'overflow-x': 'auto',
          'overflow-y': overflows() ? 'auto' : 'hidden',
        }}
      >
        <For each={props.lines}>
          {(line, i) => (
            <div
              ref={(el) => {
                lineEls.set(i(), el);
                onCleanup(() => lineEls.delete(i()));
              }}
              class={executeLine}
              classList={{
                [executeCommandLine]: line.kind === 'command',
                [executeSpacerLine]: line.kind === 'spacer',
              }}
              style={{
                height: `${props.codeLineH}px`,
                'line-height': `${props.codeLineH}px`,
                'padding-left': `${props.linePadX}px`,
                'padding-right': `${props.linePadX}px`,
              }}
            >
              {line.text}
            </div>
          )}
        </For>
      </div>
    </div>
  );
}
