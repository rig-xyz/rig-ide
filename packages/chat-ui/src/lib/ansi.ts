/**
 * ANSI escape-sequence stripping — the OUTPUT RENDER path only (design-system
 * Rule 9's hierarchy: raw bytes stay untouched in the data/persistence
 * layer — `ChatExecute.outputText`, `rig_session_events` — this function is
 * applied only where output is turned into display lines, e.g.
 * `execute.def.tsx`'s `outputLines`/`lastOutputLine`).
 *
 * Round E bug: tool output showed literal `(B` / `[m` "husks" — the ESC
 * (0x1B) byte itself has no glyph and renders as nothing in a browser, so a
 * charset-designation sequence (`ESC ( B` — "select ASCII as G0") or an SGR
 * reset (`ESC [ m`) reads as garbage leftover text once its invisible ESC
 * prefix disappears from view, even though the ESC byte is still really
 * there in the string. v1 here is stripping, not color rendering — SGR's
 * color/style codes are simply discarded along with everything else.
 * Converting them into styled spans is real, flagged future work (would
 * need either a small ANSI-to-HTML dep or a bespoke tokenizer — not
 * trivial with anything already in this repo, so not built now).
 */

// Matched in priority order — OSC first, since its payload can otherwise
// confuse CSI matching; each alternative anchors on the ESC (0x1B) byte,
// which is genuinely present in the string (see the header comment above).
const ANSI_PATTERN = new RegExp(
  [
    // OSC: ESC ] ... terminated by BEL (0x07) or ST (ESC \). Also accepts a
    // bare BEL-terminated form some tools emit without touching future ESC.
    '\\x1B\\][^\\x07\\x1B]*(?:\\x07|\\x1B\\\\)',
    // CSI: ESC [ params(0-9;:<=>?) intermediate( -/) final(@-~) — covers
    // SGR (color/style, final byte 'm'), cursor movement, and private modes
    // (leading '?', e.g. `\x1B[?25l` to hide the cursor).
    '\\x1B\\[[0-9;:<=>?]*[ -/]*[@-~]',
    // Charset designation: ESC ( / ) / * / + / - / . / /  + one byte — the
    // exact family of the reported `ESC(B` husk.
    "\\x1B[()*+\\-./][0-9A-Za-z]",
    // Remaining common single-byte Fp/Fe/Fs escapes with no parameters —
    // reset (c), index/next-line (D/E/M), save/restore cursor (7/8),
    // keypad mode (=/>).
    '\\x1B[c78DEM=>]',
  ].join('|'),
  'g'
);

/** Strips every recognized ANSI escape sequence, leaving the rest of the text untouched. */
export function stripAnsi(text: string): string {
  return text.replace(ANSI_PATTERN, '');
}
