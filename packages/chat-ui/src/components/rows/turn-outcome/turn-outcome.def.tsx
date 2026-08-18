import { ROW_H } from '@components/engine/row-metrics';
import { defineUnit } from '@core/units';
import type { TurnOutcomeItem } from '@/model';
import { vars } from '@styles/theme.css';

/**
 * Status events are stated once (design-system Rule 9). `outcome.reason` for
 * `kind: 'cancelled'` is a `z.literal('cancelled')` — the *only* legal
 * value, so appending it always reads as "Turn cancelled (cancelled)": not
 * a distinct reason, just an echo of the kind itself. The other three kinds
 * carry genuinely differentiated reasons (`error`'s 9 real failure
 * categories, etc.), so those still show.
 */
function outcomeLabel(item: TurnOutcomeItem): string {
  if (item.outcome.kind === 'cancelled') return 'Turn cancelled';
  const reason = item.outcome.reason ? ` (${item.outcome.reason})` : '';
  switch (item.outcome.kind) {
    case 'error':
      return `Turn failed${reason}`;
    case 'interrupted':
      return `Turn interrupted${reason}`;
    case 'done':
      return `Turn completed${reason}`;
    default:
      return `Turn finished${reason}`;
  }
}

export const turnOutcomeUnitDef = defineUnit<TurnOutcomeItem, { rowH: number }>({
  kind: 'turn-outcome',
  margin: { top: 4, bottom: 4 },
  vars: { rowH: ROW_H },

  measure(_data, _ctx, vars_) {
    return vars_.rowH;
  },

  Render(props) {
    return (
      <div
        style={{
          height: `${props.vars.rowH}px`,
          display: 'flex',
          'align-items': 'center',
          'justify-content': 'center',
          'text-align': 'center',
          color: props.data.outcome.kind === 'error' ? vars.fgError : vars.fgMuted,
          'font-size': '13px',
        }}
      >
        {outcomeLabel(props.data)}
      </div>
    );
  },
});
