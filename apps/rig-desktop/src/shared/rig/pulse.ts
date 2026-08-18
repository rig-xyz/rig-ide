/**
 * Rig pulse contract, shared by the main-process relay client
 * (`main/rig/pulse.ts`) and Home's pulse section — the relay's read-plane
 * intelligence: a semantic cross-fabric briefing (`GET /v1/me/pulse`) plus
 * grounded Q&A over it (`POST /v1/me/ask`). Account-scoped, same as
 * `account.ts`: no workspace is involved in resolving either call, just the
 * signed-in user's PAT. Wire shapes mirror `tap`'s `packages/relay/src/pulse.ts`
 * exactly (confirmed against source, not guessed) — see that file's own
 * header comment for the gather/synthesize/cache architecture.
 */

/** One open intent worth resuming, with the model's one-line "why" it matters. */
export type RigPulsePickBackUp = {
  bindingId: string;
  rigName: string;
  intentId: string;
  title: string;
  why: string;
  at: string;
};

/** A rig's recent activity, narrated in one line. */
export type RigPulsePerRig = {
  bindingId: string;
  rigName: string;
  line: string;
  at: string | null;
};

/** A person's recent activity across rigs — the caller included, flagged `isSelf`. */
export type RigPulsePerPerson = {
  userId: string;
  name: string | null;
  avatarUrl: string | null;
  line: string;
  isSelf: boolean;
};

/**
 * The whole home briefing. `degraded: true` means it was built without the
 * LLM (relay has no `ANTHROPIC_API_KEY`, or the call failed) — a real,
 * fact-grounded briefing still comes back, just without narrated prose; the
 * relay's own `GET /v1/me/pulse` route NEVER errors for this reason, so
 * Home is never blocked on it. Live-verified against the prod relay
 * (2026-08-15): `degraded: false`, fully narrated, ~8.3s cold / ~0.5s cached.
 */
export type RigPulseBriefing = {
  greeting: string;
  /** 1-2 sentence recap under the greeting — may be empty. */
  summary: string;
  pickBackUp: RigPulsePickBackUp[];
  perRig: RigPulsePerRig[];
  perPerson: RigPulsePerPerson[];
  generatedAt: string;
  degraded: boolean;
};

/** A cited source behind an Ask answer — grounds the model's claim in a real intent/message/rig. */
export type RigAskSource = {
  kind: 'intent' | 'message' | 'rig';
  bindingId: string;
  ref: string;
  label: string;
};

export type RigAskAnswer = {
  answer: string;
  sources: RigAskSource[];
};

export type RigPulseError =
  | { kind: 'notSignedIn'; message: string }
  | { kind: 'untrustedRelay'; host: string; message: string }
  /**
   * `POST /v1/me/ask` 503s `{ error: "pulse_unavailable" }` outright when the
   * relay has no LLM key — unlike pulse, ask has no honest deterministic
   * fallback for free-form Q&A. Live-confirmed the *shape*; prod itself has
   * the key configured (2026-08-15), so this path is exercised only against
   * a relay that doesn't.
   */
  | { kind: 'unavailable'; message: string }
  | { kind: 'relay'; status?: number; message: string };
