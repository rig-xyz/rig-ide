import { BLOCK_REGISTRY } from '@components/rows/markdown/block-registry';
import type { StackLayout } from '@core/compose';
import type { Measured } from '@core/define';
import { quoteRailX } from '@components/rows/markdown/prose/geometry';
import { pquoteRail, quoteRailBar } from '@components/rows/markdown/prose/prose.css';
import type { BlockLeafLayout } from '@core/layout/layout-types';
import type { QuoteRef } from '@core/markdown/document';
import { For, createMemo } from 'solid-js';
import { Dynamic } from 'solid-js/web';

function BlockLeafRender(props: { node: Measured<BlockLeafLayout> }) {
  const def = BLOCK_REGISTRY[props.node.layout.kind];
  if (!def) return null;
  // oxlint-disable-next-line typescript/no-explicit-any -- registry boundary
  return <Dynamic component={def.Render} node={props.node as any} />;
}

export type BlockStackViewProps = {
  node: Measured<StackLayout>;
};

type QuoteBar = { left: number; top: number; bottom: number; lastIndex: number };

/**
 * One bar per run of consecutive blocks inside the same blockquote, spanning
 * the gaps between them (a per-block bar broke at every block margin). Nested
 * quotes each get their own bar. Positioned in stack coordinates, so it never
 * affects any block's height.
 */
function quoteBars(placed: StackLayout['placed']): QuoteBar[] {
  const bars: QuoteBar[] = [];
  const open = new Map<string, QuoteBar>();
  placed.forEach((p, i) => {
    const raw = (p.child.layout as { raw?: { quotes?: QuoteRef[] } }).raw;
    for (const quote of raw?.quotes ?? []) {
      const bottom = p.top + p.child.height;
      const bar = open.get(quote.id);
      if (bar && bar.lastIndex === i - 1) {
        bar.bottom = bottom;
        bar.lastIndex = i;
      } else {
        const next = { left: quoteRailX(quote.depth), top: p.top, bottom, lastIndex: i };
        open.set(quote.id, next);
        bars.push(next);
      }
    }
  });
  return bars;
}

export function BlockStackView(props: BlockStackViewProps) {
  const placed = () => props.node.layout.placed;
  const bars = createMemo(() => quoteBars(placed()));
  return (
    <div style={{ position: 'relative', height: `${props.node.height}px`, width: '100%' }}>
      <For each={bars()}>
        {(bar) => (
          <div
            class={`${pquoteRail} ${quoteRailBar}`}
            style={{
              left: `${bar.left}px`,
              top: `${bar.top}px`,
              height: `${bar.bottom - bar.top}px`,
            }}
          />
        )}
      </For>
      {/*
       * Key by reference. stack() rebuilds placed[] with fresh wrapper objects
       * every layout pass, so <For> recreates each row on every streaming chunk.
       * That remount is intentional: block defs snapshot props.node.layout at
       * mount (e.g. `const l = props.node.layout` in code.def / prose.def), so a
       * growing block's content only stays in sync if its row is recreated when
       * the layout changes. (A persistent-row optimization keyed by block id was
       * tried and reverted — it left growing blocks frozen at their first layout
       * while the reserved height kept growing, producing one-line code blocks
       * surrounded by blank space until the turn committed.)
       */}
      <For each={placed()}>
        {(p) => (
          <div
            style={{
              position: 'absolute',
              top: `${p.top}px`,
              left: 0,
              right: 0,
              height: `${p.child.height}px`,
            }}
          >
            <BlockLeafRender node={p.child as Measured<BlockLeafLayout>} />
          </div>
        )}
      </For>
    </div>
  );
}
