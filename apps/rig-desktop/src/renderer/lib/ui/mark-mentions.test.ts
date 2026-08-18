import { describe, expect, it } from 'vitest';
import { markMentions } from './mark-mentions';

describe('markMentions', () => {
  it('wraps an agent-style mention in strong syntax', () => {
    expect(markMentions('hey @claude can you look at this')).toBe(
      'hey **@claude** can you look at this'
    );
  });

  it('wraps a person-style mention (up to three capitalized words) in strong syntax', () => {
    expect(markMentions('cc @Dylan Bourgeois for review')).toBe(
      'cc **@Dylan Bourgeois** for review'
    );
  });

  it('leaves an email-shaped or mid-word @ alone', () => {
    // no leading whitespace/paren before the `@` — not a mention
    expect(markMentions('contact me at dylan@example.com')).toBe(
      'contact me at dylan@example.com'
    );
  });

  it('never touches an @-string inside an inline code span', () => {
    const content = 'run `@claude --help` from the CLI';
    expect(markMentions(content)).toBe(content);
  });

  it('never touches an @-string inside a fenced code block', () => {
    const content = ['```', 'ping @claude', '```'].join('\n');
    expect(markMentions(content)).toBe(content);
  });

  it('marks a mention at the very start of the string', () => {
    expect(markMentions('@codex please triage')).toBe('**@codex** please triage');
  });
});
