import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { ok } from '@emdash/shared';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AcpMcpServerWire } from '@emdash/core/acp';
import type { RigToolScope, RigToolsBackend } from './rig-tools';
import { createRigToolsServer, type RigToolsServer } from './rig-tools-server';

const DYLAN: RigToolScope = { bindingId: 'b1', ownerUserId: 'u-dylan', agent: 'claude', cwd: '/rigs/one' };
const OTHER_SPACE: RigToolScope = { bindingId: 'b2', ownerUserId: 'u-dylan', agent: 'claude', cwd: '/rigs/two' };

function fakeBackend(): RigToolsBackend {
  return {
    whoami: async () => ok({ id: 'u-dylan' }),
    bindingAt: () => 'b1',
    createInvite: vi.fn(),
    listMembers: vi.fn(async (bindingId: string) =>
      ok([{ userId: 'u-dylan', clerkUserId: null, name: `Dylan in ${bindingId}`, email: null, role: 'owner', avatarUrl: null }])
    ),
    listInvites: async () => ok([]),
    listFiles: async () => ok([]),
    spaceStory: async () => null,
    listComments: async () => ok([]),
    readText: async () => null,
    createComment: vi.fn(),
    replyComment: vi.fn(),
  };
}

let server: RigToolsServer | null = null;
afterEach(async () => {
  await server?.close();
  server = null;
});

function tokenOf(wire: AcpMcpServerWire): string {
  return wire.headers.find((h) => h.name === 'Authorization')!.value.replace(/^Bearer /, '');
}

async function connect(wire: AcpMcpServerWire, token = tokenOf(wire)): Promise<Client> {
  const client = new Client({ name: 'test', version: '1' });
  await client.connect(
    new StreamableHTTPClientTransport(new URL(wire.url), {
      requestInit: { headers: { Authorization: `Bearer ${token}` } },
    })
  );
  return client;
}

const INITIALIZE = {
  jsonrpc: '2.0',
  id: 1,
  method: 'initialize',
  params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '1' } },
};

async function post(url: string, headers: Record<string, string>, body: unknown = INITIALIZE): Promise<Response> {
  return fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...headers },
    body: JSON.stringify(body),
  });
}

describe('rig tools server', () => {
  it('hands out a local http server named rig, with one stable token per space session', async () => {
    server = createRigToolsServer({ backend: fakeBackend() });
    const first = await server.serverFor(DYLAN);
    expect(first).toMatchObject({ type: 'http', name: 'rig' });
    expect(first.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/mcp$/);
    expect(tokenOf(first)).toMatch(/^[A-Za-z0-9_-]{43}$/);
    // Same session: same token (so its fingerprint doesn't change each turn).
    expect(await server.serverFor(DYLAN)).toEqual(first);
    // Another space, another member, or another agent: another token.
    const tokens = new Set([
      tokenOf(first),
      tokenOf(await server.serverFor(OTHER_SPACE)),
      tokenOf(await server.serverFor({ ...DYLAN, ownerUserId: 'u-sam' })),
      tokenOf(await server.serverFor({ ...DYLAN, agent: 'codex' })),
    ]);
    expect(tokens.size).toBe(4);
  });

  it('refuses requests without a token, or with one it never issued', async () => {
    const backend = fakeBackend();
    server = createRigToolsServer({ backend });
    const wire = await server.serverFor(DYLAN);

    expect((await post(wire.url, {})).status).toBe(401);
    expect((await post(wire.url, { Authorization: 'Bearer not-a-token' })).status).toBe(401);
    expect((await post(wire.url, { Authorization: tokenOf(wire) })).status).toBe(401);
    expect((await fetch(wire.url)).status).toBe(401);
    await expect(connect(wire, 'forged')).rejects.toThrow();
    expect(backend.listMembers).not.toHaveBeenCalled();

    // The real token gets in.
    expect((await post(wire.url, { Authorization: `Bearer ${tokenOf(wire)}` })).status).toBe(200);
  });

  it('refuses other paths, methods, oversize bodies and rebound hosts even with a valid token', async () => {
    server = createRigToolsServer({ backend: fakeBackend() });
    const wire = await server.serverFor(DYLAN);
    const auth = { Authorization: `Bearer ${tokenOf(wire)}` };
    expect((await post(wire.url.replace('/mcp', '/other'), auth)).status).toBe(404);
    expect((await fetch(wire.url, { headers: auth })).status).toBe(405);
    expect((await post(wire.url, auth, { big: 'x'.repeat(1024 * 1024 + 1) })).status).toBe(413);
    // DNS rebinding: a request whose Host isn't loopback.
    const { request } = await import('node:http');
    const status = await new Promise<number>((resolve, reject) => {
      const url = new URL(wire.url);
      const req = request(
        {
          host: '127.0.0.1',
          port: url.port,
          path: '/mcp',
          method: 'POST',
          headers: { ...auth, host: 'evil.example', 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
        },
        (res) => resolve(res.statusCode ?? 0)
      );
      req.on('error', reject);
      req.end(JSON.stringify(INITIALIZE));
    });
    expect(status).toBe(403);
  });

  it('lists the rig tools and runs them for the token’s own space and member only', async () => {
    const backend = fakeBackend();
    server = createRigToolsServer({ backend });
    const client = await connect(await server.serverFor(DYLAN));

    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name)).toEqual([
      'rig_invite',
      'rig_people',
      'rig_recent_changes',
      'rig_file_comments',
      'rig_comment',
    ]);
    expect(tools.find((t) => t.name === 'rig_people')?.annotations?.readOnlyHint).toBe(true);
    expect(client.getInstructions()).toContain('Prefer them over the `rig` CLI');

    const result = await client.callTool({ name: 'rig_people', arguments: {} });
    expect(result.isError).toBeFalsy();
    expect((result.content as Array<{ text: string }>)[0]!.text).toContain('Dylan in b1');
    expect(backend.listMembers).toHaveBeenCalledWith('b1');
    await client.close();

    // Another space's token acts on that space.
    const other = await connect(await server.serverFor(OTHER_SPACE));
    const otherResult = await other.callTool({ name: 'rig_people', arguments: {} });
    expect((otherResult.content as Array<{ text: string }>)[0]!.text).toContain('Dylan in b2');
    await other.close();
  });

  it('reports bad tool input as a tool error', async () => {
    server = createRigToolsServer({ backend: fakeBackend() });
    const client = await connect(await server.serverFor(DYLAN));
    const result = await client.callTool({ name: 'rig_invite', arguments: { email: 'hugo@acme.co', role: 'owner' } });
    expect(result.isError).toBe(true);
    await client.close();
  });

  it('forgets every token when closed', async () => {
    server = createRigToolsServer({ backend: fakeBackend() });
    const before = await server.serverFor(DYLAN);
    await server.close();
    const after = await server.serverFor(DYLAN);
    expect(tokenOf(after)).not.toBe(tokenOf(before));
    expect((await post(after.url, { Authorization: `Bearer ${tokenOf(before)}` })).status).toBe(401);
  });
});
