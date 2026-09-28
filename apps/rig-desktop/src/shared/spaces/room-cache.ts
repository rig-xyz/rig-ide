import z from 'zod';

/**
 * The on-disk Room cache's blob (rig/docs/room-disk-cache-spec.md): one per
 * (account, space). The renderer builds it from a live Room and restores a
 * Room from it; main validates it on the way in and out
 * (`main/rig/room-cache-store.ts`).
 *
 * Privacy is part of the shape: a finished run is kept only as the fields
 * that survive "Hide details" (`summary`), and `runSummarySchema` is a plain
 * `z.object`, so any other key — steps, thinking, tool output — is stripped
 * before anything is written. A run that was still going is kept as its
 * header only (`live`), and fetched in full when the Room opens.
 */

/** Bumped when the shape changes; a row of another version is dropped (a cold open), never upgraded. */
export const ROOM_CACHE_FORMAT_VERSION = 1;
/** Per space, after the renderer trims (oldest messages first, then answers). */
export const ROOM_CACHE_MAX_BYTES = 512 * 1024;
/** Spaces kept on disk in total; the least recently opened go first. */
export const ROOM_CACHE_MAX_SPACES = 24;

export const runSummarySchema = z.object({
  answer: z.string(),
  status: z.string(),
  model: z.string().nullable(),
  stepCount: z.number(),
  failureReason: z.string().nullable(),
  privacy: z.string().nullable(),
  detailsHidden: z.boolean(),
  lastSeq: z.number(),
});
export type RunSummary = z.infer<typeof runSummarySchema>;

const runMetaSchema = z.object({
  id: z.string(),
  agent: z.enum(['claude', 'codex']),
  owner: z.string(),
  model: z.string(),
  title: z.string(),
  status: z.enum(['running', 'waiting', 'done', 'stopped', 'failed']),
  startedAt: z.string(),
  endedAt: z.string().nullable(),
});

export const cachedRoomSchema = z.object({
  v: z.literal(ROOM_CACHE_FORMAT_VERSION),
  /** Set by main from the relay it's signed in to; another relay's blob is never served. */
  relayHost: z.string(),
  savedAt: z.number(),
  lastMessageSeq: z.number(),
  // The Room's own shapes (renderer `types.ts`), checked for what a restore relies on.
  messages: z.array(
    z.looseObject({
      id: z.string(),
      seq: z.number(),
      authorId: z.string(),
      createdAt: z.string(),
      meta: z.looseObject({ kind: z.string() }),
    })
  ),
  members: z.array(z.looseObject({ id: z.string() })),
  invitesById: z.record(z.string(), z.looseObject({ id: z.string() })),
  connectors: z.array(z.looseObject({ id: z.string(), name: z.string() })),
  skills: z.array(z.looseObject({ cmd: z.string() })),
  runs: z.record(
    z.string(),
    z.object({
      meta: runMetaSchema,
      summary: runSummarySchema.optional(),
      live: z.literal(true).optional(),
    })
  ),
});
export type CachedRoomBlob = z.infer<typeof cachedRoomSchema>;
