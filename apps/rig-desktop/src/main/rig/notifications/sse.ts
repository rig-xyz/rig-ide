/**
 * A minimal Server-Sent Events reader for the relay's notification stream
 * (`GET /v1/me/notifications/stream`). Main can't use the browser's
 * `EventSource` (and it couldn't send the Authorization header anyway), so
 * this reads `fetch`'s body and splits it into events itself.
 */

export type SseEvent = { event: string; data: string };

/**
 * Feeds raw text into a buffer and returns the complete events in it plus
 * the unfinished tail to keep. Events end at a blank line; `event:` and
 * `data:` fields are read, multi-line `data` is joined with "\n", comments
 * and other fields are ignored.
 */
export function parseSse(buffer: string): { events: SseEvent[]; rest: string } {
  const normalized = buffer.replace(/\r\n?/g, '\n');
  const blocks = normalized.split('\n\n');
  const rest = blocks.pop() ?? '';
  const events: SseEvent[] = [];
  for (const block of blocks) {
    let event = 'message';
    const data: string[] = [];
    for (const line of block.split('\n')) {
      if (!line || line.startsWith(':')) continue;
      const colon = line.indexOf(':');
      const field = colon === -1 ? line : line.slice(0, colon);
      const value = colon === -1 ? '' : line.slice(colon + 1).replace(/^ /, '');
      if (field === 'event') event = value;
      else if (field === 'data') data.push(value);
    }
    if (data.length > 0 || event !== 'message') events.push({ event, data: data.join('\n') });
  }
  return { events, rest };
}

/**
 * Opens the stream and calls `onEvent` for each event until the server
 * closes it, the signal aborts, or no bytes arrive for `idleTimeoutMs` (the
 * relay heartbeats every 25 s, so silence means a dead connection).
 * Resolves on a clean end; rejects with the HTTP status on a non-200.
 */
export async function readSse(
  url: string,
  token: string,
  onEvent: (e: SseEvent) => void,
  opts: { signal: AbortSignal; idleTimeoutMs: number }
): Promise<void> {
  const idle = new AbortController();
  const signal = AbortSignal.any([opts.signal, idle.signal]);
  const response = await fetch(url, {
    headers: { authorization: `Bearer ${token}`, accept: 'text/event-stream' },
    signal,
  });
  if (!response.ok || !response.body) {
    throw new SseHttpError(response.status);
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let timer = setTimeout(() => idle.abort(), opts.idleTimeoutMs);
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) return;
      clearTimeout(timer);
      timer = setTimeout(() => idle.abort(), opts.idleTimeoutMs);
      buffer += decoder.decode(value, { stream: true });
      const parsed = parseSse(buffer);
      buffer = parsed.rest;
      for (const e of parsed.events) onEvent(e);
    }
  } finally {
    clearTimeout(timer);
    await reader.cancel().catch(() => {});
  }
}

export class SseHttpError extends Error {
  constructor(readonly status: number) {
    super(`notification stream: HTTP ${status}`);
  }
}
