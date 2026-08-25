/**
 * A targeted, line-level edit of `rig.toml`'s `[rig].name` field — NOT a
 * parse/re-serialize round trip. Investigated (Rename round): this codebase
 * only ever READS `rig.toml` (`workspace.ts`'s `readRigName`, via
 * `smol-toml`'s `parse`); no toml-preserving writer exists anywhere, and
 * `smol-toml`'s own `stringify` works from a plain parsed object, so it
 * would silently drop every comment and reflow every field — unacceptable
 * for a file real people (and every other tapd-synced member) hand-edit and
 * read directly. This function instead finds the `name = ...` line inside
 * the `[rig]` table by scanning lines, and rewrites ONLY that line's value
 * — every other byte of the file (comments, blank lines, field order, other
 * tables) survives untouched.
 */

const TABLE_HEADER = /^\s*\[([^[\].]+)\]\s*(?:#.*)?$/;
/** A bare `name = <value>` key at the top level of whatever table it's in — `<value>` and any trailing inline comment are captured separately so both can be preserved/replaced independently. */
const NAME_LINE = /^(\s*name\s*=\s*)("(?:[^"\\]|\\.)*"|'[^']*'|\S+)(.*)$/;

/** Control/escape characters a TOML basic string must not contain literally — backslash and double-quote (always) plus every C0 control code. */
// eslint-disable-next-line no-control-regex
const NEEDS_ESCAPE = /[\\"\u0000-\u001f]/g;

/** Wraps `value` as a TOML basic string, escaping backslashes/quotes/control characters — the minimal quoting a plain display name needs (no multi-line or literal-string cases to support here). */
function toTomlString(value: string): string {
  const escaped = value.replace(NEEDS_ESCAPE, (ch) => {
    if (ch === '\\') return '\\\\';
    if (ch === '"') return '\\"';
    if (ch === '\n') return '\\n';
    if (ch === '\t') return '\\t';
    if (ch === '\r') return '\\r';
    return `\\u${ch.charCodeAt(0).toString(16).padStart(4, '0')}`;
  });
  return `"${escaped}"`;
}

/**
 * Rewrites the `[rig]` table's `name` value in `raw` to `newName`, keeping
 * every other line byte-identical (including the replaced line's own
 * leading whitespace and any trailing inline comment). Returns `null` when
 * no `name` line exists inside a `[rig]` table — the caller treats that as
 * a real error rather than silently appending one, since a malformed/
 * unexpected `rig.toml` is exactly the case a line-level edit must refuse
 * to guess at.
 */
export function setTomlRigName(raw: string, newName: string): string | null {
  const lines = raw.split('\n');
  let inRigTable = false;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const header = TABLE_HEADER.exec(line);
    if (header) {
      inRigTable = header[1] === 'rig';
      continue;
    }
    if (!inRigTable) continue;
    const match = NAME_LINE.exec(line);
    if (!match) continue;
    const [, prefix, , suffix] = match;
    lines[i] = `${prefix}${toTomlString(newName)}${suffix}`;
    return lines.join('\n');
  }
  return null;
}
