import { z } from 'zod';
import { attachmentRefSchema } from '../models/attachments';
import { permissionDecisionSchema } from '../models/permissions';
import { promptDraftUpdateSchema, promptInputSchema, queuedPromptSchema } from '../models/prompt';

const acpNameValueSchema = z.object({ name: z.string(), value: z.string() });

/**
 * A remote MCP server handed to the agent for this one session (ACP
 * `mcpServers` on `session/new` / `session/load`). Headers may carry a bearer
 * token: this input lives in memory only and must never be logged or
 * persisted.
 */
export const acpHttpMcpServerSchema = z.object({
  type: z.literal('http'),
  name: z.string(),
  url: z.string().url(),
  headers: z.array(acpNameValueSchema),
});
export type AcpHttpMcpServerWire = z.infer<typeof acpHttpMcpServerSchema>;

/**
 * A local MCP server the agent runs itself, in ACP's stdio shape (no `type`,
 * as ACP and codex-acp take it). Its env may carry keys, like the http
 * variant's headers.
 *
 * Main process only. A session started from the renderer must never be able
 * to make the runtime spawn a command: the desktop's renderer wire drops
 * every non-http server before forwarding a start or resume (see the ACP
 * runtime host's renderer controller). Only main-process callers can hand
 * one over.
 */
export const acpStdioMcpServerSchema = z.object({
  name: z.string(),
  command: z.string().min(1),
  args: z.array(z.string()),
  env: z.array(acpNameValueSchema),
});
export type AcpStdioMcpServerWire = z.infer<typeof acpStdioMcpServerSchema>;

export const acpMcpServerSchema = z.union([acpHttpMcpServerSchema, acpStdioMcpServerSchema]);
export type AcpMcpServerWire = z.infer<typeof acpMcpServerSchema>;

/** A remote (http) server: the only kind a renderer-started session may carry. */
export function isHttpMcpServer(server: AcpMcpServerWire): server is AcpHttpMcpServerWire {
  return 'type' in server && server.type === 'http';
}

export const acpStartInputSchema = z.object({
  conversationId: z.string(),
  projectId: z.string(),
  taskId: z.string(),
  providerId: z.string(),
  workspaceId: z.string(),
  cwd: z.string(),
  sessionId: z.string().nullable(),
  model: z.string().nullable(),
  initialQueue: z.array(promptInputSchema).optional(),
  env: z.record(z.string(), z.string()).optional(),
  mcpServers: z.array(acpMcpServerSchema).optional(),
  /**
   * Claude only: servers from the folder's own `.mcp.json` to keep out of
   * this session (its `disabledMcpjsonServers`). Names only, on purpose: a
   * free-form settings passthrough would let a renderer-started session set
   * hooks that run commands.
   */
  disabledProjectMcpServers: z.array(z.string()).optional(),
  /**
   * Claude: text appended to Claude Code's own system prompt (the adapter's
   * `_meta.systemPrompt.append`), never replacing it. Codex: the thread's
   * developer instructions (`_meta.developerInstructions`, through our
   * codex-acp patch). A space session uses it for the space's rules and, for
   * Claude, the folder's AGENTS.md, which Claude Code skips when there's also
   * a CLAUDE.md.
   */
  systemPromptAppend: z.string().max(64_000).optional(),
  /**
   * Claude only: tools this session can never use, whatever the person's own
   * settings allow (the adapter's `disallowedTools`, as deny rules). It only
   * ever narrows what the session can do.
   */
  disallowedTools: z.array(z.string().max(200)).max(100).optional(),
  /** Claude only: no bypass-permissions mode in this session, even if the person's settings allow it. */
  noBypassPermissions: z.boolean().optional(),
  /**
   * Claude only: the permission rules in the person's own settings files
   * don't apply to this session (Claude Code's managed-tier
   * `allowManagedPermissionRulesOnly`). Their allow rules can't approve a
   * call, so every call the deny rules don't settle comes to the app's
   * permission handler. It only ever narrows the session. An IT-managed tier
   * on the Mac drops it, so a session that must stay narrow also has a
   * `toolGuardCommand`.
   */
  appPermissionsOnly: z.boolean().optional(),
  /**
   * Claude only: a shell command Claude Code runs before every tool call (a
   * PreToolUse command hook in the session's own settings tier). It gets the
   * call on stdin and may deny it; a hook's deny beats any allow rule and any
   * other hook's allow. Set by the app for its own background sessions.
   */
  toolGuardCommand: z.string().max(65_536).optional(),
  /**
   * Claude only: Claude Code's debug log for this session goes to this file
   * (the adapter's `debug` and `debugFile` options). Set by the app for a
   * space session when it runs with RIG_CLAUDE_DEBUG=1; off otherwise.
   */
  claudeDebugFile: z.string().optional(),
});
export type AcpStartInputWire = z.infer<typeof acpStartInputSchema>;

export const sendPromptResponseSchema = z.object({ queued: z.boolean() });
// `turnId` is the queued prompt's own id — stable across the `turn_start`/
// `turn_end` markers a caller (e.g. spaces' dispatcher) sees on the
// conversation's raw session-event stream, so it can bind this specific
// queued request to exactly its own turn instead of inferring it from a
// separately delivered busy/idle signal.
export const queuePromptResponseSchema = z.object({ queued: z.boolean(), turnId: z.string() });

export const startSessionCommandSchema = z.object({ input: acpStartInputSchema });
export const resumeSessionCommandSchema = z.object({
  input: acpStartInputSchema.extend({ sessionId: z.string() }),
});
export const stopSessionCommandSchema = z.object({ conversationId: z.string() });
export const sendPromptCommandSchema = z.object({
  conversationId: z.string(),
  prompt: promptInputSchema,
});
export const queuePromptCommandSchema = sendPromptCommandSchema;
export const editQueuedPromptCommandSchema = z.object({
  conversationId: z.string(),
  id: z.string(),
  input: promptInputSchema,
});
export const deleteQueuedPromptCommandSchema = z.object({
  conversationId: z.string(),
  id: z.string(),
});
export const changeQueuePromptOrderCommandSchema = z.object({
  conversationId: z.string(),
  ids: z.array(z.string()),
});
export const cancelTurnCommandSchema = z.object({ conversationId: z.string() });
export const setModelOptionCommandSchema = z.object({
  conversationId: z.string(),
  dimension: z.enum(['model', 'effort']),
  value: z.string(),
});
export const setModeOptionCommandSchema = z.object({
  conversationId: z.string(),
  value: z.string(),
});
export const resolvePermissionCommandSchema = permissionDecisionSchema.extend({
  conversationId: z.string(),
});
export const setPromptDraftCommandSchema = z.object({
  conversationId: z.string(),
  draft: promptDraftUpdateSchema,
});
export const exportAcpTranscriptCommandSchema = z.object({ conversationId: z.string() });
export const exportRawAcpLogCommandSchema = exportAcpTranscriptCommandSchema;

export const uploadAttachmentCommandSchema = z.object({
  originalPath: z.string().optional(),
});
export const uploadAttachmentResponseSchema = attachmentRefSchema;
export const downloadAttachmentCommandSchema = z.object({ id: z.string() });
export const deleteAttachmentCommandSchema = z.object({ id: z.string() });

export { queuedPromptSchema };
