import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect } from 'react';
import type { SignInsList } from '@main/rig/pages/page-sign-ins';
import { events, rpc } from '@renderer/lib/ipc';
import type { BrowserId, PageSignInRecord } from '@shared/pages/sign-in-sites';
import { rigSettingsChangedChannel } from '@shared/rig/settings';

/**
 * Which sites pages are signed in to, from where, and what rig knows of
 * macOS's permissions (board 18). Main keeps it in rig settings, so every
 * change (a sign-in, Keep in step, a sign-in wall marking one expired)
 * arrives as a settings change and refreshes this.
 */

export const SIGN_INS_KEY = ['rig', 'pages', 'sign-ins'];

export function useSignIns() {
  const queryClient = useQueryClient();
  useEffect(() => events.on(rigSettingsChangedChannel, () => void queryClient.invalidateQueries({ queryKey: SIGN_INS_KEY })), [queryClient]);
  return useQuery({ queryKey: SIGN_INS_KEY, queryFn: (): Promise<SignInsList> => rpc.rig.pages.signIns() });
}

export function recordFor(list: SignInsList | undefined, siteId: string | null | undefined): PageSignInRecord | null {
  return (siteId && list?.sites.find((s) => s.site === siteId)) || null;
}

/** "Chrome" unless only another Chromium browser is installed ("Arc"). */
export function browserLabel(list: Pick<SignInsList, 'browsers'> | undefined, id?: BrowserId | null): string {
  return list?.browsers.find((b) => b.id === id)?.name ?? list?.browsers[0]?.name ?? 'Chrome';
}

/** The browser's name as macOS lists it under Files & Folders. */
export function macFolderName(name: string): string {
  return name === 'Chrome' ? 'Google Chrome' : name === 'Edge' ? 'Microsoft Edge' : name;
}

/** Who a signed-in page is open as. */
export function accountLabel(record: PageSignInRecord): string {
  return record.account ?? record.profileName;
}

/** "2h ago", "3d ago". */
export function usedAgo(ms: number, now = Date.now()): string {
  const s = Math.max(0, Math.round((now - ms) / 1000));
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  if (s < 86_400) return `${Math.round(s / 3600)}h ago`;
  return `${Math.round(s / 86_400)}d ago`;
}
