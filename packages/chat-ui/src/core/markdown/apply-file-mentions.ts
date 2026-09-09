/**
 * applyFileMentionLinks — post-parse pass that promotes plain-text
 * workspace-file mentions into clickable `InlineText`/`InlineCode` runs.
 *
 * Deliberately NOT wired into `parseMarkdownToBlocks`/`ChatCaches.parseBlocks`
 * (unlike `mentionProvider`/`commandProvider`): those caches are keyed only by
 * `(messageId, markdown)`, and `ChatCommands.linkFileMentions` is a per-render
 * host callback (rebuilt whenever the host's file index changes, e.g. a new
 * file appears in the workspace tree) — baking it into the parse cache key
 * would thrash measure() against render() every time the two disagreed on
 * which function reference was current. Instead this module is a separate,
 * cheap, WeakMap-memoized transform applied AFTER `parseBlocks`/
 * `parseBlocksStreaming` return, from both the measure() and render() call
 * sites (see `message.def.tsx`) — both read the SAME `MeasureCtx.
 * linkFileMentions` for a given pass, so they always agree.
 *
 * Only 'prose' blocks are touched; code/table/rule/mermaid blocks pass
 * through unchanged (fenced code blocks never get auto-linked, per the
 * feature's own contract).
 *
 * This module is PURE: no geometry, no DOM imports.
 */

import type { FileMentionSegment } from '@/commands';
import type { Block, InlineRun, ProseBlock } from './document';

export type LinkFileMentionsFn = (text: string) => ReadonlyArray<FileMentionSegment>;

/**
 * One-entry-per-source-array memo: `blocks` (a stable identity while its
 * source markdown is unchanged — see `ChatCaches.parseBlocks`) maps to the
 * last `linkFileMentions` reference it was linked against and the result.
 * A changed matcher reference invalidates just this one message's entry.
 */
const memo = new WeakMap<Block[], { matcher: LinkFileMentionsFn; blocks: Block[] }>();

function totalLength(segments: ReadonlyArray<FileMentionSegment>): number {
  let n = 0;
  for (const s of segments) n += s.text.length;
  return n;
}

/**
 * Splits one plain (no pre-existing `href`) inline run's text into segments
 * via `linkFileMentions`, returning replacement runs when at least one
 * segment resolves to a file. Falls back to `[run]` unchanged when the host
 * function is missing, returns no match, or misbehaves (segments that don't
 * reconstruct the original text exactly — never trust a partial rewrite).
 */
function linkTextRun(run: Extract<InlineRun, { kind: 'text' }>, matcher: LinkFileMentionsFn): InlineRun[] {
  if (run.href || run.text.length === 0) return [run];
  const segments = matcher(run.text);
  if (segments.length === 0 || totalLength(segments) !== run.text.length) return [run];
  if (segments.length === 1 && !segments[0].path) return [run];

  const out: InlineRun[] = [];
  for (const seg of segments) {
    if (seg.text.length === 0) continue;
    out.push({ ...run, text: seg.text, href: seg.path });
  }
  return out.length > 0 ? out : [run];
}

/**
 * Links an inline code span only when the ENTIRE span text resolves to a
 * single file-mention segment — a code span never gets split mid-way (that
 * would defeat the "quoted with backticks" case: `` `notes.md` `` is either
 * wholly a file mention or it's just code).
 */
function linkCodeRun(run: Extract<InlineRun, { kind: 'code' }>, matcher: LinkFileMentionsFn): InlineRun {
  if (run.href || run.text.length === 0) return run;
  const segments = matcher(run.text);
  if (
    segments.length === 1 &&
    segments[0].path &&
    segments[0].text === run.text &&
    totalLength(segments) === run.text.length
  ) {
    return { ...run, href: segments[0].path };
  }
  return run;
}

function linkProseBlock(block: ProseBlock, matcher: LinkFileMentionsFn): ProseBlock {
  let changed = false;
  const runs: InlineRun[] = [];
  for (const run of block.runs) {
    if (run.kind === 'text') {
      const replacement = linkTextRun(run, matcher);
      if (replacement.length !== 1 || replacement[0] !== run) changed = true;
      runs.push(...replacement);
    } else if (run.kind === 'code') {
      const replacement = linkCodeRun(run, matcher);
      if (replacement !== run) changed = true;
      runs.push(replacement);
    } else {
      runs.push(run);
    }
  }
  return changed ? { ...block, runs } : block;
}

/**
 * Applies `linkFileMentions` to every prose block's runs, memoized by
 * `blocks` array identity + matcher reference. Returns `blocks` unchanged
 * (same reference) when `linkFileMentions` is undefined, so callers that
 * never wire the feature pay zero cost beyond this one identity check.
 */
export function applyFileMentionLinks(blocks: Block[], linkFileMentions?: LinkFileMentionsFn): Block[] {
  if (!linkFileMentions) return blocks;

  const hit = memo.get(blocks);
  if (hit && hit.matcher === linkFileMentions) return hit.blocks;

  const linked = blocks.map((block) =>
    block.kind === 'prose' ? linkProseBlock(block, linkFileMentions) : block
  );
  memo.set(blocks, { matcher: linkFileMentions, blocks: linked });
  return linked;
}
