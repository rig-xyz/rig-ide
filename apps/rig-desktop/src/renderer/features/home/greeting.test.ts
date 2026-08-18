import { describe, expect, it } from 'vitest';
import { composeGreeting, deriveSalutation, firstNameOf } from './greeting';

describe('deriveSalutation', () => {
  it('before noon — morning', () => {
    expect(deriveSalutation(0)).toBe('Good morning');
    expect(deriveSalutation(6)).toBe('Good morning');
    expect(deriveSalutation(11)).toBe('Good morning');
  });

  it('noon through 5pm — afternoon (the boundary itself is afternoon, not morning)', () => {
    expect(deriveSalutation(12)).toBe('Good afternoon');
    expect(deriveSalutation(15)).toBe('Good afternoon');
    expect(deriveSalutation(17)).toBe('Good afternoon');
  });

  it('6pm onward — evening (the boundary itself is evening, not afternoon)', () => {
    expect(deriveSalutation(18)).toBe('Good evening');
    expect(deriveSalutation(21)).toBe('Good evening');
    expect(deriveSalutation(23)).toBe('Good evening');
  });
});

describe('firstNameOf', () => {
  it('takes the first token of a multi-word name', () => {
    expect(firstNameOf('Dylan Bourgeois')).toBe('Dylan');
  });

  it('a single-word name is returned as-is', () => {
    expect(firstNameOf('Dylan')).toBe('Dylan');
  });

  it('collapses incidental whitespace', () => {
    expect(firstNameOf('  Dylan   Bourgeois  ')).toBe('Dylan');
  });

  it('null/empty/whitespace-only name degrades to null, not a placeholder', () => {
    expect(firstNameOf(null)).toBeNull();
    expect(firstNameOf('')).toBeNull();
    expect(firstNameOf('   ')).toBeNull();
  });
});

describe('composeGreeting', () => {
  it('with a name — "Good <salutation>, <name>."', () => {
    expect(composeGreeting(15, 'Dylan')).toBe('Good afternoon, Dylan.');
    expect(composeGreeting(8, 'Dylan')).toBe('Good morning, Dylan.');
    expect(composeGreeting(20, 'Dylan')).toBe('Good evening, Dylan.');
  });

  it('signed in with no profile name — salutation alone, never a placeholder', () => {
    expect(composeGreeting(15, null)).toBe('Good afternoon.');
  });
});
