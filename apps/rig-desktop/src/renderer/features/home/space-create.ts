/**
 * Polish round 2, lane F — the one-click "New space" flow (Google-Meet
 * style: one click, land straight in the Room). The actual creation goes
 * through the SAME path the Spaces card's manual "#name" field already used
 * (`rpc.rig.create.create({ kind: 'space', ... })`, via `home.tsx`'s own
 * `createSpace`) — this module only supplies the one thing a one-click flow
 * needs that a typed name skips: a friendly, auto-generated name.
 *
 * Two short, common words — never a slug of random characters — so a
 * freshly-created space still reads as something a person named, not a
 * generated id. Kept deliberately small and boring (no themed sets, no
 * profanity list to maintain): the collision retry below is what actually
 * guarantees uniqueness, not the list's size.
 */

const ADJECTIVES = [
  'bright',
  'calm',
  'quiet',
  'swift',
  'steady',
  'clear',
  'bold',
  'golden',
  'quick',
  'gentle',
  'sunny',
  'crisp',
  'lively',
  'warm',
  'open',
  'fresh',
] as const;

const NOUNS = [
  'harbor',
  'summit',
  'meadow',
  'river',
  'canyon',
  'orbit',
  'compass',
  'beacon',
  'garden',
  'valley',
  'horizon',
  'island',
  'trail',
  'grove',
  'coast',
  'ridge',
] as const;

/** How many random word pairs to try before falling back to a numbered suffix — generous headroom over the 16×16 = 256 combinations above. */
const MAX_ATTEMPTS = 30;

/**
 * A friendly two-word name ("bright-harbor"), unique against
 * `existingNames` (case-insensitive — two spaces named "Growth" and
 * "growth" would otherwise both look taken and neither). `random` is
 * injectable so this is deterministically testable — defaults to
 * `Math.random` for real use.
 */
export function generateSpaceName(
  existingNames: ReadonlySet<string> = new Set(),
  random: () => number = Math.random
): string {
  const taken = new Set([...existingNames].map((name) => name.toLowerCase()));
  const pick = <T>(list: readonly T[]): T => list[Math.floor(random() * list.length)]!;

  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    const candidate = `${pick(ADJECTIVES)}-${pick(NOUNS)}`;
    if (!taken.has(candidate)) return candidate;
  }

  // Exhausted the word-pair space (or a pathological `existingNames`) —
  // never loop forever; a numbered suffix off the first pair is still
  // unique and still reads as a name, not a UUID.
  const base = `${pick(ADJECTIVES)}-${pick(NOUNS)}`;
  let suffix = 2;
  let candidate = `${base}-${suffix}`;
  while (taken.has(candidate)) {
    suffix++;
    candidate = `${base}-${suffix}`;
  }
  return candidate;
}
