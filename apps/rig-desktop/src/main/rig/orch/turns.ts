import { randomUUID } from 'node:crypto';

/**
 * The `user_turn_id` gate (rig docs/orchestrator-design.md §10.2): work that
 * writes starts only for a recent id the desktop issued for the person's own
 * message or click. An agent can't mint one, so "asked for it" is checked in
 * code, not left to the model.
 */
export type TurnOrigin = 'chat' | 'click';

/** The only origins whose ids pass the gate. Anything else (a run, a guess) never does. */
const PERSON: ReadonlySet<string> = new Set<TurnOrigin>(['chat', 'click']);

export type TurnGate = {
  /** A fresh id for the person's own message or click. A background run gets none. */
  issue(origin: TurnOrigin): string;
  /** Whether `id` was issued here in the last `ttlMs`, for the person's own message or click. */
  fresh(id: string | undefined | null): boolean;
};

export function createTurnGate(deps: { now?: () => number; ttlMs?: number } = {}): TurnGate {
  const now = deps.now ?? (() => Date.now());
  const ttl = deps.ttlMs ?? 15 * 60_000;
  const issued = new Map<string, { at: number; origin: string }>();
  return {
    issue(origin) {
      for (const [id, x] of issued) if (now() - x.at > ttl) issued.delete(id);
      const id = `turn_${randomUUID()}`;
      issued.set(id, { at: now(), origin });
      return id;
    },
    fresh(id) {
      if (!id) return false;
      const x = issued.get(id);
      return x !== undefined && PERSON.has(x.origin) && now() - x.at <= ttl;
    },
  };
}

export const turnGate = createTurnGate();
