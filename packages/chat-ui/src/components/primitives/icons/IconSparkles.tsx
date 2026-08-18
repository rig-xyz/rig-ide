/**
 * Generic tool-call icon: the leading glyph for `Tool.tsx`'s catch-all row
 * (search, fetch, MCP, subagent fallback, and any `unknown-tool-call` a
 * provider reports — e.g. Claude Code's "Skill" invocations, which is what
 * exposed the row's missing leading-icon slot in the first place; see
 * `tool.css.ts`). Path data adapted from Lucide's `Sparkles` (ISC-licensed),
 * matching this file's viewBox/stroke conventions so it sits in
 * `CardHeader`'s 14×14 leading slot exactly like `IconTerminal` does for
 * Execute rows.
 */
export function IconSparkles() {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      stroke-width="2"
      stroke-linecap="round"
      stroke-linejoin="round"
      aria-hidden="true"
    >
      <path d="M11.017 2.814a1 1 0 0 1 1.966 0l1.051 5.558a2 2 0 0 0 1.594 1.594l5.558 1.051a1 1 0 0 1 0 1.966l-5.558 1.051a2 2 0 0 0-1.594 1.594l-1.051 5.558a1 1 0 0 1-1.966 0l-1.051-5.558a2 2 0 0 0-1.594-1.594l-5.558-1.051a1 1 0 0 1 0-1.966l5.558-1.051a2 2 0 0 0 1.594-1.594z" />
    </svg>
  );
}
