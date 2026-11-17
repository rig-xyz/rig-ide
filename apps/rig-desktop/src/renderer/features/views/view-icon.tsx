import {
  Activity,
  Columns3,
  GitPullRequestArrow,
  Inbox,
  LayoutDashboard,
  ListChecks,
  ScrollText,
  type LucideProps,
} from 'lucide-react';
import dynamicIconImports from 'lucide-react/dynamicIconImports';
import { lazy, Suspense, type ComponentType } from 'react';
import type { ViewKind, ViewManifest } from '@shared/rig/views';

const KIND_ICONS: Record<ViewKind, typeof LayoutDashboard> = {
  queue: ListChecks,
  board: Columns3,
  intake: Inbox,
  feed: ScrollText,
  prs: GitPullRequestArrow,
  tracker: Activity,
  page: LayoutDashboard,
};

type IconName = keyof typeof dynamicIconImports;
const isIconName = (name: string): name is IconName => Object.hasOwn(dynamicIconImports, name);

/** Each named icon is fetched once, on first use. */
const loaded = new Map<IconName, ComponentType<LucideProps>>();
function namedIcon(name: IconName): ComponentType<LucideProps> {
  let Icon = loaded.get(name);
  if (!Icon) {
    Icon = lazy(dynamicIconImports[name]);
    loaded.set(name, Icon);
  }
  return Icon;
}

/**
 * A view's icon: the one its `view.json` names, from the whole Lucide set, else the icon of its
 * kind. The named icon loads on first use; the kind's icon holds its place until then.
 */
export function ViewIcon({
  view,
  ...props
}: { view: Pick<ViewManifest, 'kind' | 'icon'> | undefined } & LucideProps) {
  const Kind = KIND_ICONS[view?.kind ?? 'page'];
  const name = view?.icon ?? '';
  if (!isIconName(name)) return <Kind {...props} />;
  const Named = namedIcon(name);
  return (
    <Suspense fallback={<Kind {...props} />}>
      <Named {...props} />
    </Suspense>
  );
}
