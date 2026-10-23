import { randomUUID } from 'node:crypto';

/**
 * The `user_turn_id` gate (rig docs/orchestrator-design.md §10.2): work that
 * writes starts only for a recent id the desktop issued for the person's own
 * message or click. An agent can't mint one, so "asked for it" is checked in
 * code, not left to the model.
 */
export type TurnGate = {
  /** A fresh id for the person's own message or click. */
  issue(origin: 'chat' | 'click'): string;
  /** Whether `id` was issued here in the last `ttlMs`. */
  fresh(id: string | undefined | null): boolean;
};

export function createTurnGate(deps: { now?: () => number; ttlMs?: number } = {}): TurnGate {
  const now = deps.now ?? (() => Date.now());
  const ttl = deps.ttlMs ?? 15 * 60_000;
  const issued = new Map<string, number>();
  return {
    issue() {
      for (const [id, at] of issued) if (now() - at > ttl) issued.delete(id);
      const id = `turn_${randomUUID()}`;
      issued.set(id, now());
      return id;
    },
    fresh(id) {
      if (!id) return false;
      const at = issued.get(id);
      return at !== undefined && now() - at <= ttl;
    },
  };
}

export const turnGate = createTurnGate();
