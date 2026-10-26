import { describe, expect, it } from 'vitest';
import { readableRefs, startPrompt, startPromptFromBrief } from './start-prompt';

const brief = `---
title: "Prepare your review of Christopher's PR"
version: 1
---

# Prepare your review of Christopher's PR

## Goal
Draft the review.

## Done when
The goal is met.

## Why Rig suggested this
Christopher tagged you; only CodeRabbit has reviewed it.

More context.

## Evidence
- evt_abc123: Christopher tagged you on #350
- evt_def456: CodeRabbit flagged settlement bugs

## Limits
Don't post anything.
`;

describe('startPromptFromBrief', () => {
  it('rebuilds the first message from a brief file, refs taken off the evidence', () => {
    expect(startPromptFromBrief(brief, 'sessions/x/brief.md')).toBe(
      startPrompt({
        title: "Prepare your review of Christopher's PR",
        goal: 'Draft the review.',
        why: 'Christopher tagged you; only CodeRabbit has reviewed it.\n\nMore context.',
        seen: ['Christopher tagged you on #350', 'CodeRabbit flagged settlement bugs'],
        briefPath: 'sessions/x/brief.md',
      })
    );
  });

  it('is null for something that is not a brief', () => {
    expect(startPromptFromBrief('no heading here', 'sessions/x/brief.md')).toBeNull();
  });
});

describe('readableRefs', () => {
  it('names refs the way people do, never raw', () => {
    expect(readableRefs('Christopher tagged you on [github:Ulysholdings/mobile-ios-v2#350]; see linear:ULY-534 and [slack:C123/p456].')).toBe(
      'Christopher tagged you on [mobile-ios-v2#350](https://github.com/Ulysholdings/mobile-ios-v2/issues/350); see ULY-534 and C123/p456.'
    );
  });
});
