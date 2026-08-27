import type { TranscriptTurn } from '@emdash/core/acp';

const INTENT_TITLE_MAX_LENGTH = 160;
const INTENT_SUMMARY_MAX_LENGTH = 800;

export type RigTurnIntentContext = {
  title: string | null;
  summaryText: string | null;
};

/** Distill a transcript turn into bounded relay fields without provider-specific parsing. */
export function intentContextFromTurn(turn: TranscriptTurn): RigTurnIntentContext {
  const messages = turn.items.filter((item) => item.kind === 'message');
  const prompt = messages.find((message) => message.role === 'user')?.text ?? null;
  let assistant: string | null = null;
  for (const message of messages) {
    if (message.role === 'assistant') assistant = message.text;
  }
  return {
    title: compactText(prompt, INTENT_TITLE_MAX_LENGTH),
    summaryText: compactText(assistant, INTENT_SUMMARY_MAX_LENGTH),
  };
}

function compactText(value: string | null, maxLength: number): string | null {
  if (!value) return null;
  const compact = value.replace(/\s+/g, ' ').trim();
  if (!compact) return null;
  if (compact.length <= maxLength) return compact;
  return `${compact.slice(0, maxLength - 1).trimEnd()}…`;
}
