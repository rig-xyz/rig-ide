/**
 * Which "site" a page belongs to for signing in (canvas board 18): a site is
 * its registrable domain (eTLD+1: docs.google.com → google.com), plus the
 * hosts its sign-in lives on. The host list is exactly what rig copies from
 * the browser and exactly what the person is shown before it does.
 *
 * Pure, shared by main (import, sign out, agents) and the renderer (the
 * page header's chip names the site without a round trip).
 */

export interface SignInSite {
  /** The registrable domain: the key sign-ins are stored under. */
  id: string;
  /** What the person reads: "Google", "Notion", or the domain itself. */
  name: string;
  /** Hosts whose cookies are copied (each also covers its leading-dot domain cookie, never other subdomains). */
  hosts: string[];
  /** Where a new sign-in is checked when no page is at hand (Settings › Add a site). */
  checkUrl: string;
}

interface KnownSite {
  name: string;
  hosts: string[];
  checkUrl: string;
}

/**
 * Sites whose sign-in lives on known hosts. Extend freely: a site missing
 * here still works, with its domain, `www.` and the page's own host.
 */
export const KNOWN_SIGN_IN_SITES: Readonly<Record<string, KnownSite>> = {
  'google.com': {
    name: 'Google',
    hosts: ['docs.google.com', 'accounts.google.com', 'google.com'],
    checkUrl: 'https://docs.google.com/document/u/0/',
  },
  'claude.ai': { name: 'Claude', hosts: ['claude.ai'], checkUrl: 'https://claude.ai/recents' },
  'notion.so': { name: 'Notion', hosts: ['notion.so', 'www.notion.so'], checkUrl: 'https://www.notion.so/' },
  'figma.com': { name: 'Figma', hosts: ['figma.com', 'www.figma.com'], checkUrl: 'https://www.figma.com/files/recents-and-sharing' },
  'linear.app': { name: 'Linear', hosts: ['linear.app'], checkUrl: 'https://linear.app/' },
  'slack.com': { name: 'Slack', hosts: ['slack.com', 'app.slack.com'], checkUrl: 'https://app.slack.com/client' },
  'github.com': { name: 'GitHub', hosts: ['github.com'], checkUrl: 'https://github.com/' },
};

/** Two-label public suffixes under a country code: example.co.uk, example.com.au. */
const CC_SECOND_LEVEL = new Set(['co', 'com', 'net', 'org', 'gov', 'edu', 'ac', 'or', 'ne', 'go', 'gob', 'gouv', 'nic', 'mil', 'ltd', 'plc', 'sch']);

/**
 * Hosting suffixes where every subdomain is someone else's site (the public
 * suffix list's private section, the ones people actually link to).
 */
const PRIVATE_SUFFIXES = new Set([
  'github.io',
  'gitlab.io',
  'vercel.app',
  'netlify.app',
  'pages.dev',
  'workers.dev',
  'web.app',
  'firebaseapp.com',
  'appspot.com',
  'herokuapp.com',
  'onrender.com',
  'fly.dev',
  'azurewebsites.net',
  'cloudfront.net',
  'amplifyapp.com',
  'blogspot.com',
  'notion.site',
  'webflow.io',
  'framer.app',
  'replit.app',
  'streamlit.app',
  'lovable.app',
  'ngrok.io',
  'ngrok-free.app',
  'glitch.me',
]);

function isIp(host: string): boolean {
  return /^\d{1,3}(\.\d{1,3}){3}$/.test(host) || host.includes(':');
}

/** eTLD+1 for a host, by a small rule set (no bundled public suffix list): lower-cased, no trailing dot. */
export function registrableDomain(hostname: string): string {
  const host = hostname.toLowerCase().replace(/\.$/, '').replace(/^\[|\]$/g, '');
  if (isIp(host)) return host;
  const labels = host.split('.').filter(Boolean);
  if (labels.length <= 2) return labels.join('.');
  const lastTwo = labels.slice(-2).join('.');
  if (PRIVATE_SUFFIXES.has(lastTwo)) return labels.slice(-3).join('.');
  const tld = labels.at(-1)!;
  const second = labels.at(-2)!;
  if (tld.length === 2 && CC_SECOND_LEVEL.has(second)) return labels.slice(-3).join('.');
  return lastTwo;
}

function hostnameOf(url: string): string | null {
  try {
    const u = new URL(url);
    return u.protocol === 'https:' || u.protocol === 'http:' ? u.hostname.toLowerCase() : null;
  } catch {
    return null;
  }
}

/** A site by its id (registrable domain), with an optional page host that joins the list for sites rig doesn't know. */
export function signInSiteFor(domain: string, pageHost?: string): SignInSite {
  const id = registrableDomain(domain);
  const known = KNOWN_SIGN_IN_SITES[id];
  if (known) return { id, ...known, hosts: [...known.hosts] };
  const hosts = [id, `www.${id}`];
  if (pageHost && pageHost !== id && pageHost !== `www.${id}` && registrableDomain(pageHost) === id) hosts.push(pageHost);
  return { id, name: id, hosts, checkUrl: `https://${pageHost && registrableDomain(pageHost) === id ? pageHost : id}/` };
}

/** The site a page belongs to, or null for a link that isn't a web page (or is a bare IP / localhost). */
export function signInSiteForUrl(url: string): SignInSite | null {
  const host = hostnameOf(url);
  if (!host || isIp(host) || !host.includes('.')) return null;
  return signInSiteFor(host, host);
}

/** Whether a browser cookie's `host_key` is one of a site's hosts (`h` or `.h` exactly). */
export function cookieHostMatches(hostKey: string, hosts: readonly string[]): boolean {
  const bare = hostKey.toLowerCase().replace(/^\./, '');
  return hosts.includes(bare);
}

/** Every `host_key` spelling that can hold a site's cookies: `h` and `.h`. */
export function cookieHostKeys(hosts: readonly string[]): string[] {
  return hosts.flatMap((h) => [h, `.${h}`]);
}

/** Hosts that only ever show a sign-in form, whichever site sent you there. */
const SIGN_IN_HOSTS = new Set([
  'accounts.google.com',
  'login.microsoftonline.com',
  'login.live.com',
  'id.atlassian.com',
  'appleid.apple.com',
  'auth.openai.com',
]);
const SIGN_IN_HOST_SUFFIXES = ['.okta.com', '.auth0.com', '.onelogin.com'];

/** First path segments that are a sign-in form: /login, /signin, /sign-in, /users/sign_in … */
const SIGN_IN_PATH = /^\/(?:[a-z-]+\/)?(?:log-?in|sign-?in|sign_in|signin|sso|session|auth\/login|oauth\/authorize)(?:[/?#]|$)/i;

/**
 * Whether a page is a sign-in wall: a redirect to a known sign-in host, a
 * sign-in path, or a password field on the page (board 18, A: "a password
 * field, or a redirect to a known sign-in host").
 */
export function isSignInWall(page: { url: string; hasPasswordField?: boolean }): boolean {
  if (page.hasPasswordField) return true;
  let u: URL;
  try {
    u = new URL(page.url);
  } catch {
    return false;
  }
  const host = u.hostname.toLowerCase();
  if (SIGN_IN_HOSTS.has(host) || SIGN_IN_HOST_SUFFIXES.some((s) => host.endsWith(s))) return true;
  return SIGN_IN_PATH.test(u.pathname);
}

/**
 * What an agent is told instead of a sign-in page's HTML when it reads a
 * page its owner isn't signed in to in rig (board 18, case 11).
 */
export function notSignedInForAgent(url: string, record: Pick<PageSignInRecord, 'siteName' | 'account'> | null): string {
  let host = url;
  try {
    host = new URL(url).hostname;
  } catch {
    // keep the link as given
  }
  const why = record
    ? `rig's copy of their ${record.siteName} sign-in${record.account ? ` (${record.account})` : ''} was refused or has expired`
    : 'the page opened on a sign-in form';
  return (
    `Not signed in to ${host} as the owner: ${why}, so its content isn't available to you. ` +
    'Say so in your answer: the owner can sign the page in from its header in rig, then ask again.'
  );
}

/** Why a sign-in couldn't be used (board 18, C and D). */
export type SignInFailureReason =
  /** No Chromium browser is installed (case 10). */
  | 'no_browser'
  /** The chosen profile holds no sign-in for the site (case 5). */
  | 'not_signed_in'
  /** macOS "access data from other apps" was refused: Files & Folders (case 2). */
  | 'folder_access_denied'
  /** The Keychain prompt was denied or dismissed (case 4). */
  | 'keychain_denied'
  /** The check reload landed on a sign-in form again (case 7). */
  | 'rejected_by_site'
  /** Stopped by the person (Cancel in the sheet). */
  | 'cancelled'
  | 'failed';

export type BrowserId = 'chrome' | 'arc' | 'brave' | 'edge' | 'chromium' | 'vivaldi';

/** A browser profile, from the browser's own list (no cookies read). */
export interface BrowserProfileInfo {
  browser: BrowserId;
  browserName: string;
  /** The profile's folder ("Default", "Profile 2"): how it's picked. */
  dir: string;
  /** The profile's name in the browser ("Personal"). */
  name: string;
  /** The account signed in to the browser profile, when there is one. */
  email: string | null;
}

/** A profile that holds a sign-in for the site, and when it was last used. */
export interface ProfileWithSignIn extends BrowserProfileInfo {
  /** ms epoch of the newest use of any of the site's cookies. */
  lastUsedAt: number;
}

/** What's kept per signed-in site (never cookie values). */
export interface PageSignInRecord {
  site: string;
  siteName: string;
  browser: BrowserId;
  browserName: string;
  profile: string;
  profileName: string;
  /** Who the page is open as: the browser profile's account, when it has one. */
  account: string | null;
  hosts: string[];
  /** The page the sign-in was checked on; later refreshes check there again. */
  checkUrl: string;
  importedAt: number;
  /** ms epoch of the browser's newest change to the site's cookies when they were copied: "Keep in step" compares against it. */
  sourceUpdatedAt: number;
  /** The browser has a newer sign-in that couldn't be picked up silently. */
  refreshAvailable?: boolean;
  /** A page of this site landed on a sign-in wall since: the copy has expired or was refused. */
  expired?: boolean;
}

/** What rig knows of macOS's two permissions, per browser (it can't ask macOS without prompting). */
export interface BrowserAccess {
  /** Files & Folders ("access data from other apps"): last seen outcome. */
  folder: 'granted' | 'denied' | 'unknown';
  /** Keychain: `granted` after a read succeeded; `silent` once a read came back without asking (Always Allow). */
  keychain: 'unknown' | 'granted' | 'silent';
}

export interface PageSignInsState {
  sites: Record<string, PageSignInRecord>;
  /** "Keep in step with Chrome": on app focus, pick up newer sign-ins for these sites only. */
  keepInStep: boolean;
  access: Partial<Record<BrowserId, BrowserAccess>>;
}

export const DEFAULT_PAGE_SIGN_INS: PageSignInsState = { sites: {}, keepInStep: false, access: {} };

const BROWSER_IDS: readonly BrowserId[] = ['chrome', 'arc', 'brave', 'edge', 'chromium', 'vivaldi'];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function normalizeRecord(value: unknown): PageSignInRecord | null {
  if (!isRecord(value)) return null;
  const v = value;
  const str = (k: string) => (typeof v[k] === 'string' ? (v[k] as string) : null);
  const num = (k: string) => (typeof v[k] === 'number' ? (v[k] as number) : 0);
  const site = str('site');
  const browser = str('browser') as BrowserId | null;
  const profile = str('profile');
  if (!site || !browser || !BROWSER_IDS.includes(browser) || !profile || !Array.isArray(v.hosts)) return null;
  return {
    site,
    siteName: str('siteName') ?? site,
    browser,
    browserName: str('browserName') ?? browser,
    profile,
    profileName: str('profileName') ?? profile,
    account: str('account'),
    hosts: v.hosts.filter((h): h is string => typeof h === 'string'),
    checkUrl: str('checkUrl') ?? `https://${site}/`,
    importedAt: num('importedAt'),
    sourceUpdatedAt: num('sourceUpdatedAt'),
    ...(v.refreshAvailable === true ? { refreshAvailable: true } : {}),
    ...(v.expired === true ? { expired: true } : {}),
  };
}

/** Parse-tolerant read of the stored state: anything malformed is dropped, never a crash. */
export function normalizePageSignIns(value: unknown): PageSignInsState {
  if (!isRecord(value)) return { ...DEFAULT_PAGE_SIGN_INS };
  const sites: Record<string, PageSignInRecord> = {};
  if (isRecord(value.sites)) {
    for (const [id, entry] of Object.entries(value.sites)) {
      const record = normalizeRecord(entry);
      if (record && record.site === id) sites[id] = record;
    }
  }
  const access: Partial<Record<BrowserId, BrowserAccess>> = {};
  if (isRecord(value.access)) {
    for (const [id, entry] of Object.entries(value.access)) {
      if (!BROWSER_IDS.includes(id as BrowserId) || !isRecord(entry)) continue;
      const folder = entry.folder === 'granted' || entry.folder === 'denied' ? entry.folder : 'unknown';
      const keychain = entry.keychain === 'granted' || entry.keychain === 'silent' ? entry.keychain : 'unknown';
      access[id as BrowserId] = { folder, keychain };
    }
  }
  return { sites, keepInStep: value.keepInStep === true, access };
}
