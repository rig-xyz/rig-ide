import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  status: vi.fn(),
  send: vi.fn(),
  saveToFile: vi.fn(),
  clipboardWriteText: vi.fn(),
}));

vi.mock('@renderer/lib/ipc', () => ({
  rpc: {
    rig: {
      problemReport: { status: mocks.status, send: mocks.send, saveToFile: mocks.saveToFile },
    },
    app: { clipboardWriteText: mocks.clipboardWriteText },
  },
  events: { on: vi.fn(() => () => {}) },
}));

import { ReportProblemDialog } from '@renderer/features/shell/report-problem-dialog';

beforeAll(() => {
  (
    globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
});

function button(label: string): HTMLButtonElement | undefined {
  return [...document.querySelectorAll<HTMLButtonElement>('button')].find(
    (b) => b.textContent?.trim() === label
  );
}

async function type(text: string) {
  const box = document.querySelector<HTMLTextAreaElement>('#report-problem-text')!;
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!;
  await act(async () => {
    setter.call(box, text);
    box.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

async function flush() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

describe('Report a problem dialog', () => {
  let host: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    mocks.status.mockResolvedValue({ signedIn: true });
    mocks.send.mockReset();
    mocks.saveToFile.mockReset();
    mocks.clipboardWriteText.mockResolvedValue({ success: true });
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    host.remove();
  });

  async function open() {
    await act(async () => root.render(<ReportProblemDialog open onOpenChange={() => {}} />));
    await flush();
  }

  it('says what will be attached, and sends only once something is written', async () => {
    await open();
    const text = document.body.textContent ?? '';
    expect(text).toContain('What happened?');
    expect(text).toContain('The recent app log, with secrets removed');
    expect(text).toContain('Versions of Rig, the rig command, sync and your agents');
    expect(text).toContain('Sync status of your open spaces');
    expect(text).toContain('Your account');
    expect(button('Send')?.disabled).toBe(true);
    expect(button('Save to a file')).toBeUndefined();
    await type('Sync stopped');
    expect(button('Send')?.disabled).toBe(false);
  });

  it('sent: shows the reference with a Copy button', async () => {
    mocks.send.mockResolvedValue({ kind: 'sent', ref: 'RPT-7K2Q' });
    await open();
    await type('Sync stopped');
    await act(async () => button('Send')!.click());
    await flush();
    expect(mocks.send).toHaveBeenCalledWith({ text: 'Sync stopped' });
    expect(document.querySelector('[data-testid="report-problem-sent"]')?.textContent).toContain(
      'Sent. Your reference is RPT-7K2Q'
    );
    await act(async () => button('Copy')!.click());
    await flush();
    expect(mocks.clipboardWriteText).toHaveBeenCalledWith('RPT-7K2Q');
    expect(button('Copied')).toBeTruthy();
  });

  it('failed: says so and offers Save to a file with the same text', async () => {
    mocks.send.mockResolvedValue({ kind: 'failed', message: "The server can't take reports yet." });
    mocks.saveToFile.mockResolvedValue({ kind: 'saved' });
    await open();
    await type('Agents never start');
    await act(async () => button('Send')!.click());
    await flush();
    expect(document.querySelector('[data-testid="report-problem-failed"]')?.textContent).toContain(
      "Couldn't send it. The server can't take reports yet."
    );
    expect(button('Try again')).toBeTruthy();
    await act(async () => button('Save to a file')!.click());
    await flush();
    expect(mocks.saveToFile).toHaveBeenCalledWith({ text: 'Agents never start' });
    expect(document.body.textContent).toContain('Saved.');
  });

  it('signed out: asks to sign in first, Send stays off, Save to a file works', async () => {
    mocks.status.mockResolvedValue({ signedIn: false });
    mocks.saveToFile.mockResolvedValue({ kind: 'saved' });
    await open();
    await type('Cannot sign in');
    expect(
      document.querySelector('[data-testid="report-problem-signed-out"]')?.textContent
    ).toContain('Sign in to Rig to send this');
    expect(button('Send')?.disabled).toBe(true);
    await act(async () => button('Save to a file')!.click());
    await flush();
    expect(mocks.saveToFile).toHaveBeenCalledWith({ text: 'Cannot sign in' });
    expect(mocks.send).not.toHaveBeenCalled();
  });
});
