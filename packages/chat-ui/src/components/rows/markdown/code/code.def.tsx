import { defineBlock } from '@components/rows/markdown/block-def';
import type { Measured, MeasureCtx } from '@core/define';
import type { CodeLeafLayout } from '@core/layout/layout-types';
import type { CodeBlock } from '@core/markdown/document';
import { horizontalScrollbarHeight } from '@core/measure/scrollbar';
import { quoteTextLeft } from '../prose/geometry';
import { Code } from './Code';
import { codeWrapper } from './code.css';
import { codeOverflowsX, layoutCode } from './layout';

export const codeBlockDef = defineBlock<CodeBlock, CodeLeafLayout>({
  kind: 'code',
  margin: () => ({ top: 8, bottom: 8 }),

  measure(block: CodeBlock, ctx: MeasureCtx): Measured<CodeLeafLayout> {
    // Inside a quote the block starts at the quote's text column (its bar is
    // drawn by BlockStackView).
    const quote = block.quotes?.at(-1);
    const indent = quote ? quoteTextLeft(quote.depth) : 0;
    const width = ctx.width - indent;
    const scrollbar = codeOverflowsX(block, ctx.theme.fonts, width)
      ? horizontalScrollbarHeight(codeWrapper)
      : 0;
    const laid = layoutCode(block, ctx.theme.fonts, 0, width, scrollbar);
    const layout: CodeLeafLayout = { ...laid, indent, raw: block };
    return { height: laid.height, width: laid.contentWidth, layout };
  },

  Render(props: { node: Measured<CodeLeafLayout> }) {
    const l = props.node.layout;
    return <Code block={l} rawBlock={l.raw} />;
  },
});
