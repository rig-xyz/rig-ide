import { ROW_H } from '@components/engine/row-metrics';
import { CollapsibleCard } from '@components/primitives/CollapsibleCard';
import { IconTerminal } from '@components/primitives/icons';
import { measureProseNaturalWidth } from '@components/rows/markdown/prose/layout';
import type { MeasureCtx, RenderCtx } from '@core/define';
import type { ProseBlock } from '@core/markdown/document';
import { defineUnit } from '@core/units';
import { stripAnsi } from '@lib/ansi';
import { vars } from '@styles/theme.css';
import { Show, createMemo } from 'solid-js';
import type { ChatExecute } from '@/model';
import { executeSubtext } from './execute.css';
import { ExecuteBody, type ExecuteDisplayLine } from './Execute';

export { executeFromItem } from './execute.presenter';

export type ExecuteVars = {
  /** Fixed height (px) of the header row. */
  rowH: number;
  /** Height (px) of the collapsed-state subtext line (live ticker / purpose summary). */
  subtextH: number;
  /** Horizontal padding on each command/output line. */
  linePadX: number;
  /** Width and height of the thin native scrollbar. */
  scrollbarSize: number;
  /** Visual separation between command text and the horizontal scrollbar. */
  scrollbarGap: number;
  /** Max lines shown / scrollable in the expanded state. */
  expandedMaxLines: number;
};

const EXECUTE_VARS: ExecuteVars = {
  rowH: ROW_H,
  subtextH: 18,
  linePadX: 12,
  scrollbarSize: 8,
  scrollbarGap: 3,
  expandedMaxLines: 16,
};

function commandLines(command: string): string[] {
  return (command || '…').split('\n');
}

/** Command header cap — long enough to stay recognizable, short enough to stay a chip. */
const HEADER_COMMAND_MAX = 60;
/** Live-ticker / inputSummary subtext cap. */
const SUBTEXT_MAX = 90;

/**
 * The header's collapsed label: "Ran <first line of the command>", truncated.
 * Literal, not semantic — this names what ran, it does not try to guess what
 * it did (that's what the ✓/✗ glyph and the expanded body are for).
 */
function commandFragment(command: string): string {
  const firstLine = (command || '').trim().split('\n')[0]?.trim();
  if (!firstLine) return 'command';
  return firstLine.length > HEADER_COMMAND_MAX
    ? `${firstLine.slice(0, HEADER_COMMAND_MAX - 1)}…`
    : firstLine;
}

/**
 * Output lines, ANSI-stripped for display — the render path only (data/
 * persistence keep `outputText` byte-for-byte, per the hierarchy rule; see
 * `lib/ansi.ts`'s header comment). No color rendering yet (v1: strip, don't
 * colorize — flagged future work in that same file).
 */
function outputLines(outputText: string | undefined): string[] {
  if (!outputText) return [];
  return stripAnsi(outputText).replace(/\r\n/g, '\n').split('\n');
}

/**
 * The raw everything, for the expanded inset — full multi-line command
 * (de-emphasized: the header already named it) followed by the full output
 * (the new information, full prominence). Only reached when expanded; a
 * collapsed row never renders any of this — see Rule 9's "doesn't repeat
 * the collapsed line at the same prominence," not "never repeats at all."
 */
function executeLines(item: ChatExecute): ExecuteDisplayLine[] {
  const command = commandLines(item.command).map(
    (line): ExecuteDisplayLine => ({ kind: 'command', text: line })
  );
  const output = outputLines(item.outputText).map(
    (line): ExecuteDisplayLine => ({ kind: 'output', text: line })
  );
  return output.length > 0 ? [...command, { kind: 'spacer', text: '' }, ...output] : command;
}

/** Last non-empty output line, ANSI-stripped and truncated — "what's happening right now." */
function lastOutputLine(outputText: string | undefined): string | null {
  if (!outputText) return null;
  const lines = stripAnsi(outputText)
    .replace(/\r\n/g, '\n')
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  const last = lines.at(-1);
  if (!last) return null;
  return last.length > SUBTEXT_MAX ? `${last.slice(0, SUBTEXT_MAX - 1)}…` : last;
}

/**
 * The collapsed row's one optional subtext line — a live ticker of the
 * command's own output while it runs (design-system Rule 9: "a running tool
 * shows its output arriving, not a spinner"), or the provider's own
 * `inputSummary` purpose blurb once it's settled. Never both at once: a
 * single subtext slot keeps the collapsed row's height predictable and the
 * hierarchy legible (one annotation, not a stack of them).
 */
function collapsedSubtext(item: ChatExecute): string | null {
  if (item.status === 'running') {
    const ticker = lastOutputLine(item.outputText);
    if (ticker) return ticker;
  }
  return item.inputSummary?.trim() || null;
}

function hasHorizontalOverflow(
  lines: ExecuteDisplayLine[],
  ctx: MeasureCtx,
  vars: ExecuteVars,
  verticalScrollbarW: number
): boolean {
  const availableWidth = ctx.width - 2 * vars.linePadX - verticalScrollbarW;
  const codeFonts = { ...ctx.theme.fonts, body: ctx.theme.fonts.code };

  return lines.some((line) => {
    const block: ProseBlock = {
      kind: 'prose',
      id: 'execute-width',
      variant: 'body',
      runs: [{ kind: 'text', text: line.text }],
    };
    return measureProseNaturalWidth(block, codeFonts) > availableWidth;
  });
}

function scrollbarSpace(
  lines: ExecuteDisplayLine[],
  ctx: MeasureCtx,
  vars: ExecuteVars,
  hasVerticalOverflow: boolean
): number {
  const verticalScrollbarW = hasVerticalOverflow ? vars.scrollbarSize : 0;
  return hasHorizontalOverflow(lines, ctx, vars, verticalScrollbarW)
    ? vars.scrollbarGap + vars.scrollbarSize
    : 0;
}

/** Expanded-inset body height: content up to `expandedMaxLines`, scrollable past that. */
function executeBodyH(
  lines: ExecuteDisplayLine[],
  codeLineH: number,
  vars: ExecuteVars
): { bodyH: number; contentH: number } {
  const contentH = lines.length * codeLineH;
  const cap = vars.expandedMaxLines * codeLineH;
  return { bodyH: Math.min(contentH, cap), contentH };
}

function executeUnitH(item: ChatExecute, ctx: MeasureCtx, vars: ExecuteVars): number {
  if (!ctx.expanded(item.id)) {
    return vars.rowH + (collapsedSubtext(item) !== null ? vars.subtextH : 0);
  }
  const lines = executeLines(item);
  const { bodyH, contentH } = executeBodyH(lines, ctx.theme.fonts.code.lineHeight, vars);
  const hasVerticalOverflow = contentH > bodyH;
  return vars.rowH + bodyH + scrollbarSpace(lines, ctx, vars, hasVerticalOverflow);
}

function ExecuteUnitRender(props: { data: ChatExecute; ctx: RenderCtx; vars: ExecuteVars }) {
  const mCtx = () => props.ctx.measureCtx?.();
  // Inverted semantics: stored "collapsed" bool = "expanded".
  const isExpanded = () => props.ctx.viewState.isCollapsed(props.data.id);
  const subtext = createMemo(() => collapsedSubtext(props.data));

  const lines = createMemo(() => (isExpanded() ? executeLines(props.data) : []));
  const codeLineH = createMemo(() => mCtx()?.theme.fonts.code.lineHeight ?? 0);
  const bodyGeometry = createMemo(() => {
    const lineH = codeLineH();
    if (!lineH || !isExpanded()) return { bodyH: 0, contentH: 0 };
    return executeBodyH(lines(), lineH, props.vars);
  });
  const showScrollbar = createMemo(() => {
    const ctx = mCtx();
    if (!ctx || !isExpanded()) return false;
    const geometry = bodyGeometry();
    const hasVerticalOverflow = geometry.contentH > geometry.bodyH;
    const verticalScrollbarW = hasVerticalOverflow ? props.vars.scrollbarSize : 0;
    return hasHorizontalOverflow(lines(), ctx, props.vars, verticalScrollbarW);
  });

  const totalH = createMemo(() => {
    const ctx = mCtx();
    if (!ctx) return props.vars.rowH + (subtext() !== null ? props.vars.subtextH : 0);
    return executeUnitH(props.data, ctx, props.vars);
  });

  return (
    <CollapsibleCard
      id={props.data.id}
      ctx={props.ctx}
      chrome="line"
      height={totalH()}
      headerH={props.vars.rowH}
      expanded={isExpanded()}
      active={props.data.status === 'running' && !props.data.awaitingPermission}
      error={props.data.status === 'error'}
      errorTitle={props.data.error}
      awaitingPermission={props.data.awaitingPermission}
      icon={<IconTerminal />}
      header={
        <span style={{ display: 'inline-flex', 'align-items': 'baseline', gap: '5px', 'min-width': 0 }}>
          <span>Ran</span>
          <span
            style={{
              'font-family': vars.typeCodeFontFamily,
              'font-size': vars.typeCodeFontSize,
              overflow: 'hidden',
              'text-overflow': 'ellipsis',
              'white-space': 'nowrap',
            }}
          >
            {commandFragment(props.data.command)}
          </span>
        </span>
      }
      headerRight={
        <Show when={props.data.status === 'done' && !props.data.awaitingPermission}>
          <span
            style={{ color: vars.diffAdded, 'font-size': '12px', 'line-height': 1 }}
            aria-label="succeeded"
            title="Succeeded"
          >
            ✓
          </span>
        </Show>
      }
    >
      <Show
        when={isExpanded()}
        fallback={
          <Show when={subtext()}>
            {(text) => (
              <div
                class={executeSubtext}
                style={{ height: `${props.vars.subtextH}px`, 'line-height': `${props.vars.subtextH}px` }}
              >
                {text()}
              </div>
            )}
          </Show>
        }
      >
        <Show when={codeLineH() > 0}>
          <ExecuteBody
            item={props.data}
            lines={lines()}
            bodyH={bodyGeometry().bodyH}
            contentH={bodyGeometry().contentH}
            codeLineH={codeLineH()}
            linePadX={props.vars.linePadX}
            scrollbarH={showScrollbar() ? props.vars.scrollbarSize : 0}
            scrollbarGap={showScrollbar() ? props.vars.scrollbarGap : 0}
          />
        </Show>
      </Show>
    </CollapsibleCard>
  );
}

export const executeUnitDef = defineUnit<ChatExecute, ExecuteVars>({
  kind: 'execute',
  margin: { top: 2, bottom: 6 },
  vars: EXECUTE_VARS,

  estimate(item, _ctx, vars): number {
    // Estimate always assumes the collapsed geometry — items start collapsed.
    return vars.rowH + (collapsedSubtext(item) !== null ? vars.subtextH : 0);
  },

  measure(item, ctx, vars): number {
    return executeUnitH(item, ctx, vars);
  },

  Render: ExecuteUnitRender,
});
