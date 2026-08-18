/**
 * Pure derivation for Settings → About's rig/tapd version rows: bundled vs
 * local installation, compared (Dylan's ask — the row exists to answer "do
 * my bundled and local installs conflict?", not just to name the bundle).
 *
 * "In use" is decided by the app's own shim-first resolution
 * (`ensureBundledRigBinInPath` prepends the bundled bin dir to PATH, and
 * `resolveCliBin` — the one function `auth.ts`/`join.ts`/`create.ts` all
 * spawn through — resolves the bundled shim by absolute path first):
 * bundled ALWAYS wins when present; only when nothing is bundled does the
 * local install run.
 *
 * Round: multi-install awareness. `local`'s path (`localPath`) and a
 * disagreeing-versions note (`multipleInstalls`) come straight off
 * `main/rig/bundled-cli.ts`'s `shapeLocalInstalls` — this function only
 * reshapes them into the row, it never re-derives the note itself.
 */

export type CliVersionRow = {
  kind: 'missing' | 'single' | 'equal' | 'conflict';
  /** The row's mono value, e.g. `0.10.2 · bundled = local` or `bundled 0.10.2 · local 0.9.8`. */
  label: string;
  /** `warning` only for a real conflict (both present, different versions). */
  tone: 'muted' | 'warning';
  /** Which installation the app actually runs — null only when neither exists. */
  inUse: 'bundled' | 'local' | null;
  /** The resolved local install's own path — a second mono line so a name collision or stale install is self-diagnosing. Null whenever there's no local install (bundled-only rows need no path). */
  localPath: string | null;
  /** One muted line — `"N installs found on PATH; using <path>"` — only when the PATH carries more than one distinct version. Null otherwise. */
  multipleInstallsNote: string | null;
};

export function deriveCliVersionRow(sources: {
  bundled: string | null;
  local: string | null;
  localPath?: string | null;
  multipleInstalls?: { count: number; usingPath: string } | null;
}): CliVersionRow {
  const { bundled, local } = sources;
  const localPath = local ? (sources.localPath ?? null) : null;
  const multipleInstallsNote = sources.multipleInstalls
    ? `${sources.multipleInstalls.count} installs found on PATH; using ${sources.multipleInstalls.usingPath}`
    : null;

  if (bundled && local) {
    if (bundled === local) {
      return {
        kind: 'equal',
        label: `${bundled} · bundled = local`,
        tone: 'muted',
        inUse: 'bundled',
        localPath,
        multipleInstallsNote,
      };
    }
    return {
      kind: 'conflict',
      label: `bundled ${bundled} · local ${local}`,
      tone: 'warning',
      inUse: 'bundled',
      localPath,
      multipleInstallsNote,
    };
  }
  if (bundled) {
    return {
      kind: 'single',
      label: `${bundled} · bundled`,
      tone: 'muted',
      inUse: 'bundled',
      localPath: null,
      multipleInstallsNote,
    };
  }
  if (local) {
    return {
      kind: 'single',
      label: `${local} · local`,
      tone: 'muted',
      inUse: 'local',
      localPath,
      multipleInstallsNote,
    };
  }
  return {
    kind: 'missing',
    label: 'not found',
    tone: 'muted',
    inUse: null,
    localPath: null,
    multipleInstallsNote,
  };
}
