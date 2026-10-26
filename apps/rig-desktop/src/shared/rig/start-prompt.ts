/**
 * The first message of a session Rig starts, and the same message rebuilt
 * from a brief written before it said this much. Shared: main writes it
 * (`orch/actions.ts`), a space session's view reads it back.
 */

/**
 * The first message of a session Rig starts: a short brief, the way you'd
 * hand work to someone. What it is, why now, what came in, when it's done and
 * what it mustn't do, then a link to the full brief (the evidence, the limits).
 * The session shows it as your message; markdown, so the brief is a file link.
 */
/**
 * Source refs as people read them: a GitHub PR or issue as a link named like
 * GitHub names it (mobile-ios-v2#350), a Linear ticket as its key, and any
 * other `[kind:id]` without its kind and brackets. Never a raw ref in words.
 */
export function readableRefs(text: string): string {
  return text
    .replace(/\[?github:([\w.-]+)\/([\w.-]+)#(\d+)\]?/g, '[$2#$3](https://github.com/$1/$2/issues/$3)')
    .replace(/\[?linear:([A-Z][A-Z0-9]*-\d+)\]?/g, '$1')
    .replace(/\[[a-z]+:([^\]]+)\]/g, '$1');
}

export function startPrompt({
  title,
  goal,
  why,
  seen = [],
  briefPath,
}: {
  title: string;
  goal: string;
  why: string;
  /** What came in, newest last, as words (never raw refs). */
  seen?: readonly string[];
  briefPath: string;
}): string {
  const reason = readableRefs(why.split(/\n\n/)[0]?.trim() ?? '');
  const task = goal.trim() && goal.trim() !== title ? readableRefs(goal.trim()) : null;
  return [
    `**${title}**`,
    task,
    reason ? `**Why now:** ${reason}` : null,
    seen.length ? ['**What came in:**', ...seen.slice(-3).map((line) => `- ${readableRefs(line)}`)].join('\n') : null,
    "**Done when** the goal is met, or you've found what blocks it and who can unblock it. Don't send, post or change anything outside this space without asking me first.",
    `Everything else, with the evidence and limits, is in the brief: [\`brief.md\`](${briefPath})`,
  ]
    .filter(Boolean)
    .join('\n\n');
}

/**
 * The same message from a brief file (`sessions/…/brief.md`, as main writes
 * it): its title, goal, why and evidence, the refs taken off the evidence.
 */
export function startPromptFromBrief(brief: string, briefPath: string): string | null {
  const title = /^# (.+)$/m.exec(brief)?.[1]?.trim();
  if (!title) return null;
  const section = (name: string): string => {
    const match = new RegExp(`^## ${name}\\n([\\s\\S]*?)(?=\\n## |(?![\\s\\S]))`, 'm').exec(brief);
    return match?.[1]?.trim() ?? '';
  };
  const seen = section('Evidence')
    .split('\n')
    .map((line) => line.replace(/^-\s*/, '').replace(/^[a-z]+_[A-Za-z0-9_-]+:\s*/, '').trim())
    .filter(Boolean);
  return startPrompt({ title, goal: section('Goal'), why: section('Why Rig suggested this'), seen, briefPath });
}
