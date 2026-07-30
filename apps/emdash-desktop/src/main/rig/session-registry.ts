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

export function noteAcpSessionStart(input: AcpStartInputWire): void {
  sessionStarts.set(input.conversationId, input);
}

export function getAcpSessionStart(conversationId: string): AcpStartInputWire | undefined {
  return sessionStarts.get(conversationId);
}

export function clearAcpSessionStart(conversationId: string): void {
  sessionStarts.delete(conversationId);
}
