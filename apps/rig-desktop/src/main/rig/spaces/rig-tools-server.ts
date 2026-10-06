import { createHash, randomBytes } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { AcpHttpMcpServerWire } from '@emdash/core/acp';
import { log } from '@main/lib/logger';
import { z } from 'zod';
import { RIG_TOOLS_SERVER } from '@shared/spaces/connectors';
import { createRigTools, runRigTool, type RigTool, type RigToolScope, type RigToolsBackend } from './rig-tools';

/**
 * The desktop's own MCP server for rig tools (`rig-tools.ts`), handed to each
 * room agent session next to the space's connectors, as an `http` server
 * named `rig`. Streamable HTTP on 127.0.0.1 at a port the OS picks, started
 * on first use and kept for the app's lifetime.
 *
 * **One bearer token per session key** (space, member, agent): random, held
 * in memory only (looked up by its hash), never logged. A request without a
 * known token is refused before any MCP handling, and the token alone decides
 * which member and which space a call acts for, so an agent can't reach
 * another space or member by what it sends. The token for a key never
 * changes while the app runs, so it doesn't reload the session on every turn
 * (`connectorsFingerprint` includes it); a restart mints new ones, and the
 * dispatcher starts or resumes each session with the new server anyway.
 *
 * Stateless: each POST gets a fresh MCP server and transport (JSON replies,
 * no standalone SSE stream), so there's no MCP session to track or expire.
 */

const MAX_BODY_BYTES = 1024 * 1024;

/**
 * Kept to one sentence: Codex shows it ahead of every tool's description in
 * its (truncated) tool listing, so a long one made all the rig tools look
 * alike. What each tool does leads its own description instead.
 */
const INSTRUCTIONS = "Rig's tools for this space, acting as your owner: prefer them over the `rig` CLI.";

export interface RigToolsServer {
  /**
   * The `rig` server entry for one member's session in one space, with its
   * bearer token. Starts the server on first use.
   */
  serverFor(scope: RigToolScope): Promise<AcpHttpMcpServerWire>;
  close(): Promise<void>;
}

function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

function keyFor(scope: RigToolScope): string {
  return `${scope.bindingId}::${scope.ownerUserId}::${scope.agent}`;
}

class BodyError extends Error {
  constructor(readonly status: number) {
    super(`request body refused (${status})`);
  }
}

async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > MAX_BODY_BYTES) throw new BodyError(413);
    chunks.push(chunk as Buffer);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new BodyError(400);
  }
}

function reply(res: ServerResponse, status: number, body?: Record<string, unknown>, headers: Record<string, string> = {}): void {
  res.writeHead(status, { ...(body ? { 'content-type': 'application/json' } : {}), ...headers });
  res.end(body ? JSON.stringify(body) : undefined);
}

export function createRigToolsServer(deps: { backend: RigToolsBackend; now?: () => number; extraTools?: RigTool[] }): RigToolsServer {
  // rig_space_describe lists them all, the browser tools included.
  const tools: RigTool[] = [...createRigTools(deps.backend, deps.now, () => tools), ...(deps.extraTools ?? [])];
  /** Session key → its token, so the same session always gets the same one. */
  const tokenByKey = new Map<string, string>();
  /** Token hash → who and where it acts for. */
  const scopeByHash = new Map<string, RigToolScope>();
  let started: Promise<{ server: Server; port: number }> | null = null;

  function scopeOf(req: IncomingMessage): RigToolScope | null {
    const match = /^Bearer\s+(\S+)$/i.exec(req.headers.authorization ?? '');
    return match ? (scopeByHash.get(hashToken(match[1]!)) ?? null) : null;
  }

  async function handle(req: IncomingMessage, res: ServerResponse, port: number): Promise<void> {
    const scope = scopeOf(req);
    if (!scope) return reply(res, 401, { error: 'unauthorized' });
    if (req.url?.split('?')[0] !== '/mcp') return reply(res, 404, { error: 'not_found' });
    // Stateless: no standalone SSE stream to open, no MCP session to delete.
    if (req.method !== 'POST') return reply(res, 405, { error: 'method_not_allowed' }, { allow: 'POST' });

    let body: unknown;
    try {
      body = await readJsonBody(req);
    } catch (error) {
      return reply(res, error instanceof BodyError ? error.status : 400, { error: 'invalid_body' });
    }

    const [{ McpServer }, { StreamableHTTPServerTransport }] = await Promise.all([
      import('@modelcontextprotocol/sdk/server/mcp.js'),
      import('@modelcontextprotocol/sdk/server/streamableHttp.js'),
    ]);
    const mcp = new McpServer({ name: RIG_TOOLS_SERVER, version: '1.0.0' }, { instructions: INSTRUCTIONS });
    for (const tool of tools) {
      mcp.registerTool(
        tool.name,
        {
          title: tool.annotations.title,
          description: tool.description,
          // A plain shape drops unknown arguments; a tool that must refuse them gets a strict object.
          inputSchema: tool.unknownArgs
            ? z.strictObject(tool.inputSchema, {
                error: (issue) => (issue.code === 'unrecognized_keys' ? `Can't change ${issue.keys.join(', ')}. ${tool.unknownArgs}` : undefined),
              })
            : tool.inputSchema,
          annotations: tool.annotations,
        },
        async (input: Record<string, unknown>) => {
          const result = await runRigTool(deps.backend, tool, scope, input);
          return { content: result.content ?? [{ type: 'text' as const, text: result.text }], ...(result.isError ? { isError: true } : {}) };
        }
      );
    }
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
      // The bearer token already keeps browsers out; this also refuses a rebound hostname.
      enableDnsRebindingProtection: true,
      allowedHosts: [`127.0.0.1:${port}`, `localhost:${port}`],
    });
    res.on('close', () => {
      void transport.close();
      void mcp.close();
    });
    await mcp.connect(transport);
    await transport.handleRequest(req, res, body);
  }

  function start(): Promise<{ server: Server; port: number }> {
    started ??= new Promise((resolve, reject) => {
      let port = 0;
      const server = createServer((req, res) => {
        handle(req, res, port).catch((error: unknown) => {
          log.warn('Rig tools: a request failed', { error: String(error) });
          if (!res.headersSent) reply(res, 500, { error: 'internal' });
          else res.end();
        });
      });
      server.once('error', (error) => {
        started = null;
        reject(error);
      });
      server.listen(0, '127.0.0.1', () => {
        port = (server.address() as AddressInfo).port;
        server.unref();
        log.info('Rig tools: local MCP server listening', { port });
        resolve({ server, port });
      });
    });
    return started;
  }

  return {
    async serverFor(scope) {
      const { port } = await start();
      const key = keyFor(scope);
      let token = tokenByKey.get(key);
      if (!token) {
        token = randomBytes(32).toString('base64url');
        tokenByKey.set(key, token);
      }
      // Refreshed each time: the space's folder can move on this device.
      scopeByHash.set(hashToken(token), scope);
      return {
        type: 'http',
        name: RIG_TOOLS_SERVER,
        url: `http://127.0.0.1:${port}/mcp`,
        headers: [{ name: 'Authorization', value: `Bearer ${token}` }],
      };
    },

    async close() {
      const current = started;
      started = null;
      tokenByKey.clear();
      scopeByHash.clear();
      if (!current) return;
      const { server } = await current.catch(() => ({ server: null }));
      if (!server) return;
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
