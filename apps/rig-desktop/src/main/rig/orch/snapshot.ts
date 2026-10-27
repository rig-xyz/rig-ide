import type { OrchQuery, OrchRow } from '../feed/relay';
import type { Snapshot } from './agent';

/**
 * The Feed and the open situations, one line each, for a run's packet: what
 * the run would otherwise look up one call at a time (rig_query, rig_get).
 */
export async function readSnapshot(
  query: (kind: string, opts: { limit?: number }) => Promise<{ success: true; data: OrchQuery } | { success: false }>,
  github?: (command: string) => Promise<{ success: true; data: string } | { success: false }>,
  limit = 60
): Promise<Snapshot | null> {
  const [feed, situations, prs] = await Promise.all([
    query('feed', { limit: 20 }),
    query('situations', { limit }),
    github?.(`gh search prs --review-requested=@me --state=open --json repository,number,title,author,updatedAt --limit 20`) ?? null,
  ]);
  if (!feed.success || !situations.success || !('rows' in feed.data) || !('rows' in situations.data)) return null;
  const str = (v: unknown) => (typeof v === 'string' ? v : '');
  return {
    github: prs?.success ? githubLines(prs.data) : null,
    feed: feed.data.rows.map((r: OrchRow) => `${r.ref} [${str(r.state)}] "${r.title}"${r.decision ? ` · ${str(r.decision)}` : ''}${r.card ? ' · card none yet' : ''}`),
    situations: situations.data.rows.map((r: OrchRow) => {
      const people = Array.isArray(r.people) ? (r.people as string[]).join(', ') : '';
      return [`${r.ref} "${r.title}"`, str(r.topic), r.decision ? `do ${str(r.decision)}` : '', `feed ${str(r.feed)}`, people, str(r.line)].filter(Boolean).join(' · ');
    }),
  };
}

/** `gh search prs --json …` as one line per pull request: repo#n "title" by author, updated when. */
function githubLines(json: string): string[] | null {
  try {
    const rows = JSON.parse(json) as { repository?: { nameWithOwner?: string }; number?: number; title?: string; author?: { login?: string }; updatedAt?: string }[];
    return rows.map((r) => `github:${r.repository?.nameWithOwner ?? '?'}#${r.number} "${r.title ?? ''}" by ${r.author?.login ?? 'someone'}, updated ${r.updatedAt ?? '?'}`);
  } catch {
    return null;
  }
}
