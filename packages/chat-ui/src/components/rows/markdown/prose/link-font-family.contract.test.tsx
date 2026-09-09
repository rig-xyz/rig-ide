/**
 * link-font-family.contract.test.tsx — measure/render contract for link runs.
 *
 * `to-rich-items.ts` measures a plain link run with `fonts.link.font` (built
 * from the `body-link` role by `toFontConfig`), and `pfLink` in prose.css.ts
 * renders that same run. Families are not role-specific on either side: the
 * measurement side resolves every text role to `config.fonts.sans`, and the
 * render side resolves every text-role family var to `--chat-font-sans`
 * (`toThemeVars`), which the HOST may rebind. So the contract this pins is:
 *
 *   1. a rendered link has exactly the font-family of the body text beside it
 *      (pfLink must chain to the same `--chat-font-sans` as pfText — if it
 *      ever reads a fixed family, or a var that isn't rebound with the rest,
 *      links measure with one family and paint with another, and gaps open
 *      at link boundaries);
 *   2. rebinding `--chat-font-sans` on the host moves the link WITH the body;
 *   3. the measurement side agrees with itself: `fonts.link` and `fonts.body`
 *      carry the same family.
 *
 * A host that changes `config.fonts.sans` must also rebind `--chat-font-sans`
 * (config.ts's own `toThemeVars` note); that is the host's half of the
 * contract and is deliberately not asserted here.
 *
 * Browser project: the assertions are on real computed styles.
 */

import { DEFAULT_CONFIG, toFontConfig } from '@core/config';
import { describe, expect, it } from 'vitest';
import { createChatContext } from '@/chat-context';
import { createChatView } from '@/chat-view';
import { createChatState } from '@/state/chat-state';
import type { ChatMessage, TranscriptTurn } from '@/model';

const nextPaint = (): Promise<void> =>
  new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));

/** Normalizes a CSS font-family list for comparison: no quotes, single spaces around commas. */
function normalizeFamily(value: string): string {
  return value
    .replace(/["']/g, '')
    .split(',')
    .map((s) => s.trim())
    .join(', ');
}

/** The family portion of a `[style] weight size family` shorthand, as `fontShorthand` emits it. */
function familyOfShorthand(shorthand: string): string {
  const match = /^(?:\w+ )?\d+ \d+px (.+)$/.exec(shorthand);
  if (!match) throw new Error(`unexpected font shorthand: ${shorthand}`);
  return normalizeFamily(match[1]!);
}

async function mountMessage(text: string, hostFontSans?: string) {
  const ctx = createChatContext();
  const state = createChatState(ctx);
  const msg: ChatMessage = { kind: 'message', id: 'm1', seq: 0, role: 'assistant', text };
  const turn: TranscriptTurn = {
    id: 't1',
    seq: 0,
    initiator: 'agent',
    items: [msg] as TranscriptTurn['items'],
  };
  state.transcript.history.seed([turn]);

  const host = document.createElement('div');
  host.style.cssText = 'position:fixed;top:0;left:0;width:800px;height:400px;';
  if (hostFontSans) host.style.setProperty('--chat-font-sans', hostFontSans);
  document.body.appendChild(host);

  const view = createChatView({ context: ctx, state, parent: host, commands: {} });
  await nextPaint();
  await nextPaint();

  const cleanup = () => {
    view.dispose();
    ctx.dispose();
    state.dispose();
    document.body.removeChild(host);
  };
  return { host, cleanup };
}

const TEXT = 'Read the [release notes](https://example.com) before shipping.';

function linkAndBodyFamilies(host: HTMLElement): { link: string; body: string } {
  const anchor = Array.from(host.querySelectorAll('a')).find((a) => a.textContent === 'release notes');
  const body = Array.from(host.querySelectorAll('span')).find((s) => s.textContent?.includes('before shipping'));
  if (!anchor || !body) throw new Error('link or body fragment not rendered');
  return {
    link: normalizeFamily(getComputedStyle(anchor).fontFamily),
    body: normalizeFamily(getComputedStyle(body).fontFamily),
  };
}

describe('link runs render with the same font family they are measured with', () => {
  it('measurement: fonts.link and fonts.body carry one family', () => {
    const fonts = toFontConfig(DEFAULT_CONFIG);
    expect(familyOfShorthand(fonts.link.font)).toBe(familyOfShorthand(fonts.body.font));
  });

  it('render: a link has exactly the body text’s font-family', async () => {
    const { host, cleanup } = await mountMessage(TEXT);
    try {
      const { link, body } = linkAndBodyFamilies(host);
      expect(link).toBe(body);
      expect(link).toBe(familyOfShorthand(toFontConfig(DEFAULT_CONFIG).link.font));
    } finally {
      cleanup();
    }
  });

  it('render: rebinding --chat-font-sans on the host moves the link with the body', async () => {
    const { host, cleanup } = await mountMessage(TEXT, '"Test Link Face", serif');
    try {
      const { link, body } = linkAndBodyFamilies(host);
      expect(body).toBe('Test Link Face, serif');
      expect(link).toBe(body);
    } finally {
      cleanup();
    }
  });
});
