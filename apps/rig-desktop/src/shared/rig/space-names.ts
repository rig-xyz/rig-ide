/**
 * The words a space's random starting name is made of ("bright-harbor"), and how to tell such a
 * name from one a person chose. Shared so the app that creates the name and the one that later
 * offers to replace it agree on what a generated name looks like.
 */

export const ADJECTIVES = [
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

export const NOUNS = [
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

/** A name made at random when the space was made: `<adjective>-<noun>`, maybe with a `-<digits>` suffix. */
export function isGeneratedSpaceName(name: string): boolean {
  const parts = name.trim().toLowerCase().split('-');
  if (parts.length === 3 && !/^\d+$/.test(parts[2]!)) return false;
  if (parts.length < 2 || parts.length > 3) return false;
  return (ADJECTIVES as readonly string[]).includes(parts[0]!) && (NOUNS as readonly string[]).includes(parts[1]!);
}
