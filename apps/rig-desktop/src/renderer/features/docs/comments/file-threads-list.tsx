import { useQuery } from '@tanstack/react-query';
import { rpc } from '@renderer/lib/ipc';
import { CommentMarkdown } from '@renderer/lib/ui/comment-markdown';
import { groupThreads, shortenQuote } from './anchors';

/**
 * The comment threads on a file that takes no comments of its own in the
 * viewer (an image, a PDF, a CSV): agents can still post them, so they are
 * listed under the file instead of showing nowhere. Read only. Nothing at
 * all while there are none, or when the file isn't in a space.
 */
export function FileThreadsList({ path }: { path: string }) {
  const { data } = useQuery({
    queryKey: ['rig', 'comments', 'file-list', path],
    queryFn: () => rpc.rig.comments.list({ absPath: path }),
    staleTime: 10_000,
    refetchInterval: 15_000,
  });
  const messages = data?.success ? data.data.messages.filter((m) => !m.deletedAt) : [];
  const threads = groupThreads(messages);
  if (threads.length === 0) return null;
  const name = (m: (typeof messages)[number]) => {
    const who = m.author.name ?? 'Someone';
    return m.author.kind === 'agent' ? `${who}'s agent` : who;
  };
  return (
    <section
      className="max-h-[40%] shrink-0 overflow-y-auto border-t border-border-hairline bg-bg-1 px-4 py-3"
      data-testid="file-threads-list"
      aria-label="Comments on this file"
    >
      <h2 className="text-xs font-medium text-text-primary">
        {threads.length === 1 ? '1 comment on this file' : `${threads.length} comments on this file`}
      </h2>
      <p className="mb-2 text-xs text-text-muted">New comments can't be added to this kind of file here. They also show in the Room.</p>
      <ol className="flex flex-col gap-2">
        {threads.map(({ root, replies }) => (
          <li key={root.id} className="rounded-control border border-border-hairline px-3 py-2 text-sm" data-testid="file-thread">
            {root.anchor?.exact && (
              <div className="mb-1 border-l-2 border-border-strong pl-2 text-xs text-text-muted">{shortenQuote(root.anchor.exact, 140)}</div>
            )}
            {[root, ...replies].map((m) => (
              <div key={m.id} className="mt-1">
                <div className="text-xs font-medium text-text-primary">
                  {name(m)}
                  {root.resolvedAt && m === root ? <span className="font-normal text-text-muted"> · resolved</span> : null}
                </div>
                <CommentMarkdown content={m.body} />
              </div>
            ))}
          </li>
        ))}
      </ol>
    </section>
  );
}
