/**
 * Table — Solid component rendering a TableLaidOut block.
 *
 * Uses BlockFrame (not MeasuredBlockFrame) because the height is fully
 * determined by layoutTable — no DOM write-back needed.
 *
 * Column widths are enforced via <colgroup> + table-layout:fixed. Each cell
 * renders its pretext-laid-out lines through the regular Prose component
 * (so code chips, links and emphasis look exactly like body text) inside a
 * box of the cell's measured height. Wide tables (tableWidth > contentWidth)
 * scroll horizontally inside the scroll wrapper.
 *
 * Geometry-coupled rules (cell padding, font-size, line-height) live in
 * table.css.ts because layoutTable's row-height formula depends on them.
 */

import { BlockFrame } from '@components/engine/block-frame';
import type { TableLaidOut, TableRowLayout } from '@core/layout/layout-types';
import { For } from 'solid-js';
import { Prose } from '../prose/Prose';
import { cellBody, tableScroll, tdCell, tdCellLastRow, thCell } from './table-visual.css';
import { pchatTable } from './table.css';

export type TableProps = {
  block: TableLaidOut;
};

function TableCellBody(props: { cell: TableRowLayout['cells'][number] }) {
  return (
    <div
      class={cellBody}
      style={{ height: `${Math.max(props.cell.laid.height, props.cell.laid.lineHeight)}px` }}
    >
      <Prose block={props.cell.laid} runs={props.cell.runs} variant="body" />
    </div>
  );
}

export function Table(props: TableProps) {
  const header = () => props.block.rows[0]?.cells ?? [];
  const body = () => props.block.rows.slice(1);
  // layoutTable draws no border under the last row — header included when
  // the table has no body rows.
  const lastRow = (i: number) => (i === body().length - 1 ? ` ${tdCellLastRow}` : '');
  return (
    <BlockFrame layout={props.block}>
      <div class={tableScroll}>
        <table
          class={pchatTable}
          style={{ width: `${props.block.tableWidth}px`, 'table-layout': 'fixed' }}
        >
          <colgroup>
            <For each={props.block.colWidths}>{(w) => <col style={{ width: `${w}px` }} />}</For>
          </colgroup>
          <thead>
            <tr>
              <For each={header()}>
                {(cell) => (
                  <th class={`${thCell}${lastRow(-1)}`}>
                    <TableCellBody cell={cell} />
                  </th>
                )}
              </For>
            </tr>
          </thead>
          <tbody>
            <For each={body()}>
              {(row, i) => (
                <tr>
                  <For each={row.cells}>
                    {(cell) => (
                      <td class={`${tdCell}${lastRow(i())}`}>
                        <TableCellBody cell={cell} />
                      </td>
                    )}
                  </For>
                </tr>
              )}
            </For>
          </tbody>
        </table>
      </div>
    </BlockFrame>
  );
}
