/**
 * Local, bounded alignment between a leaf's RENDERED text and its own
 * source slice — the "small deterministic local alignment" called for by
 * docs/preview-mode-spec.md ("The core mechanism: the position index").
 *
 * Never a whole-document search: every caller already knows the exact
 * source span a leaf came from (`markdown-position-components.tsx` stamps
 * it from mdast/hast positions), so this only ever has to explain the
 * character-level differences WITHIN that span — markdown backslash
 * escapes (`\~` → `~`) and character references (`&amp;` → `&`). Anything
 * else is treated as unexplained and alignment simply stops there rather
 * than guess; the caller marks the remainder unmapped.
 *
 * Fenced/inline code get their own entry points here (`alignFencedCode`,
 * `alignInlineCode`) because code content is literal — no escapes, no
 * entities — but the source slice carries fence/backtick syntax the
 * rendered text never does, which needs stripping first.
 */

/** A single point where `dom` (rendered-text offset) and `src` (absolute
 * source offset) are known to agree; the mapping between two consecutive
 * breakpoints is always affine 1:1 (same length on both sides). */
export type Breakpoint = { dom: number; src: number };

export type AlignResult = {
  breakpoints: Breakpoint[];
  /** How much of `rendered` (from the start) was successfully aligned. */
  matchedLen: number;
};

// CommonMark's ASCII punctuation ranges — the only characters a backslash
// escape may precede.
const ASCII_PUNCT = /[!-/:-@[-`{-~]/;

// A conservative subset of HTML5 named character references, plus numeric
// (`&#39;`) and hex (`&#x27;`) references, which cover the common cases in
// hand-written markdown. Unlisted named references fail to match and the
// alignment stops there rather than guess at a decoding.
const NAMED_ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
  hellip: '…',
  mdash: '—',
  ndash: '–',
  lsquo: '‘',
  rsquo: '’',
  ldquo: '“',
  rdquo: '”',
  copy: '©',
  reg: '®',
  trade: '™',
};

function matchEntity(slice: string, at: number): { raw: string; decoded: string } | null {
  if (slice[at] !== '&') return null;
  const m = /^&(#x[0-9a-fA-F]+|#[0-9]+|[a-zA-Z][a-zA-Z0-9]*);/.exec(slice.slice(at));
  if (!m) return null;
  const body = m[1]!;
  let decoded: string | null = null;
  if (body[0] === '#') {
    const isHex = body[1] === 'x' || body[1] === 'X';
    const codePoint = isHex ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10);
    if (Number.isFinite(codePoint) && codePoint > 0 && codePoint <= 0x10ffff) {
      try {
        decoded = String.fromCodePoint(codePoint);
      } catch {
        decoded = null;
      }
    }
  } else {
    decoded = NAMED_ENTITIES[body] ?? null;
  }
  return decoded === null ? null : { raw: m[0], decoded };
}

/**
 * Align `rendered` (a leaf's concatenated text content) against `slice`
 * (the leaf's own source text, starting at absolute offset `sliceStart`),
 * explaining divergences via backslash escapes and character references.
 *
 * `dom` in the returned breakpoints is always 0-based into `rendered`
 * (never into an individual DOM text node — callers split that up);
 * `src` is always an absolute offset into the full source string.
 */
export function alignEscaped(rendered: string, slice: string, sliceStart: number): AlignResult {
  let i = 0; // index into rendered
  let j = 0; // index into slice
  const breakpoints: Breakpoint[] = [{ dom: 0, src: sliceStart }];
  const pushBreak = () => breakpoints.push({ dom: i, src: sliceStart + j });

  while (i < rendered.length && j < slice.length) {
    // Escape/entity patterns are checked BEFORE the literal fast path, not
    // just as a fallback on mismatch: `&amp;`'s leading `&` and a literal
    // `&` in rendered text can coincide, and greedily literal-matching
    // that one character first would desync the rest of the entity.
    if (
      slice[j] === '\\' &&
      j + 1 < slice.length &&
      ASCII_PUNCT.test(slice[j + 1]!) &&
      rendered[i] === slice[j + 1]
    ) {
      i += 1;
      j += 2;
      pushBreak();
      continue;
    }

    const entity = matchEntity(slice, j);
    if (entity && rendered.startsWith(entity.decoded, i)) {
      i += entity.decoded.length;
      j += entity.raw.length;
      pushBreak();
      continue;
    }

    if (rendered[i] === slice[j]) {
      i++;
      j++;
      continue;
    }

    // A blockquote continuation line's `> ` prefix: mdast joins a
    // multi-line blockquote paragraph's lines with a plain "\n" (the `>`
    // already stripped from every line but the position's own start), but
    // that's rendered text — the SOURCE slice between the two lines still
    // has the raw "> " sitting right there, because slicing raw text
    // can't skip over structural characters the way parsing did. Only
    // tried right after a newline both sides just matched (`j > 0` guards
    // the initial iteration): recognizing a bare ">" anywhere else would
    // risk swallowing one that's genuinely part of the text.
    if (j > 0 && slice[j - 1] === '\n' && slice[j] === '>' && rendered[i] !== '>') {
      j += 1;
      if (slice[j] === ' ') j += 1;
      pushBreak();
      continue;
    }

    break; // Unexplained divergence — stop; the caller treats the rest as unmapped.
  }

  return { breakpoints, matchedLen: i };
}

/**
 * Locate a fenced code block's content within its full source slice
 * (opening fence line through closing fence line, exactly the mdast
 * `code` node's position). Returns offsets RELATIVE to `slice`.
 *
 * Returns `null` for anything that isn't a recognizable fence (e.g. an
 * indented code block, which has no fence line at all) — callers leave
 * such blocks unmapped rather than guess.
 */
export function parseFence(slice: string): { innerStartRel: number; innerEndRel: number } | null {
  const open = /^(`{3,}|~{3,})[^\n]*\n/.exec(slice);
  if (!open) return null;
  const fenceChar = open[1]![0];
  const fenceLen = open[1]!.length;
  const innerStartRel = open[0].length;
  const closeRe = new RegExp(`\\n${fenceChar}{${fenceLen},}[ \\t]*$`);
  const closeMatch = closeRe.exec(slice);
  const innerEndRel = closeMatch ? closeMatch.index : slice.length;
  return { innerStartRel, innerEndRel: Math.max(innerStartRel, innerEndRel) };
}

/**
 * Locate an inline code span's content within its full source slice
 * (opening backtick run through closing backtick run), applying
 * CommonMark's single-space-padding trim (a code span whose content both
 * starts and ends with a space, and isn't ALL spaces, has one space
 * stripped from each end). Offsets are relative to `slice`.
 */
export function parseInlineCodeFence(
  slice: string
): { innerStartRel: number; innerEndRel: number } | null {
  const m = /^`+/.exec(slice);
  if (!m) return null;
  const n = m[0].length;
  if (slice.length < n * 2 || !slice.endsWith('`'.repeat(n))) return null;
  let innerStartRel = n;
  let innerEndRel = slice.length - n;
  if (innerEndRel - innerStartRel >= 2) {
    const inner = slice.slice(innerStartRel, innerEndRel);
    if (inner[0] === ' ' && inner[inner.length - 1] === ' ' && inner.trim() !== '') {
      innerStartRel += 1;
      innerEndRel -= 1;
    }
  }
  return { innerStartRel, innerEndRel };
}

/**
 * Strip a leaf element's own LEADING marker syntax from its full
 * [start,end) source slice, leaving a range that starts where its
 * rendered text starts. `markdown-position-components.tsx` stamps every
 * element's OWN mdast/hast span (markers included — see that file for
 * why), and `alignEscaped` explains a rendered character against a source
 * character one at a time starting from position 0 — an unstripped
 * leading marker (`**`, `#`, `- `, `[`, a table cell's `| `, and so on) would
 * mismatch on the very first character and the whole leaf would align as
 * nothing.
 *
 * TRAILING markers are deliberately NOT stripped here, and this isn't an
 * oversight: `alignEscaped` stops the moment it has explained every
 * character of `rendered` — it never reads past `rendered.length`, so
 * whatever sits after the real content in `slice` (closing `**`, `](url)`,
 * a table cell's trailing `| `, a setext heading's `\n===`) is simply
 * unused slack, not a source of error. Left unstripped, that slack is also
 * exactly what makes `# text` and `text\n===` (ATX vs. setext — no leading
 * marker to strip in the latter case) both fall out of the SAME code path
 * for free. `code` is the one tag that doesn't get this benefit (see
 * `parseFence`/`parseInlineCodeFence`): its check is `rendered.startsWith`
 * on a required EXACT slice, not a tolerant character-by-character scan,
 * so it still needs a precise trailing bound and never reaches here.
 */
export function contentSlice(
  tagName: string,
  slice: string
): { innerStartRel: number; innerEndRel: number } {
  switch (tagName) {
    case 'STRONG':
      return leading(slice, 2); // `**text` / `__text`
    case 'EM':
      return leading(slice, 1); // `*text` / `_text`
    case 'DEL':
      return leading(slice, 2); // `~~text` — GFM strikethrough is always double-tilde.
    case 'A':
      return stripLinkOpener(slice); // `[text...` or an autolink's `<text...`
    case 'LI':
      return stripListItemMarker(slice); // `- text`, `12. text`, `- [x] text`
    case 'TD':
    case 'TH':
      return stripTableCellPipe(slice); // GFM cell positions include their own leading `| `.
    case 'H1':
    case 'H2':
    case 'H3':
    case 'H4':
    case 'H5':
    case 'H6':
      return leading(slice, /^#{1,6}(?:[ \t]+|$)/); // ATX only — setext has no leading marker at all.
    default:
      return { innerStartRel: 0, innerEndRel: slice.length };
  }
}

/** Skip `n` fixed chars, or whatever a regex matches at the start — safe either way,
 * since this is the node's OWN span: it is structurally guaranteed to start with its marker. */
function leading(
  slice: string,
  marker: number | RegExp
): { innerStartRel: number; innerEndRel: number } {
  const width =
    typeof marker === 'number'
      ? Math.min(marker, slice.length)
      : (marker.exec(slice)?.[0].length ?? 0);
  return { innerStartRel: width, innerEndRel: slice.length };
}

/** `- `, `* `, `+ `, or `1.`/`1)` (1-9 digits), plus an optional GFM task checkbox. */
function stripListItemMarker(slice: string): { innerStartRel: number; innerEndRel: number } {
  return leading(slice, /^(?:[-*+]|\d{1,9}[.)])[ \t]+(?:\[[ xX]\][ \t]+)?/);
}

/** A GFM table cell's mdast position includes its own leading `|` and padding. */
function stripTableCellPipe(slice: string): { innerStartRel: number; innerEndRel: number } {
  return leading(slice, /^\|[ \t]*/);
}

/** `[text...` (inline/reference/shortcut link) or `<text...` (autolink) — either way, one leading char. */
function stripLinkOpener(slice: string): { innerStartRel: number; innerEndRel: number } {
  return slice.startsWith('[') || slice.startsWith('<')
    ? { innerStartRel: 1, innerEndRel: slice.length }
    : { innerStartRel: 0, innerEndRel: slice.length };
}
