import { describe, expect, it } from 'vitest';
import { decideSubmitDisposition, deriveTranscriptPanelMode, shouldShowResumeButton } from './resume-presentation';

describe('deriveTranscriptPanelMode', () => {
  it('a brand-new session still loading, nothing seeded — full-panel loading (nothing to protect)', () => {
    expect(deriveTranscriptPanelMode({ loading: true, hasError: false, hasSeededHistory: false })).toEqual({
      kind: 'fullPanelLoading',
    });
  });

  it('a brand-new session that failed, nothing seeded — full-panel error', () => {
    expect(deriveTranscriptPanelMode({ loading: false, hasError: true, hasSeededHistory: false })).toEqual({
      kind: 'fullPanelError',
    });
  });

  it('a resume still loading with local history already seeded — transcript stays up, no inline error', () => {
    expect(deriveTranscriptPanelMode({ loading: true, hasError: false, hasSeededHistory: true })).toEqual({
      kind: 'transcript',
      inlineError: false,
    });
  });

  it('a resume that failed with local history already seeded — transcript stays up, WITH an inline error', () => {
    expect(deriveTranscriptPanelMode({ loading: false, hasError: true, hasSeededHistory: true })).toEqual({
      kind: 'transcript',
      inlineError: true,
    });
  });

  it('a resume still "loading" (retry in flight) that also has a stale error flag and seeded history — transcript, inline error (error wins the label)', () => {
    expect(deriveTranscriptPanelMode({ loading: true, hasError: true, hasSeededHistory: true })).toEqual({
      kind: 'transcript',
      inlineError: true,
    });
  });

  it('the steady state — settled, no error, nothing ever needed seeding (a fresh empty session) — plain transcript', () => {
    expect(deriveTranscriptPanelMode({ loading: false, hasError: false, hasSeededHistory: false })).toEqual({
      kind: 'transcript',
      inlineError: false,
    });
  });

  it('error present but nothing seeded and not loading — still the full-panel error, not a silent inline one', () => {
    expect(deriveTranscriptPanelMode({ loading: false, hasError: true, hasSeededHistory: false })).toEqual({
      kind: 'fullPanelError',
    });
  });
});

describe('decideSubmitDisposition', () => {
  it('holds when the session does not exist yet, regardless of isWorking', () => {
    expect(decideSubmitDisposition({ sessionReady: false, isWorking: false })).toBe('hold');
    expect(decideSubmitDisposition({ sessionReady: false, isWorking: true })).toBe('hold');
  });

  it('sends immediately once the session is ready and nothing is generating', () => {
    expect(decideSubmitDisposition({ sessionReady: true, isWorking: false })).toBe('send');
  });

  it('queues once the session is ready but a turn is already generating', () => {
    expect(decideSubmitDisposition({ sessionReady: true, isWorking: true })).toBe('queue');
  });
});

describe('shouldShowResumeButton', () => {
  it('a resumable replay tab with nothing typed — shown', () => {
    expect(
      shouldShowResumeButton({ hasReplaySession: true, canResume: true, hasTypedText: false })
    ).toBe(true);
  });

  it('the moment there is typed text, the button steps aside — Send already resumes-then-sends in one action', () => {
    expect(
      shouldShowResumeButton({ hasReplaySession: true, canResume: true, hasTypedText: true })
    ).toBe(false);
  });

  it('a non-resumable provider (no genuine loadSession support) — never a fake button', () => {
    expect(
      shouldShowResumeButton({ hasReplaySession: true, canResume: false, hasTypedText: false })
    ).toBe(false);
  });

  it('no replay session at all (zero-state or a live tab) — never shown', () => {
    expect(
      shouldShowResumeButton({ hasReplaySession: false, canResume: true, hasTypedText: false })
    ).toBe(false);
  });
});
