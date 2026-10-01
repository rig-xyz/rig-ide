import { describe, expect, it } from 'vitest';
import { remarkBarePaths } from './bare-paths';

type Node = { type: string; value?: string; url?: string; children?: Node[] };

function run(children: Node[]): Node[] {
  const tree: Node = { type: 'root', children: [{ type: 'paragraph', children }] };
  remarkBarePaths()(tree);
  return tree.children![0]!.children!;
}

describe('remarkBarePaths', () => {
  it('turns an absolute path in running text into a file link, leaving the sentence’s punctuation', () => {
    const out = run([{ type: 'text', value: 'Wrote /Users/dtsbourg/Rig/clear-harbor/release-notes-0.4.5.md.' }]);
    expect(out).toEqual([
      { type: 'text', value: 'Wrote ' },
      {
        type: 'link',
        url: '/Users/dtsbourg/Rig/clear-harbor/release-notes-0.4.5.md',
        children: [{ type: 'text', value: '/Users/dtsbourg/Rig/clear-harbor/release-notes-0.4.5.md' }],
      },
      { type: 'text', value: '.' },
    ]);
  });

  it('links a path written as inline code, keeping it code', () => {
    const out = run([{ type: 'inlineCode', value: 'file:///home/sam/Rig/growth/plan.md' }]);
    expect(out).toEqual([
      { type: 'link', url: 'file:///home/sam/Rig/growth/plan.md', children: [{ type: 'inlineCode', value: 'file:///home/sam/Rig/growth/plan.md' }] },
    ]);
  });

  it('leaves short system paths, commands, URLs and existing links alone', () => {
    const link: Node = { type: 'link', url: 'https://x.dev/Users/a/b', children: [{ type: 'text', value: '/Users/a/Rig/b.md' }] };
    const out = run([{ type: 'text', value: 'see /etc/hosts or /tmp/x and a/Users/b/c/d' }, link, { type: 'inlineCode', value: 'ls /Users/a/b' }]);
    expect(out).toEqual([
      { type: 'text', value: 'see /etc/hosts or /tmp/x and a/Users/b/c/d' },
      link,
      { type: 'inlineCode', value: 'ls /Users/a/b' },
    ]);
  });
});
