import { notSignedInForAgent, signInSiteForUrl } from '@shared/pages/sign-in-sites';
import { canonicalPageUrl } from '@shared/spaces/links';
import type { RigTool } from '../spaces/rig-tools';
import type { SpacesRelayApi } from '../spaces/relay-api';
import { agentPage } from './agent-pages';
import { BROWSER_TOOLS, pageLink } from './browser-tools';
import { googleFullText } from './google-export';
import { pinsFromRows } from './page-pins';
import { pageSignIns } from './page-sign-ins-instance';
import { pageIsSignInWall } from './sign-in-check';

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
        // A file in the space, by its path or link, reads as this Mac's copy.
        const link = pageLink(input.url, scope);
        const url = link ? canonicalPageUrl(link) : input.url;
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
            signInWall: async (page) => {
              if (!(await pageIsSignInWall(await agentPage(page)))) return null;
              const site = signInSiteForUrl(page);
              if (site) pageSignIns.markWall(site.id);
              return notSignedInForAgent(page, site ? pageSignIns.recordFor(site.id) : null);
            },
            // The link as given (a sheet's #gid survives), exported in the
            // agent's own tab's session, after the sign-in check above.
            fullText: async (page) => googleFullText(typeof input.url === 'string' ? input.url : page, await agentPage(page)),
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
