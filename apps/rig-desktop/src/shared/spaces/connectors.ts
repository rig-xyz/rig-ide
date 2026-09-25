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
