import { rpc } from '@renderer/lib/ipc';
import type { HomeOrchestrator, Inline, ReplyBlock } from './orchestrator';
import { needsYouPhrase } from './say';

/**
 * Home's chat answered by the person's own Claude (`rpc.rig.homeChat`, main
 * home-chat/chat.ts), which can read the Feed and correct it. Used once the
 * orchestrator's Feed is on; the scripted one stays for the demo.
 */

/** `Hid **the SOL card**.` → plain and bold runs. */
export function inlineRuns(text: string): Inline[] {
  const runs: Inline[] = [];
  const pattern = /\*\*(.+?)\*\*/g;
  let last = 0;
  for (const m of text.matchAll(pattern)) {
    const at = m.index ?? 0;
    if (at > last) runs.push({ kind: 'text', text: text.slice(last, at) });
    runs.push({ kind: 'bold', text: m[1]! });
    last = at + m[0].length;
  }
  if (last < text.length) runs.push({ kind: 'text', text: text.slice(last) });
  return runs;
}

/** Claude's answer as chat blocks: one per paragraph, list lines kept as their own lines. */
export function answerBlocks(text: string): ReplyBlock[] {
  return text
    .split(/\n\s*\n/)
    .map((p) => p.trim())
    .filter(Boolean)
    .map((p) => ({ kind: 'text' as const, runs: inlineRuns(p.replace(/^#+\s*/gm, '')) }));
}

export const claudeOrchestrator: HomeOrchestrator = {
  greeting(ctx) {
    const phrase = needsYouPhrase(ctx.needsYou);
    return [
      {
        kind: 'text',
        runs: [
          {
            kind: 'text',
            text: `${phrase.charAt(0).toUpperCase()}${phrase.slice(1)}${ctx.upNext ? ` and ${ctx.upNext} ${ctx.upNext === 1 ? 'is' : 'are'} up next` : ''}, on the right. Ask me why any of them is there, or tell me when one is wrong and I'll fix it.`,
          },
        ],
      },
    ];
  },
  async respond(text) {
    const answer = await rpc.rig.homeChat.send({ text });
    if (answer.success) return answerBlocks(answer.data.text);
    return [{ kind: 'text', runs: [{ kind: 'text', text: `I couldn't reach your Claude: ${answer.error}` }] }];
  },
};
