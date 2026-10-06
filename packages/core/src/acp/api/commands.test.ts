import { describe, expect, it } from 'vitest';
import { acpMcpServerSchema, acpStartInputSchema, isHttpMcpServer } from './commands';

const http = { type: 'http', name: 'linear', url: 'https://mcp.linear.app/mcp', headers: [{ name: 'Authorization', value: 'Bearer t' }] };
const stdio = { name: 'notes', command: 'node', args: ['notes-server.js'], env: [{ name: 'KEY', value: 'k' }] };

describe('acpMcpServerSchema', () => {
  it('takes a remote server and a local one, in ACP’s shapes', () => {
    expect(acpMcpServerSchema.parse(http)).toEqual(http);
    expect(acpMcpServerSchema.parse(stdio)).toEqual(stdio);
    expect(
      acpStartInputSchema.parse({
        conversationId: 'c',
        projectId: 'p',
        taskId: 't',
        providerId: 'codex',
        workspaceId: '/w',
        cwd: '/w',
        sessionId: null,
        model: null,
        mcpServers: [http, stdio],
      }).mcpServers
    ).toEqual([http, stdio]);
  });

  it('refuses what is neither', () => {
    expect(acpMcpServerSchema.safeParse({ type: 'http', name: 'x', url: 'not a url', headers: [] }).success).toBe(false);
    expect(acpMcpServerSchema.safeParse({ name: 'x', command: '', args: [], env: [] }).success).toBe(false);
    expect(acpMcpServerSchema.safeParse({ name: 'x', command: 'node' }).success).toBe(false);
    expect(acpMcpServerSchema.safeParse({ name: 'x' }).success).toBe(false);
  });

  it('tells a remote server from a local one', () => {
    expect(isHttpMcpServer(acpMcpServerSchema.parse(http))).toBe(true);
    expect(isHttpMcpServer(acpMcpServerSchema.parse(stdio))).toBe(false);
  });
});
