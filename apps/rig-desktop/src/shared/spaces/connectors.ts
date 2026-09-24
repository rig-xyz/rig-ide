/**
 * Connectors: the outside tools a space uses (Linear, Notion…), reached by
 * each person's agent with that person's own login. See rig/docs/connectors-spec.md.
 *
 * Two words, kept apart everywhere:
 * - a **connector** is a tool the space uses (shared, on the relay, no secrets);
 * - a **connection** is your own login to it, on this machine (keychain only).
 *
 * v1's catalog is handcrafted: every entry here was checked to accept dynamic
 * client registration as a public client with a loopback redirect.
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
] as const;

export type ConnectorId = (typeof CONNECTOR_IDS)[number];

export interface ConnectorDef {
  id: ConnectorId;
  name: string;
  /** The vendor's remote MCP endpoint (streamable HTTP). */
  url: string;
  /** One short line for the catalog. */
  blurb: string;
  /** Brand color, for the logo tile until a real mark is drawn. */
  brand: string;
}

export const CONNECTORS: readonly ConnectorDef[] = [
  { id: 'linear', name: 'Linear', url: 'https://mcp.linear.app/mcp', blurb: 'Issues, projects, cycles', brand: '#5E6AD2' },
  { id: 'notion', name: 'Notion', url: 'https://mcp.notion.com/mcp', blurb: 'Pages and databases', brand: '#191919' },
  { id: 'posthog', name: 'PostHog', url: 'https://mcp.posthog.com/mcp', blurb: 'Product analytics and flags', brand: '#F54E00' },
  { id: 'amplitude', name: 'Amplitude', url: 'https://mcp.amplitude.com/mcp', blurb: 'Charts and cohorts', brand: '#1E61F0' },
  { id: 'mixpanel', name: 'Mixpanel', url: 'https://mcp.mixpanel.com/mcp', blurb: 'Events and funnels', brand: '#7856FF' },
  { id: 'sentry', name: 'Sentry', url: 'https://mcp.sentry.dev/mcp', blurb: 'Errors and releases', brand: '#362D59' },
  {
    id: 'atlassian',
    name: 'Jira & Confluence',
    url: 'https://mcp.atlassian.com/v1/mcp',
    blurb: 'Tickets and the wiki',
    brand: '#0C66E4',
  },
  { id: 'granola', name: 'Granola', url: 'https://mcp.granola.ai/mcp', blurb: 'Meeting notes and transcripts', brand: '#1F7A4D' },
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
