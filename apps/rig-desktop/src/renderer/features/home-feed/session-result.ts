import type { TranscriptTurn } from '@emdash/core/acp/client';

/**
 * What a finished session found, for its card on the Feed: the opening of
 * Claude's last answer as plain text, and how many decisions it left for you
 * (its "Decisions for you" list). Pure, so it's testable.
 */

export type SessionResult = {
  /** The answer's first paragraph, markdown taken out. */
  lead: string;
  /** Items under a "Decisions for you" heading; 0 when there is none. */
  decisions: number;
};

/** Claude's last answer in the session: the last assistant message of the last turn that has one. */
export function lastAnswer(turns: readonly TranscriptTurn[]): string | null {
  for (let t = turns.length - 1; t >= 0; t--) {
    const items = turns[t]!.items;
    for (let i = items.length - 1; i >= 0; i--) {
      const item = items[i]!;
      if (item.kind === 'message' && item.role === 'assistant' && item.text.trim()) return item.text;
    }
  }
  return null;
}

/** Markdown down to the words: links keep their text, emphasis and code marks go. */
export function plainText(markdown: string): string {
  return markdown
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/[*_`~]+/g, '')
    .replace(/^#+\s*/gm, '')
    .replace(/\s+/g, ' ')
    .trim();
}

export function sessionResult(answer: string): SessionResult {
  const paragraphs = answer.split(/\n\s*\n/).map((p) => p.trim()).filter(Boolean);
  const lead = plainText(paragraphs[0] ?? '');
  const lines = answer.split('\n');
  const heading = lines.findIndex((line) => /^\W*decisions? for you\W*$/i.test(line.trim()));
  let decisions = 0;
  if (heading !== -1) {
    for (const line of lines.slice(heading + 1)) {
      const text = line.trim();
      if (!text) {
        if (decisions > 0) break;
        continue;
      }
      if (/^(\d+[.)]|[-*•])\s+/.test(text)) decisions += 1;
      else if (!/^\s/.test(line)) break;
    }
  }
  return { lead, decisions };
}
