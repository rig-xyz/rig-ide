/**
 * Pure derivation for the import entry field (both the create dialog's
 * "Start from a Google Doc" card and the open-rig Import dialog): which
 * source mode is active, what the user has provided, and whether it's
 * usable.
 *
 * `mode` is an explicit choice between two tiles (design round — the two
 * affordances read as a visible either/or, not a field with a footnote):
 * `'link'` derives from the URL box (erroring only once something
 * non-empty was typed), `'docx'` from the picked file. Switching modes
 * never destroys the other mode's entry — the derivation just ignores it.
 */

import { parseGoogleDocId, type RigImportSource } from '@shared/rig/import-doc';

export type ImportSourceMode = 'link' | 'docx';

export type ImportSourceInput = {
  mode: ImportSourceMode;
  url: string;
  filePath: string | null;
};

export const EMPTY_IMPORT_SOURCE: ImportSourceInput = { mode: 'link', url: '', filePath: null };

export type ImportSourceState = {
  source: RigImportSource | null;
  urlError: string | null;
};

export function deriveImportSource(input: ImportSourceInput): ImportSourceState {
  if (input.mode === 'docx') {
    return {
      source: input.filePath ? { kind: 'file', path: input.filePath } : null,
      urlError: null,
    };
  }
  const trimmed = input.url.trim();
  if (!trimmed) return { source: null, urlError: null };
  if (parseGoogleDocId(trimmed) === null) {
    return { source: null, urlError: "That doesn't look like a Google Docs link." };
  }
  return { source: { kind: 'url', url: trimmed }, urlError: null };
}

/** What the working state can honestly call the doc: the picked file's name now, the link's title only after the fetch. */
export function importWorkingLabel(input: ImportSourceInput): string {
  if (input.mode === 'docx' && input.filePath) {
    const base = input.filePath.split('/').pop();
    if (base) return base;
  }
  return 'your Google Doc';
}
