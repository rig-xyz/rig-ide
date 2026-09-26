import { canonicalPageUrl } from '@shared/spaces/links';
import type { RigTool } from '../spaces/rig-tools';
import type { SpacesRelayApi } from '../spaces/relay-api';
import { BROWSER_TOOLS } from './browser-tools';
import { pinsFromRows } from './page-pins';

/**
 * The browser tools as rig tools: same server, same bearer token, same
 * "acts as the session's owner" check (`runRigTool`). Built here, not in
 * `rig-tools.ts`, because they need Electron (hidden tabs) and that module
 * is imported by tests.
 */
export function browserRigTools(api: Pick<SpacesRelayApi, 'listMessages'>): RigTool[] {
  return BROWSER_TOOLS.map(
    (tool): RigTool => ({
      name: tool.name,
      description: tool.description,
      inputSchema: tool.inputSchema,
      annotations: { title: tool.title, readOnlyHint: true, openWorldHint: true },
      async run(scope, input) {
        const url = typeof input.url === 'string' ? canonicalPageUrl(input.url) : input.url;
        const result = await tool.run(
          { ...input, url },
          {
            pinsFor: async (page) => {
              const rows = await api.listMessages(scope.bindingId, { path: canonicalPageUrl(page), limit: 200 });
              return rows.success
                ? pinsFromRows(rows.data)
                    .filter((p) => !p.resolved)
                    .map((p) => ({ n: p.n, comment: p.comment, anchor: p.anchor }))
                : [];
            },
          }
        );
        const text = result.content
          .filter((c): c is { type: 'text'; text: string } => c.type === 'text')
          .map((c) => c.text)
          .join('\n');
        return { text, content: result.content, ...(result.isError ? { isError: true } : {}) };
      },
    })
  );
}
