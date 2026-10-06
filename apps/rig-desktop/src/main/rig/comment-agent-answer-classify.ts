/**
 * Classifies a headless comment-agent turn's raw answer text as either a
 * genuine reply or a provider failure that leaked through AS assistant
 * text and would otherwise be posted to the thread verbatim.
 *
 * Root cause: the codex ACP adapter has no separate error channel for a
 * provider's hard failure. It prints `Warning: ...` diagnostic lines and
 * then the raw JSON error body as plain assistant TEXT, so `readAnswer`
 * (`comment-agent.ts`) would post the whole blob as the reply, warnings
 * and all. The most common such failure is a Codex CLI too old for the
 * model it was asked to run: the provider answers with a 400 saying the
 * model "requires a newer version of Codex", or, from the ChatGPT backend,
 * that it "is not supported when using Codex with a ChatGPT account". The
 * adapter runs the host's own codex (`CODEX_PATH`, see the Codex plugin),
 * so updating that CLI is the fix.
 *
 * Pure string work — no ACP, no I/O — the same "no I/O, just text" shape
 * `comment-agent-proposal.ts` already is, and unit-testable the same way.
 */

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
 * What the ChatGPT backend says when an old Codex CLI asks for a current
 * model (seen with codex 0.147.0 and gpt-6.1-sol, latest was 0.160.1): the
 * wording blames the account, but updating Codex is the fix.
 */
const NOT_SUPPORTED_WITH_CHATGPT = /model is not supported when using codex with a chatgpt account/i;

function isTooOldForModel(text: string): boolean {
  return REQUIRES_NEWER_CODEX.test(text) || NOT_SUPPORTED_WITH_CHATGPT.test(text);
}

/** The plain explanation for a Codex too old for the model it was asked to run. */
function codexTooOldMessage(modelName: string | null, installedVersion: string | null | undefined): string {
  const version = installedVersion ? ` You have Codex ${installedVersion}.` : '';
  return `Codex on this Mac is too old for ${modelName ?? 'this model'}.${version} Update it in Settings › Agents, then try again.`;
}

/**
 * Best-effort pull of the offending model id out of the surrounding
 * prose/JSON message — cosmetic only; a miss just falls back to generic
 * phrasing. Prefers an explicit `"model": "..."` JSON field; otherwise
 * takes the quoted/backticked token CLOSEST to (i.e. immediately before)
 * the "requires a newer version of Codex" (or "is not supported when using
 * Codex with a ChatGPT account") phrase itself, rather than the
 * first quoted token anywhere in the text — a raw JSON error payload has
 * several earlier quoted keys (`"type"`, `"error"`, `"message"`) that
 * would otherwise win a naive first-match search.
 */
function extractModelName(text: string): string | null {
  const modelField = /"model"\s*:\s*"([^"]+)"/i.exec(text);
  if (modelField) return modelField[1]!;
  const phrase = REQUIRES_NEWER_CODEX.exec(text) ?? NOT_SUPPORTED_WITH_CHATGPT.exec(text);
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
export function classifyProviderAnswer(
  raw: string,
  /** The resolved Codex CLI's version, named in the too-old explanation when known. */
  opts: { codexVersion?: string | null } = {}
): ProviderAnswerClassification {
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
    isTooOldForModel(trimmed) || (errorPayload !== null && isTooOldForModel(errorPayload.message));

  if (modelUnsupported) {
    const modelName = extractModelName(trimmed) ?? (errorPayload ? extractModelName(errorPayload.message) : null);
    return {
      kind: 'failure',
      reason: 'model-unsupported',
      message: codexTooOldMessage(modelName, opts.codexVersion),
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
