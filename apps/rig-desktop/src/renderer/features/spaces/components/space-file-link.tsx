import { CloudDownload } from 'lucide-react';
import { type ReactNode, useContext } from 'react';
import { toast } from '@renderer/lib/hooks/use-toast';
import type { FileLinkParts } from '@renderer/lib/ui/comment-markdown';
import { cn } from '@renderer/lib/utils';
import { requestBrowserMode } from '@renderer/features/artifact/view-request';
import { isHtmlPath } from '@shared/spaces/rig-file';
import { AttachmentSpaceContext } from './attachment-cards';
import { NOT_HERE_YET_DETAIL, NOT_HERE_YET_TITLE, notHereYetText, useSpaceFile } from '../space-file-presence';

/**
 * A file link in the Room (an agent's answer, a message): shown by its path
 * inside the space — never someone's `/Users/…/Rig/<space>/…` — and opened
 * from this computer's copy. When that copy isn't here yet it says so, and
 * a click explains rather than failing; it becomes a plain link once the
 * file lands.
 */

/** The link's own text is just the path it points at (a bare path, `[path](path)`, a `file://` URL). */
function textIsThePath(text: string, href: string): boolean {
  const t = text.trim();
  return t === href || t.startsWith('/') || /^file:\/\//i.test(t);
}

/** Says a file isn't here yet (a click on it, or on anything that points at it). */
export function toastNotHereYet(from?: string | null): void {
  toast({
    title: NOT_HERE_YET_TITLE,
    description: from ? notHereYetText(from) : NOT_HERE_YET_DETAIL,
  });
}

export function SpaceFileLink({
  href,
  text,
  code,
  children,
  onOpen,
  from,
  className,
}: FileLinkParts & {
  /** Opens the link as written (the Room resolves it again against the space); without it, the space's copy opens directly. */
  onOpen?: (href: string) => void;
  /** Whose computer it's coming from, when known ("Arriving from Sam…"). */
  from?: string | null;
  className?: string;
}) {
  const space = useContext(AttachmentSpaceContext);
  const file = useSpaceFile(href);
  const pathText = textIsThePath(text, href);

  // Outside this space (or no space to open it in): a bare path stays text;
  // a written link keeps its old behaviour (the Room says it's outside the
  // space when clicked).
  const nowhere = file.link?.kind === 'outside' || (!file.link && !onOpen);
  if (nowhere && pathText) return code ? <code>{children}</code> : <>{children}</>;

  let label: ReactNode = children;
  if (file.relPath && pathText) label = code ? <code>{file.relPath}</code> : file.relPath;

  const missing = file.relPath !== null && file.present === false;
  return (
    <a
      href={file.relPath ?? href}
      title={missing ? notHereYetText(from) : (file.relPath ?? undefined)}
      data-testid="space-file-link"
      data-missing={missing ? 'true' : undefined}
      className={cn(className, missing && 'text-text-muted! decoration-dashed')}
      onClick={(event) => {
        event.preventDefault();
        if (missing) {
          toastNotHereYet(from);
          return;
        }
        if (onOpen) onOpen(href);
        else if (file.relPath) {
          // An html file opens as a working page, as it does from an agent's answer.
          if (isHtmlPath(file.relPath) && space?.spaceRoot) requestBrowserMode(`${space.spaceRoot.replace(/\/+$/, '')}/${file.relPath}`);
          space?.onOpenFile?.(file.relPath);
        }
      }}
    >
      {label}
      {missing && (
        <CloudDownload className="ml-0.5 inline size-3 align-[-1px]" strokeWidth={1.75} aria-label={NOT_HERE_YET_TITLE} />
      )}
    </a>
  );
}
