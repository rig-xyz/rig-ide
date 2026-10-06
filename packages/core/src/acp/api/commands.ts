import { z } from 'zod';
import { attachmentRefSchema } from '../models/attachments';
import { permissionDecisionSchema } from '../models/permissions';
import { promptDraftUpdateSchema, promptInputSchema, queuedPromptSchema } from '../models/prompt';

const acpNameValueSchema = z.object({ name: z.string(), value: z.string() });

/**
 * A remote MCP server handed to the agent for this one session (ACP
 * `mcpServers` on `session/new` / `session/load`). Headers may carry a bearer
 * token: this input lives in memory only and must never be logged or
 * persisted. Remote (http) only, on purpose: session starts can come from
 * the renderer, and a stdio server would let that caller spawn any command.
 */
export const acpMcpServerSchema = z.object({
  type: z.literal('http'),
  name: z.string(),
  url: z.string().url(),
  headers: z.array(acpNameValueSchema),
});
export type AcpMcpServerWire = z.infer<typeof acpMcpServerSchema>;

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
   * Claude only: text appended to Claude Code's own system prompt (the
   * adapter's `_meta.systemPrompt.append`), never replacing it. A space
   * session uses it for the folder's AGENTS.md, which Claude Code skips when
   * there's also a CLAUDE.md.
   */
  systemPromptAppend: z.string().max(64_000).optional(),
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
