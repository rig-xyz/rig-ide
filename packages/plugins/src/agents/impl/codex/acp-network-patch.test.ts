import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';

/**
 * Tripwire for the vendored codex-acp sandbox patch
 * (`patches/@agentclientprotocol__codex-acp@1.0.2.patch`, see
 * `agents/roadmaps/agent-queryable-context-verification.md`'s addendum).
 *
 * The adapter hardcodes its "Agent" mode as workspace-write with
 * `networkAccess: false`, which blocks the rig context CLI's relay reads
 * from the model's shell — the patch flips it to `true`. A dependency bump
 * that re-cuts or drops the patch would silently ship Codex sessions whose
 * `rig context` lookups all degrade to TEMPORARILY_UNAVAILABLE, so assert
 * the installed dist here instead of trusting the lockfile. Read as text,
 * never import: the bundle starts its ACP server at import time.
 *
 * Retire this test together with the patch once upstream offers a
 * workspace-write-with-network mode or sandbox config passthrough.
 */
describe('codex-acp vendored network patch', () => {
  it('the installed Agent mode allows network access', () => {
    const _require = createRequire(import.meta.url);
    const entry = _require.resolve('@agentclientprotocol/codex-acp/dist/index.js');
    const src = readFileSync(entry, 'utf8');
    const agentMode = src.match(
      /"agent",\s*"Agent",[\s\S]{0,400}?networkAccess:\s*(true|false)/
    );
    expect(agentMode?.[1], 'Agent mode sandbox policy in codex-acp dist').toBe('true');
  });
});
