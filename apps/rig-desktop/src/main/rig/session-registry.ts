import type { AcpStartInputWire } from '@emdash/core/acp';

/**
 * Main-process record of ACP session-start inputs, captured at the runtime-host
 * choke point (every startSession/resumeSession flows through main on its way
 * to the ACP runtime worker). The rig intent bridge reads `cwd`/`providerId`
 * from here — the worker-side session state exposed over the wire does not
 * carry the session working directory.
 *
 * This module is intentionally dependency-free so the runtime host can import
 * it without creating an import cycle with the bridge.
 */

const sessionStarts = new Map<string, AcpStartInputWire>();

type SessionWatcher = {
  started: (input: AcpStartInputWire) => void;
  ended: (conversationId: string) => void;
};
const watchers = new Set<SessionWatcher>();

/** Told of every session start (or resume) and of each one the bridge sees end. Returns how to stop. */
export function watchAcpSessions(watcher: SessionWatcher): () => void {
  watchers.add(watcher);
  return () => watchers.delete(watcher);
}

export function noteAcpSessionStart(input: AcpStartInputWire): void {
  // Connector servers carry login tokens; nothing here needs them.
  const { mcpServers: _mcpServers, ...rest } = input;
  sessionStarts.set(input.conversationId, rest);
  for (const watcher of watchers) watcher.started(rest);
}

export function getAcpSessionStart(conversationId: string): AcpStartInputWire | undefined {
  return sessionStarts.get(conversationId);
}

export function clearAcpSessionStart(conversationId: string): void {
  sessionStarts.delete(conversationId);
  for (const watcher of watchers) watcher.ended(conversationId);
}
