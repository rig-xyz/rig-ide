/**
 * Expanded/collapsed state for a space panel's disclosure sections (Agents,
 * Connectors), remembered per space on this computer — same `rig-room-*`
 * key convention as the composer's draft and the transcript's last-seen
 * marker, wrapped in try/catch since storage isn't guaranteed to exist.
 */

export type PanelSectionId = 'agents' | 'connectors';

const PREFIX = 'rig-room-panel-section:';

function storageKey(bindingId: string, section: PanelSectionId): string {
  return `${PREFIX}${section}:${bindingId}`;
}

/** `null` means no preference is stored yet — the caller picks its own default. */
export function readPanelSectionExpanded(bindingId: string, section: PanelSectionId): boolean | null {
  try {
    const raw = localStorage.getItem(storageKey(bindingId, section));
    return raw === null ? null : raw === 'true';
  } catch {
    return null;
  }
}

export function writePanelSectionExpanded(bindingId: string, section: PanelSectionId, expanded: boolean): void {
  try {
    localStorage.setItem(storageKey(bindingId, section), String(expanded));
  } catch {
    // Storage unavailable — the preference just won't persist.
  }
}
