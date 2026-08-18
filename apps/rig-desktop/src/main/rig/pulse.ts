import { err, ok, type Result } from '@emdash/shared';
import { log } from '@main/lib/logger';
import { createRPCController } from '@shared/lib/ipc/rpc';
import type {
  RigAskAnswer,
  RigAskSource,
  RigPulseBriefing,
  RigPulseError,
  RigPulsePerPerson,
  RigPulsePerRig,
  RigPulsePickBackUp,
} from '@shared/rig/pulse';
import { resolveRelayUrl } from './account';
import { readRelayToken } from './config';
import { checkRelayTrust } from './relay-trust';

/**
 * Round H3 — pulse parity: the relay's read-plane intelligence
 * (`tap/docs/pulse-spec.md`), the same feed the web home is built on.
 * `GET /v1/me/pulse` — a semantic cross-fabric briefing, cached server-side
 * per user (`pulse_cache`, ~3h TTL or `?refresh=1`). `POST /v1/me/ask` —
 * grounded cross-fabric Q&A. Both account-scoped (no workspace involved in
 * resolving them), same trust-gated PAT path as `account.ts`/`comments.ts`
 * — see `account.ts`'s own header comment on why the trust gate applies
 * even without a workspace-supplied relay URL.
 *
 * TIMEOUTS: deliberately NOT the account/comments-style 10s default — these
 * are LLM endpoints, confirmed too slow for that live against prod
 * (2026-08-15, Dylan's account): a cold (uncached) `GET /v1/me/pulse` took
 * 8.3s, and `POST /v1/me/ask` took ~20s (Sonnet, larger cross-fabric
 * gather). Both timeouts below carry real margin over those numbers rather
 * than a round guess, since a bigger fabric than a 1-rig test account will
 * only push the real number up.
 */

const PULSE_TIMEOUT_MS = 30_000;
const ASK_TIMEOUT_MS = 60_000;

type Resolved = { url: string; token: string };

const NOT_SIGNED_IN: RigPulseError = {
  kind: 'notSignedIn',
  message: 'Not signed in to Rig.',
};

/** Same trust-then-token resolution as `account.ts`'s own `resolveContext` — see that file for why the gate applies here too. */
async function resolveContext(): Promise<Resolved | RigPulseError> {
  const url = resolveRelayUrl();
  const trust = checkRelayTrust(url);
  if (!trust.trusted) {
    log.warn('Rig pulse: refusing to send the relay token to an untrusted host', { host: trust.host });
    return {
      kind: 'untrustedRelay',
      host: trust.host,
      message: `RIG_RELAY_URL points at an unrecognized relay (${trust.host}) — refusing to send your sign-in token there.`,
    };
  }
  const token = await readRelayToken();
  if (!token) return NOT_SIGNED_IN;
  return { url, token };
}

function isError(value: Resolved | RigPulseError): value is RigPulseError {
  return 'kind' in value;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : null;
}

async function relayGet(ctx: Resolved, path: string, timeoutMs: number): Promise<Response> {
  const base = ctx.url.replace(/\/+$/, '');
  return fetch(`${base}${path}`, {
    headers: { authorization: `Bearer ${ctx.token}`, accept: 'application/json' },
    signal: AbortSignal.timeout(timeoutMs),
  });
}

async function relayPost(
  ctx: Resolved,
  path: string,
  body: Record<string, unknown>,
  timeoutMs: number
): Promise<Response> {
  const base = ctx.url.replace(/\/+$/, '');
  return fetch(`${base}${path}`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${ctx.token}`,
      accept: 'application/json',
      'content-type': 'application/json',
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });
}

function transportError(action: string, error: unknown): RigPulseError {
  log.warn('Rig pulse relay request failed', { action, error: String(error) });
  return { kind: 'relay', message: `Could not ${action} — the relay is unreachable.` };
}

async function relayError(response: Response, action: string): Promise<RigPulseError> {
  let code: string | null = null;
  try {
    const body: unknown = await response.json();
    const raw = asRecord(body)?.error;
    if (typeof raw === 'string') code = raw;
  } catch {
    // non-JSON body; the status alone has to do
  }
  return {
    kind: 'relay',
    status: response.status,
    message: code
      ? `Could not ${action} (relay: ${code}).`
      : `Could not ${action} (relay ${response.status}).`,
  };
}

// ── response shaping (defensive — mirrors `account.ts`'s `toUser`/`toBinding`
// degrade-don't-drop pattern; every shape confirmed against `tap`'s real
// `packages/relay/src/pulse.ts` source and a live prod call, not guessed) ──

function toPickBackUp(value: unknown): RigPulsePickBackUp | null {
  const raw = asRecord(value);
  if (!raw || typeof raw.bindingId !== 'string' || typeof raw.intentId !== 'string') return null;
  return {
    bindingId: raw.bindingId,
    rigName: typeof raw.rigName === 'string' ? raw.rigName : '',
    intentId: raw.intentId,
    title: typeof raw.title === 'string' ? raw.title : '',
    why: typeof raw.why === 'string' ? raw.why : '',
    at: typeof raw.at === 'string' ? raw.at : '',
  };
}

function toPerRig(value: unknown): RigPulsePerRig | null {
  const raw = asRecord(value);
  if (!raw || typeof raw.bindingId !== 'string') return null;
  return {
    bindingId: raw.bindingId,
    rigName: typeof raw.rigName === 'string' ? raw.rigName : '',
    line: typeof raw.line === 'string' ? raw.line : '',
    at: typeof raw.at === 'string' ? raw.at : null,
  };
}

function toPerPerson(value: unknown): RigPulsePerPerson | null {
  const raw = asRecord(value);
  if (!raw || typeof raw.userId !== 'string') return null;
  return {
    userId: raw.userId,
    name: typeof raw.name === 'string' ? raw.name : null,
    avatarUrl: typeof raw.avatarUrl === 'string' ? raw.avatarUrl : null,
    line: typeof raw.line === 'string' ? raw.line : '',
    isSelf: raw.isSelf === true,
  };
}

/** `{ pulse: {...}, cached }` from `GET /v1/me/pulse` — this parses just the `pulse` object; `cached` is read separately by the caller. */
export function toPulseBriefing(value: unknown): RigPulseBriefing | null {
  const raw = asRecord(value);
  if (!raw || typeof raw.greeting !== 'string') return null;
  return {
    greeting: raw.greeting,
    summary: typeof raw.summary === 'string' ? raw.summary : '',
    pickBackUp: Array.isArray(raw.pickBackUp)
      ? raw.pickBackUp.map(toPickBackUp).filter((p): p is RigPulsePickBackUp => p !== null)
      : [],
    perRig: Array.isArray(raw.perRig)
      ? raw.perRig.map(toPerRig).filter((p): p is RigPulsePerRig => p !== null)
      : [],
    perPerson: Array.isArray(raw.perPerson)
      ? raw.perPerson.map(toPerPerson).filter((p): p is RigPulsePerPerson => p !== null)
      : [],
    generatedAt: typeof raw.generatedAt === 'string' ? raw.generatedAt : '',
    degraded: raw.degraded === true,
  };
}

function toAskSource(value: unknown): RigAskSource | null {
  const raw = asRecord(value);
  const kind = raw?.kind;
  if (!raw || typeof raw.ref !== 'string' || typeof raw.bindingId !== 'string') return null;
  if (kind !== 'intent' && kind !== 'message' && kind !== 'rig') return null;
  return {
    kind,
    bindingId: raw.bindingId,
    ref: raw.ref,
    label: typeof raw.label === 'string' && raw.label.trim() ? raw.label : raw.ref,
  };
}

/** `{ answer, sources }` from `POST /v1/me/ask` — the top-level response body itself, not wrapped. */
export function toAskAnswer(value: unknown): RigAskAnswer | null {
  const raw = asRecord(value);
  if (!raw || typeof raw.answer !== 'string') return null;
  return {
    answer: raw.answer,
    sources: Array.isArray(raw.sources)
      ? raw.sources.map(toAskSource).filter((s): s is RigAskSource => s !== null)
      : [],
  };
}

export const rigPulseController = createRPCController({
  /**
   * `GET /v1/me/pulse` — cached server-side (~3h TTL); `refresh: true` maps
   * to `?refresh=1` to force regeneration. `name` (first name) personalizes
   * the greeting the same way the web passes its Clerk name — optional,
   * degrades to the relay's own Clerk lookup when omitted.
   */
  get: async ({
    refresh,
    name,
  }: { refresh?: boolean; name?: string } = {}): Promise<
    Result<{ briefing: RigPulseBriefing; cached: boolean }, RigPulseError>
  > => {
    const ctx = await resolveContext();
    if (isError(ctx)) return err(ctx);

    const params = new URLSearchParams();
    if (refresh) params.set('refresh', '1');
    if (name) params.set('name', name);
    const qs = params.toString();

    let response: Response;
    try {
      response = await relayGet(ctx, `/v1/me/pulse${qs ? `?${qs}` : ''}`, PULSE_TIMEOUT_MS);
    } catch (error) {
      return err(transportError('load your pulse', error));
    }
    if (!response.ok) return err(await relayError(response, 'load your pulse'));

    try {
      const data = asRecord(await response.json());
      const briefing = toPulseBriefing(data?.pulse);
      if (!briefing) {
        return err<RigPulseError>({ kind: 'relay', message: 'Could not load your pulse.' });
      }
      return ok({ briefing, cached: data?.cached === true });
    } catch (error) {
      return err(transportError('load your pulse', error));
    }
  },

  /**
   * `POST /v1/me/ask` — cross-fabric grounded Q&A, not cached (per-query).
   * Unlike `get`, this genuinely 503s when the relay has no LLM key (no
   * honest deterministic fallback for free-form Q&A exists) — mapped to
   * `kind: 'unavailable'` rather than the generic `relay` kind, so the UI
   * can say "Ask isn't available" instead of a generic relay-error line.
   */
  ask: async ({
    question,
    bindingId,
  }: {
    question: string;
    bindingId?: string;
  }): Promise<Result<RigAskAnswer, RigPulseError>> => {
    const ctx = await resolveContext();
    if (isError(ctx)) return err(ctx);

    let response: Response;
    try {
      response = await relayPost(
        ctx,
        '/v1/me/ask',
        { question, ...(bindingId ? { bindingId } : {}) },
        ASK_TIMEOUT_MS
      );
    } catch (error) {
      return err(transportError('ask about your rigs', error));
    }
    if (response.status === 503) {
      return err<RigPulseError>({
        kind: 'unavailable',
        message: "Ask isn't available on this relay right now.",
      });
    }
    if (!response.ok) return err(await relayError(response, 'ask about your rigs'));

    try {
      const data: unknown = await response.json();
      const answer = toAskAnswer(data);
      if (!answer) return err<RigPulseError>({ kind: 'relay', message: 'Could not get an answer.' });
      return ok(answer);
    } catch (error) {
      return err(transportError('ask about your rigs', error));
    }
  },
});
