/**
 * item-quote.ts — derive the quoted full text of a transcript item for the
 * thread "send to agent" hidden context.
 *
 * Tolerant, shape-based extraction: transcript items span multiple kinds
 * (messages, thinking, execute/tool nodes). Items with prose (`text`) or a
 * command quote those; anything else falls back to the excerpt captured when
 * the thread was opened (a rough excerpt is fine for tool rows in v0).
 */

export const QUOTE_MAX_CHARS = 1500;

export function itemQuoteText(item: unknown, fallback: string): string {
  let text = fallback;
  if (item !== null && typeof item === 'object') {
    const it = item as Record<string, unknown>;
    if (typeof it.text === 'string' && it.text.trim().length > 0) {
      text = it.text;
    } else if (typeof it.command === 'string' && it.command.trim().length > 0) {
      const output = typeof it.outputText === 'string' ? `\n${it.outputText}` : '';
      text = `${it.command}${output}`;
    }
  }
  return text.slice(0, QUOTE_MAX_CHARS);
}
