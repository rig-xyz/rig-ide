/**
 * Classifies a headless comment-agent turn's raw answer text as either a
 * genuine reply or a provider failure that leaked through AS assistant
 * text and would otherwise be posted to the thread verbatim.
 *
 * Root cause (verified against the paintbrush v1 punch list): this app
 * bundles `@agentclientprotocol/codex-acp@1.0.2` (pnpm-patched — see
 * `patches/@agentclientprotocol__codex-acp@1.0.2.patch`), which pins its
 * own `@openai/codex@0.142.4`, independent of whatever `codex` the user
 * has on `PATH`. That bundled binary still reads the user's global
 * `~/.codex/config.toml` — including its `model` entry — so a config
 * pointing at a model only a NEWER Codex understands (the report's
 * repro: `gpt-6-astra`, fine on the user's PATH codex 0.147.0) gets
 * rejected by the provider with a 400 whose body says "requires a newer
 * version of Codex". The codex ACP adapter has no separate error channel
 * for this: it prints `Warning: ...` diagnostic lines and then the raw
 * JSON error body as plain assistant TEXT, so `readAnswer`
 * (`comment-agent.ts`) posts the whole blob as the reply, warnings and
 * all. `npm view @agentclientprotocol/codex-acp versions`/`@latest
 * dependencies` shows 1.1.14 is the first published version pinning
 * `@openai/codex@^0.147.0` (current `latest`, 1.10.0, pins ^0.153.3) —
 * bumping past the patched 1.0.2 would fix this at the source, but needs
 * the pnpm patch revalidated against the new version first, so this
 * module only degrades the SYMPTOM gracefully in the meantime; see the
 * build report for the full version list.
 *
 * Pure string work — no ACP, no I/O — the same "no I/O, just text" shape
 * `comment-agent-proposal.ts` already is, and unit-testable the same way.
 */

/** The Codex version this app currently bundles via the pinned, patched `codex-acp`. */
const BUNDLED_CODEX_VERSION = '0.142.4';

const WARNING_LINE = /^warning:/i;

/**
 * Splits off LEADING `Warning: ...` lines (and the blank lines between
 * them) — the codex adapter's own diagnostic chatter, never something a
 * reader should see in a comment thread. Only lines that are part of that
 * leading run are touched; a `Warning:`-looking line appearing later, in
 * the middle of genuine prose, is left alone (nothing walks the answer
 * looking for it there). Untouched entirely (both `rest === text` and an
 * empty `warnings` list) when the FIRST line isn't itself a warning — a
 * normal answer that happens to start with a blank line is not "improved"
 * by this.
 */
function stripLeadingWarnings(text: string): { rest: string; warnings: string[] } {
  const lines = text.split('\n');
  const warnings: string[] = [];
  let i = 0;
  while (i < lines.length) {
    const trimmedLine = lines[i]!.trim();
    if (WARNING_LINE.test(trimmedLine)) {
      warnings.push(trimmedLine);
      i++;
      continue;
    }
    // A blank line only counts as "inside the leading run" once at least
    // one warning has actually been seen — otherwise this would eat a
    // genuine answer's own leading blank line for free.
    if (trimmedLine === '' && warnings.length > 0) {
      i++;
      continue;
    }
    break;
  }
  return { rest: lines.slice(i).join('\n'), warnings };
}

/** A JSON object embedded in `text` that looks like a provider error payload — not just any JSON. */
function extractErrorPayload(text: string): { message: string } | null {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start === -1 || end === -1 || end <= start) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(text.slice(start, end + 1));
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null) return null;
  const obj = parsed as Record<string, unknown>;
  const nested =
    typeof obj.error === 'object' && obj.error !== null ? (obj.error as Record<string, unknown>) : null;
  // Deliberately narrow: an object merely CONTAINING a `message` string
  // (a normal answer quoting some config or log snippet) is not enough —
  // only `type: "error"` or a nested `error` object counts as the shape
  // an ACP provider actually emits for a hard failure.
  if (obj.type !== 'error' && !nested) return null;
  const source = nested ?? obj;
  const message = typeof source.message === 'string' ? source.message : JSON.stringify(parsed);
  return { message };
}

const REQUIRES_NEWER_CODEX = /requires a newer version of codex/i;

/**
 * Best-effort pull of the offending model id out of the surrounding
 * prose/JSON message — cosmetic only; a miss just falls back to generic
 * phrasing. Prefers an explicit `"model": "..."` JSON field; otherwise
 * takes the quoted/backticked token CLOSEST to (i.e. immediately before)
 * the "requires a newer version of Codex" phrase itself, rather than the
 * first quoted token anywhere in the text — a raw JSON error payload has
 * several earlier quoted keys (`"type"`, `"error"`, `"message"`) that
 * would otherwise win a naive first-match search.
 */
function extractModelName(text: string): string | null {
  const modelField = /"model"\s*:\s*"([^"]+)"/i.exec(text);
  if (modelField) return modelField[1]!;
  const phrase = REQUIRES_NEWER_CODEX.exec(text);
  if (!phrase) return null;
  const before = text.slice(0, phrase.index);
  const quoted = [...before.matchAll(/[`"']([a-zA-Z0-9_.\-/]+)[`"']/g)];
  return quoted.length > 0 ? quoted[quoted.length - 1]![1]! : null;
}

export type ProviderAnswerFailureReason = 'model-unsupported' | 'error-payload' | 'warnings-only';

export type ProviderAnswerClassification =
  | { kind: 'ok'; text: string; strippedWarnings: string[] }
  | {
      kind: 'failure';
      reason: ProviderAnswerFailureReason;
      /** Clean, human-facing explanation — safe to post as the reply body verbatim. */
      message: string;
      strippedWarnings: string[];
    };

/**
 * Classify one raw ACP transcript answer. Never throws — malformed or
 * ambiguous input just falls through to `kind: 'ok'` with the original
 * text (minus any leading warnings), the same "never reject, just fail
 * to find something" posture `extractProposal` takes.
 */
export function classifyProviderAnswer(raw: string): ProviderAnswerClassification {
  const { rest, warnings } = stripLeadingWarnings(raw);
  const trimmed = rest.trim();

  if (trimmed.length === 0) {
    if (warnings.length === 0) return { kind: 'ok', text: rest, strippedWarnings: [] };
    return {
      kind: 'failure',
      reason: 'warnings-only',
      message:
        "The agent didn't produce an answer for this stroke — it only printed warnings before stopping. Try again, or switch agents for this stroke.",
      strippedWarnings: warnings,
    };
  }

  const errorPayload = extractErrorPayload(trimmed);
  const modelUnsupported =
    REQUIRES_NEWER_CODEX.test(trimmed) ||
    (errorPayload !== null && REQUIRES_NEWER_CODEX.test(errorPayload.message));

  if (modelUnsupported) {
    const modelName = extractModelName(trimmed) ?? (errorPayload ? extractModelName(errorPayload.message) : null);
    const modelClause = modelName ? `selects \`${modelName}\`, which` : 'selects a model that';
    return {
      kind: 'failure',
      reason: 'model-unsupported',
      message:
        `Codex couldn't run this stroke: your Codex config ${modelClause} the Codex bundled with rig ` +
        `(${BUNDLED_CODEX_VERSION}) doesn't support yet. Pick a supported model in ~/.codex/config.toml, ` +
        'or use a different agent for this stroke.',
      strippedWarnings: warnings,
    };
  }

  if (errorPayload) {
    return {
      kind: 'failure',
      reason: 'error-payload',
      message: `The agent reported an error instead of answering: ${errorPayload.message}`,
      strippedWarnings: warnings,
    };
  }

  return { kind: 'ok', text: rest, strippedWarnings: warnings };
}
