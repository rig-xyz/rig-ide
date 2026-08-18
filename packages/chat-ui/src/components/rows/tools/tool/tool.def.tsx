import { ROW_H } from '@components/engine/row-metrics';
import type { SegmentCtx } from '@core/units';
import { defineUnit } from '@core/units';
import { pxTokens } from '@styles/px-tokens';
import { assignInlineVars } from '@vanilla-extract/dynamic';
import type { ChatToolCall, ToolNode } from '@/model';
import { Tool } from './Tool';
import { toolRoot, toolVars } from './tool.css';

/**
 * `toolKind` is the raw ACP-reported category for a tool call the reducer
 * couldn't classify (`kind: 'unknown-tool-call'`, see
 * `packages/core/src/acp/reducer/item-fold.ts`). Providers use it as a
 * catch-all, and `'other'` (or nothing at all) is a real value it reports —
 * showing it verbatim next to the tool's own name is how "Skill other"
 * happens. Dropped rather than guessed at: this file has no reliable way to
 * turn "other" into something truer than just not saying it.
 */
function meaningfulToolKind(toolKind: string | null | undefined): string | undefined {
  const trimmed = toolKind?.trim();
  if (!trimmed || trimmed.toLowerCase() === 'other') return undefined;
  return trimmed;
}

export function toolFromItem(item: ToolNode, ctx: SegmentCtx): ChatToolCall {
  const base = 'toolCallId' in item ? item : null;
  const name =
    item.kind === 'search-tool-call'
      ? 'Search'
      : item.kind === 'mcp-tool-call'
        ? 'MCP'
        : item.kind === 'web-fetch-tool-call'
          ? 'Fetch'
          : item.kind === 'spawn-subagent-tool-call'
            ? 'Subagent'
            : item.kind === 'unknown-tool-call'
              ? item.name
              : item.kind === 'tool-group'
                ? item.label
                : 'Tool';
  const inputSummary =
    item.kind === 'search-tool-call'
      ? `${item.query}${item.matchCount !== undefined ? ` (${item.matchCount} matches)` : ''}`
      : item.kind === 'mcp-tool-call'
        ? [item.server, item.tool].filter(Boolean).join('.')
        : item.kind === 'web-fetch-tool-call'
          ? (item.pageTitle ?? item.url)
          : item.kind === 'spawn-subagent-tool-call'
            ? `${item.name}${item.background ? ' (background)' : ''}`
            : item.kind === 'unknown-tool-call'
              ? meaningfulToolKind(item.toolKind)
              : base?.inputSummary;
  return {
    kind: 'tool',
    id: item.id,
    name,
    status: 'status' in item ? item.status : 'done',
    awaitingPermission: base ? ctx.pendingToolCallIds().has(base.toolCallId) : false,
    inputSummary,
    ...(item.kind === 'unknown-tool-call' ? { rawKind: item.toolKind } : {}),
  };
}

export const toolUnitDef = defineUnit<ChatToolCall, { rowH: number }>({
  kind: 'tool',
  margin: { top: 2, bottom: 2 },
  vars: { rowH: ROW_H },

  measure(_data, _ctx, vars): number {
    return vars.rowH;
  },

  Render(props) {
    return (
      <div class={toolRoot} style={assignInlineVars(toolVars, pxTokens({ rowH: props.vars.rowH }))}>
        <Tool item={props.data} />
      </div>
    );
  },
});
