/**
 * thread-excerpt.ts — derive a short plain-text excerpt for a tool-like
 * RenderUnit, used by the reply-in-thread affordance (UnitRow overlay).
 *
 * A rough excerpt is fine for tool rows: it seeds the thread card's quoted
 * header and the host-side hidden context, not any rendered transcript text.
 */

import type { RenderUnit } from '@core/units';
import type { ItemNode } from '@state/flatten';
import type {
  ChatDiff,
  ChatExecute,
  ChatFileOpToolCall,
  ChatSubagentToolCall,
  ChatToolCall,
} from '@/model';

/**
 * Unit kinds that get the reply-in-thread overlay button in UnitRow.
 * `message` is excluded — assistant messages carry the footer button instead.
 */
export const THREAD_OVERLAY_KINDS: ReadonlySet<string> = new Set([
  'tool',
  'tool-group',
  'execute',
  'file-op',
  'diff',
  'subagent',
]);

/** Max length of a derived excerpt (matches the legacy footer thread button). */
export const EXCERPT_MAX = 120;

/** Squash whitespace and cap the length — the canonical excerpt derivation. */
export function deriveExcerpt(text: string): string {
  return text.replace(/\s+/g, ' ').trim().slice(0, EXCERPT_MAX);
}

export function threadExcerptForUnit(unit: RenderUnit): string {
  switch (unit.kind) {
    case 'tool': {
      const d = unit.data as ChatToolCall;
      return [d.name, d.inputSummary].filter(Boolean).join(' ');
    }
    case 'tool-group': {
      // Header data is produced by toolFromItem() — a ChatToolCall shape.
      const d = unit.data as ItemNode;
      const header = d.item as ChatToolCall;
      return [header.name, header.inputSummary].filter(Boolean).join(' ');
    }
    case 'execute': {
      const d = unit.data as ChatExecute;
      return d.inputSummary || d.command;
    }
    case 'file-op': {
      const d = unit.data as ChatFileOpToolCall;
      return `${d.op} ${d.ops.map((o) => o.path).join(', ')}`;
    }
    case 'diff': {
      const d = unit.data as ChatDiff;
      return `Edit ${d.path}`;
    }
    case 'subagent': {
      const d = unit.data as ChatSubagentToolCall;
      return d.name;
    }
    default:
      return '';
  }
}
