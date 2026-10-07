import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';

/**
 * Tripwire for the other half of the vendored codex-acp patch
 * (`patches/@agentclientprotocol__codex-acp@2.1.1.patch`): a session's
 * `_meta.developerInstructions` becomes its thread's `developer_instructions`
 * on new, load and resume. A space session's rules ride on it (the runtime's
 * `sessionMeta`), so a bump that drops the patch would silently send them
 * nowhere. Read as text, never import: the bundle starts its ACP server at
 * import time.
 */
describe('codex-acp vendored developer instructions patch', () => {
  const _require = createRequire(import.meta.url);
  const src = readFileSync(_require.resolve('@agentclientprotocol/codex-acp/dist/index.js'), 'utf8');

  it('merges the instructions into every thread config it builds', () => {
    expect(src).toContain('developer_instructions: developerInstructions');
    // newSession, loadSession and resumeSession each pass them.
    expect(src.match(/createSessionConfig\([^)]*developerInstructionsOf\(request\._meta\)\)/g)).toHaveLength(3);
  });

  it('keeps them when a provider restart resumes the session', () => {
    expect(src).toContain('_meta: { developerInstructions: session.developerInstructions }');
  });
});
