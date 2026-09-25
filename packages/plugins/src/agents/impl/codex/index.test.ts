import { describe, expect, it } from 'vitest';
import { plugin } from './index';

/**
 * The ChatGPT desktop app fix: rig was launching whichever `codex` happened to
 * be first on PATH (commonly a stale global npm install), never the app's own
 * bundled, newer codex-cli — the only one that knows about ChatGPT-account-only
 * models like gpt-6-sol. These assertions pin the plugin's declared fix in
 * place; the resolution behavior itself is covered in
 * host-dependency-manager.test.ts.
 */
describe('codex plugin hostDependency', () => {
  const hostDependency = plugin.capabilities.hostDependency;

  it('declares the ChatGPT desktop app as a macOS extraLocation candidate', () => {
    expect(hostDependency.extraLocations?.macos).toEqual(
      expect.arrayContaining([
        '/Applications/ChatGPT.app/Contents/Resources/codex',
        '~/Applications/ChatGPT.app/Contents/Resources/codex',
      ])
    );
  });

  it('opts in to preferNewest auto-resolution', () => {
    expect(hostDependency.preferNewest).toBe(true);
  });
});

/**
 * The static model catalog is NOT the source of truth for what the Room offers —
 * see rig-chat-store.ts's `modelOptions` getter, which reads only the live ACP
 * session's reported config (`session.config.current().modelOptions`), never this
 * capability. Nothing in main (dispatch.ts, comment-agent.ts) or the renderer
 * validates a chosen model id against this list either — it's purely descriptive
 * metadata (name/description/modelFeatures), currently unused for gating or
 * offering models. gpt-6-sol is intentionally NOT added here: since the live
 * ACP session already reports it correctly (verified working), adding a stale,
 * unvalidated entry here would only risk drifting out of sync with the real
 * catalog for no behavioral benefit.
 */
describe('codex plugin static model catalog', () => {
  it('does not need to list every ChatGPT-account-only model (e.g. gpt-6-sol)', () => {
    expect(plugin.capabilities.models.kind).toBe('selectable');
    if (plugin.capabilities.models.kind === 'selectable') {
      expect(plugin.capabilities.models.modelOptions['gpt-6-sol']).toBeUndefined();
    }
  });
});
