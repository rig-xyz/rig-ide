import { defineBlock } from '@components/rows/markdown/block-def';
import type { Measured, MeasureCtx } from '@core/define';
import type { CodeLeafLayout } from '@core/layout/layout-types';
import type { CodeBlock } from '@core/markdown/document';
import { horizontalScrollbarHeight } from '@core/measure/scrollbar';
import { Code } from './Code';
import { codeWrapper } from './code.css';
import { codeOverflowsX, layoutCode } from './layout';

export const codeBlockDef = defineBlock<CodeBlock, CodeLeafLayout>({
  kind: 'code',
  margin: () => ({ top: 8, bottom: 8 }),

  measure(block: CodeBlock, ctx: MeasureCtx): Measured<CodeLeafLayout> {
    const scrollbar = codeOverflowsX(block, ctx.theme.fonts, ctx.width)
      ? horizontalScrollbarHeight(codeWrapper)
      : 0;
    const laid = layoutCode(block, ctx.theme.fonts, 0, ctx.width, scrollbar);
    const layout: CodeLeafLayout = { ...laid, raw: block };
    return { height: laid.height, width: laid.contentWidth, layout };
  },

  Render(props: { node: Measured<CodeLeafLayout> }) {
    const l = props.node.layout;
    return <Code block={l} rawBlock={l.raw} />;
  },
});
