/**
 * Connectors: the outside tools a space uses (Linear, Notion…), reached by
 * each person's agent with that person's own login. See rig/docs/connectors-spec.md.
 *
 * Two words, kept apart everywhere:
 * - a **connector** is a tool the space uses (shared, on the relay, no secrets);
 * - a **connection** is your own login to it, on this machine (keychain only).
 *
 * v1's catalog is handcrafted: every entry here was checked to accept dynamic
 * client registration with a loopback redirect (a few issue each install its
 * own client secret, which the connection store keeps with the tokens).
 */

export const CONNECTOR_IDS = [
  'linear',
  'notion',
  'posthog',
  'amplitude',
  'mixpanel',
  'sentry',
  'atlassian',
  'granola',
  'intercom',
  'clickup',
  'airtable',
  'attio',
  'stripe',
  'canva',
  'neon',
  'cloudflare',
  'honeycomb',
  'zapier',
  'monday',
  'miro',
  'supabase',
  'vercel',
  'webflow',
  'make',
] as const;

export type ConnectorId = (typeof CONNECTOR_IDS)[number];

/** How the gallery groups tools (its filter chips). */
export const CONNECTOR_CATEGORIES = [
  'Work tracking',
  'Docs & data',
  'Design',
  'Analytics',
  'Engineering',
  'Customers & revenue',
  'Meetings',
  'Automation',
] as const;

export type ConnectorCategory = (typeof CONNECTOR_CATEGORIES)[number];

export interface ConnectorDef {
  id: ConnectorId;
  name: string;
  category: ConnectorCategory;
  /** The vendor's remote MCP endpoint (streamable HTTP). */
  url: string;
  /** One short line for the catalog. */
  blurb: string;
  /** Brand color, for the logo tile until a real mark is drawn. */
  brand: string;
}

export const CONNECTORS: readonly ConnectorDef[] = [
  { id: 'linear', category: 'Work tracking', name: 'Linear', url: 'https://mcp.linear.app/mcp', blurb: 'Issues, projects, cycles', brand: '#5E6AD2' },
  { id: 'notion', category: 'Docs & data', name: 'Notion', url: 'https://mcp.notion.com/mcp', blurb: 'Pages and databases', brand: '#191919' },
  { id: 'posthog', category: 'Analytics', name: 'PostHog', url: 'https://mcp.posthog.com/mcp', blurb: 'Product analytics and flags', brand: '#F54E00' },
  { id: 'amplitude', category: 'Analytics', name: 'Amplitude', url: 'https://mcp.amplitude.com/mcp', blurb: 'Charts and cohorts', brand: '#1E61F0' },
  { id: 'mixpanel', category: 'Analytics', name: 'Mixpanel', url: 'https://mcp.mixpanel.com/mcp', blurb: 'Events and funnels', brand: '#7856FF' },
  { id: 'sentry', category: 'Engineering', name: 'Sentry', url: 'https://mcp.sentry.dev/mcp', blurb: 'Errors and releases', brand: '#362D59' },
  {
    id: 'atlassian',
    category: 'Work tracking',
    name: 'Jira & Confluence',
    url: 'https://mcp.atlassian.com/v1/mcp',
    blurb: 'Tickets and the wiki',
    brand: '#0C66E4',
  },
  { id: 'granola', category: 'Meetings', name: 'Granola', url: 'https://mcp.granola.ai/mcp', blurb: 'Meeting notes and transcripts', brand: '#1F7A4D' },
  { id: 'intercom', category: 'Customers & revenue', name: 'Intercom', url: 'https://mcp.intercom.com/mcp', blurb: 'Customer conversations and tickets', brand: '#1F8DED' },
  { id: 'clickup', category: 'Work tracking', name: 'ClickUp', url: 'https://mcp.clickup.com/mcp', blurb: 'Tasks, docs and goals', brand: '#7B68EE' },
  { id: 'airtable', category: 'Docs & data', name: 'Airtable', url: 'https://mcp.airtable.com/mcp', blurb: 'Bases, tables and records', brand: '#18BFFF' },
  { id: 'attio', category: 'Customers & revenue', name: 'Attio', url: 'https://mcp.attio.com/mcp', blurb: 'CRM: people, companies and deals', brand: '#1C1D1F' },
  { id: 'stripe', category: 'Customers & revenue', name: 'Stripe', url: 'https://mcp.stripe.com', blurb: 'Payments, customers and subscriptions', brand: '#635BFF' },
  { id: 'canva', category: 'Design', name: 'Canva', url: 'https://mcp.canva.com/mcp', blurb: 'Designs, templates and brand assets', brand: '#00C4CC' },
  { id: 'neon', category: 'Engineering', name: 'Neon', url: 'https://mcp.neon.tech/mcp', blurb: 'Serverless Postgres databases', brand: '#34D59A' },
  { id: 'cloudflare', category: 'Engineering', name: 'Cloudflare', url: 'https://mcp.cloudflare.com/mcp', blurb: 'Workers, DNS and edge config', brand: '#F38020' },
  { id: 'honeycomb', category: 'Engineering', name: 'Honeycomb', url: 'https://mcp.honeycomb.io/mcp', blurb: 'Traces, queries and SLOs', brand: '#F5A623' },
  { id: 'zapier', category: 'Automation', name: 'Zapier', url: 'https://mcp.zapier.com/api/mcp/mcp', blurb: 'Actions across thousands of apps', brand: '#FF4F00' },
  { id: 'monday', category: 'Work tracking', name: 'monday.com', url: 'https://mcp.monday.com/mcp', blurb: 'Boards, items and workflows', brand: '#FF3D57' },
  { id: 'miro', category: 'Design', name: 'Miro', url: 'https://mcp.miro.com/', blurb: 'Boards, stickies and diagrams', brand: '#FFD02F' },
  { id: 'supabase', category: 'Engineering', name: 'Supabase', url: 'https://mcp.supabase.com/mcp', blurb: 'Postgres, auth and storage', brand: '#3FCF8E' },
  { id: 'vercel', category: 'Engineering', name: 'Vercel', url: 'https://mcp.vercel.com', blurb: 'Deployments, logs and projects', brand: '#111111' },
  { id: 'webflow', category: 'Design', name: 'Webflow', url: 'https://mcp.webflow.com/mcp', blurb: 'Sites, pages and CMS', brand: '#146EF5' },
  { id: 'make', category: 'Automation', name: 'Make', url: 'https://mcp.make.com', blurb: 'Scenarios and automations', brand: '#6D00CC' },
];

export function isConnectorId(value: unknown): value is ConnectorId {
  return typeof value === 'string' && (CONNECTOR_IDS as readonly string[]).includes(value);
}

export function connectorById(id: string): ConnectorDef | null {
  return CONNECTORS.find((c) => c.id === id) ?? null;
}

/** Your own login to a connector, on this machine. */
export type ConnectionState = 'connected' | 'not_connected' | 'expired';

export interface ConnectionStatus {
  id: ConnectorId;
  state: ConnectionState;
  /** Who you're signed in as there (an email or username), when the connector's server says. Local to you. */
  account?: string;
}

/** How a connect attempt ended. `cancelled` = you pressed Cancel (or started another). */
export type ConnectResult =
  | { ok: true }
  | { ok: false; reason: 'cancelled' | 'timeout' | 'denied' | 'failed'; message?: string };

/**
 * A connector the space uses that this run's agent could NOT reach, recorded on
 * the run (event kind `run_connectors`, payload `{ gaps: ConnectorGap[] }`) so
 * the turn can offer Connect / Reconnect to its owner.
 */
export interface ConnectorGap {
  id: ConnectorId;
  state: Exclude<ConnectionState, 'connected'>;
}

/** Event kind a run records its connector gaps under (see ConnectorGap). */
export const RUN_CONNECTORS_EVENT = 'run_connectors';

/**
 * The MCP server name a connector is injected under. Agents prefix tool names
 * with it: Claude `mcp__linear__list_issues`, Codex `mcp.linear.list_issues`.
 */
export function mcpServerName(id: ConnectorId): string {
  return id;
}

/**
 * "Linear · list issues" from an agent's raw MCP tool name, or null when the
 * name isn't one of ours. Handles Claude (`mcp__<server>__<tool>`) and Codex
 * (`mcp.<server>.<tool>`) spellings.
 */
export function prettyConnectorTool(raw: string): { connector: ConnectorDef; action: string } | null {
  const match = /^mcp__([^_]+(?:_[^_]+)*?)__(.+)$/.exec(raw) ?? /^mcp\.([^.]+)\.(.+)$/.exec(raw);
  if (!match) return null;
  const connector = connectorById(match[1]!);
  if (!connector) return null;
  const action = match[2]!.replace(/[_-]+/g, ' ').trim().toLowerCase();
  return { connector, action };
}

/**
 * An MCP server one of your agents brings from its own global setup (your
 * claude.ai connectors and ~/.claude for Claude, ~/.codex for Codex). Rig
 * never changes these ("global setup is global setup"); it only shows them,
 * and doesn't nudge you to connect a tool your agent already has this way.
 */
export interface GlobalServer {
  agent: 'claude' | 'codex';
  /** As the agent names it, e.g. "claude.ai Linear" or "launchdarkly". */
  name: string;
  /** Remote servers only; null for local (stdio) ones. */
  url: string | null;
  /** The catalog tool it is, matched by URL host; null when it isn't one of ours. */
  connectorId: ConnectorId | null;
}

/** A server the space's own `.mcp.json` declares that you haven't allowed on this device. */
export interface ProjectServerNotice {
  name: string;
  /** Remote servers only; null for local (stdio) ones. */
  url: string | null;
}

/** The catalog tool served at this URL (same host as its MCP endpoint), or null. */
export function connectorIdForUrl(url: string): ConnectorId | null {
  let host: string;
  try {
    host = new URL(url).host;
  } catch {
    return null;
  }
  return CONNECTORS.find((c) => new URL(c.url).host === host)?.id ?? null;
}

/**
 * The MCP server name rig's own tools (invite, people, recent changes, file
 * comments) are handed to room agents under, by the desktop itself — see
 * `main/rig/spaces/rig-tools.ts`. Claude sees `mcp__rig__rig_people_invite`, Codex
 * `mcp.rig.rig_people_invite`.
 */
export const RIG_TOOLS_SERVER = 'rig';

/** The few arguments of a rig tool call its step shows ("Rig · invite hugo@acme.co"). */
export type RigToolArgs = { email?: string; path?: string; replyTo?: string };

const RIG_TOOL_NAME = /^mcp__rig__(.+)$|^mcp\.rig\.(.+)$/;

/**
 * A rig tool call's arguments, from the tool call's `rawInput` (Claude passes
 * them as they are; Codex wraps them as `{ server, tool, arguments }`). Keeps
 * only what a step title uses. Undefined for any other tool.
 */
export function rigToolArgs(raw: string | undefined, rawInput: unknown): RigToolArgs | undefined {
  if (!raw || !RIG_TOOL_NAME.test(raw) || typeof rawInput !== 'object' || rawInput === null) return undefined;
  const wrapped = (rawInput as { arguments?: unknown }).arguments;
  const input = (typeof wrapped === 'object' && wrapped !== null ? wrapped : rawInput) as Record<string, unknown>;
  const args: RigToolArgs = {};
  if (typeof input.email === 'string' && input.email) args.email = input.email;
  if (typeof input.path === 'string' && input.path) args.path = input.path;
  if (typeof input.reply_to === 'string' && input.reply_to) args.replyTo = input.reply_to;
  return Object.keys(args).length > 0 ? args : undefined;
}

/**
 * "invite hugo@acme.co" from a rig tool's raw name and arguments, or null when
 * it isn't one of rig's own tools. Knows the names from before Rig 0.4.13 too
 * (`rig_invite`, `browser_read`…), so old transcripts keep reading right.
 */
export function prettyRigTool(raw: string, args?: RigToolArgs): string | null {
  const match = RIG_TOOL_NAME.exec(raw);
  if (!match) return null;
  const tool = (match[1] ?? match[2]!).replace(/^rig_/, '');
  const on = args?.path ? ` on ${args.path}` : '';
  switch (tool) {
    case 'space_rename':
    case 'rename_space':
      return 'rename space';
    case 'people_invite':
    case 'invite':
      return args?.email ? `invite ${args.email}` : 'invite';
    case 'people_list':
    case 'people':
      return 'people';
    case 'chat_read':
    case 'chat_history':
      return 'chat history';
    case 'chat_react':
    case 'react':
      return 'react';
    case 'changes_list':
    case 'recent_changes':
      return 'recent changes';
    case 'comments_read':
    case 'file_comments':
      return `comments${on}`;
    case 'comments_add':
    case 'comment':
      return `${args?.replyTo ? 'reply' : 'comment'}${on}`;
    case 'settings_read':
    case 'settings':
      return 'settings';
    case 'settings_update':
    case 'update_settings':
      return 'update settings';
    case 'browser_pins':
      return 'browser pins';
    case 'browser_read':
      return 'browser read';
    case 'browser_screenshot':
      return 'browser screenshot';
    default:
      return tool.replace(/[_-]+/g, ' ').trim().toLowerCase();
  }
}

/**
 * Any MCP tool name an agent reports, made readable: "Linear · list issues".
 * `via` says where the tool came from: `space` for a connector rig handed to
 * the session, `setup` for one from the agent's own global setup (claude.ai
 * connectors show as `mcp__claude_ai_<Name>__<tool>`), `rig` for rig's own
 * tools (`args` fills in who or which file). Null when it isn't an MCP tool
 * name at all.
 */
export function prettyAgentTool(
  raw: string,
  args?: RigToolArgs
): { label: string; action: string; connector: ConnectorDef | null; via: 'space' | 'setup' | 'rig' } | null {
  const rig = prettyRigTool(raw, args);
  if (rig) return { label: 'Rig', action: rig, connector: null, via: 'rig' };
  const ours = prettyConnectorTool(raw);
  if (ours) return { label: ours.connector.name, action: ours.action, connector: ours.connector, via: 'space' };
  const match = /^mcp__(.+?)__(.+)$/.exec(raw) ?? /^mcp\.([^.]+)\.(.+)$/.exec(raw);
  if (!match) return null;
  const server = match[1]!.replace(/^claude_ai_/, '').replace(/[_-]+/g, ' ').trim();
  const connector = CONNECTORS.find((c) => c.name.toLowerCase() === server.toLowerCase()) ?? null;
  const action = match[2]!.replace(/[_-]+/g, ' ').trim().toLowerCase();
  return { label: connector?.name ?? server, action, connector, via: 'setup' };
}
