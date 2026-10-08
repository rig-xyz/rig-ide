import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * "Waiting for sign-in…" is never a dead end: Welcome and the signed-out
 * gate show the sign-in link to open by hand and a Cancel that stops the
 * wait (rpc.rig.auth.cancel) and gives the button back.
 */

const URL = 'https://userig.xyz/sign-in?code=abc';
const mocks = vi.hoisted(() => ({ cancel: vi.fn(async () => undefined) }));

vi.mock('@renderer/lib/open-external-link', () => ({ confirmOpenExternalLink: () => {} }));
vi.mock('@renderer/lib/ipc', () => ({
  rpc: {
    rig: {
      auth: {
        login: async () => ({ success: true, data: { url: URL } }),
        // The browser tab was closed: the wait never ends on its own.
        awaitLogin: () => new Promise(() => {}),
        cancel: mocks.cancel,
      },
    },
  },
  events: { on: () => () => {} },
}));

import { SignedOutGate, Welcome } from '@renderer/features/home/home';
import { useRigSignIn } from '@renderer/features/rig-account/use-rig-sign-in';

beforeAll(() => {
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

function GateHarness() {
  const { signIn, phase, url, cancel } = useRigSignIn();
  return <SignedOutGate signInPhase={phase} onSignIn={signIn} signInUrl={url} onCancel={cancel} />;
}

function WelcomeHarness() {
  const { signIn, phase, url, cancel } = useRigSignIn();
  return (
    <Welcome
      phase={phase === 'idle' ? { kind: 'idle' } : { kind: 'signingIn' }}
      authLoading={false}
      onStartFresh={() => void signIn()}
      needsConnection={false}
      signInUrl={url}
      onCancelSignIn={cancel}
    />
  );
}

describe('Waiting for sign-in', () => {
  let host: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    mocks.cancel.mockClear();
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    host.remove();
  });

  async function start(ui: React.ReactNode, buttonText: string) {
    await act(async () => {
      root.render(<QueryClientProvider client={new QueryClient()}>{ui}</QueryClientProvider>);
    });
    const button = [...host.querySelectorAll<HTMLButtonElement>('button')].find((b) => b.textContent === buttonText)!;
    await act(async () => button.click());
    await vi.waitFor(() => expect(host.textContent).toContain('Waiting for sign-in…'));
  }

  for (const [name, ui, buttonText] of [
    ['the signed-out gate', <GateHarness key="gate" />, 'Sign in'],
    ['Welcome', <WelcomeHarness key="welcome" />, 'Start fresh'],
  ] as const) {
    it(`${name} shows the sign-in link and a Cancel that stops waiting`, async () => {
      await start(ui, buttonText);
      const waiting = host.querySelector<HTMLElement>('[data-testid="sign-in-waiting"]')!;
      expect(waiting.textContent).toContain(URL);
      await act(async () => waiting.querySelector<HTMLButtonElement>('[data-testid="sign-in-cancel"]')!.click());
      expect(mocks.cancel).toHaveBeenCalledTimes(1);
      expect(host.textContent).not.toContain('Waiting for sign-in…');
      expect(host.querySelector('[data-testid="sign-in-waiting"]')).toBeNull();
    });
  }
});
