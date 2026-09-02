import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  login: vi.fn(),
  awaitLogin: vi.fn(),
  authStatus: vi.fn(),
  createRig: vi.fn(),
  enableSync: vi.fn(),
  getRigHome: vi.fn(),
  importDoc: vi.fn(),
  openSelectDocumentFileDialog: vi.fn(),
  readBinary: vi.fn(),
  renameFile: vi.fn(),
}));

vi.mock('@renderer/lib/ipc', () => ({
  rpc: {
    rig: {
      auth: {
        login: (...args: unknown[]) => mocks.login(...args),
        awaitLogin: (...args: unknown[]) => mocks.awaitLogin(...args),
        status: (...args: unknown[]) => mocks.authStatus(...args),
      },
      create: {
        create: (...args: unknown[]) => mocks.createRig(...args),
        enableSync: (...args: unknown[]) => mocks.enableSync(...args),
      },
      home: {
        get: (...args: unknown[]) => mocks.getRigHome(...args),
      },
      importDoc: {
        importDoc: (...args: unknown[]) => mocks.importDoc(...args),
      },
      files: {
        readBinary: (...args: unknown[]) => mocks.readBinary(...args),
        rename: (...args: unknown[]) => mocks.renameFile(...args),
      },
    },
    app: {
      openSelectDocumentFileDialog: (...args: unknown[]) =>
        mocks.openSelectDocumentFileDialog(...args),
    },
  },
  events: { on: vi.fn(() => () => {}) },
}));

vi.mock('@renderer/lib/open-external-link', () => ({
  confirmOpenExternalLink: vi.fn(),
}));

import { useRigSignIn } from '@renderer/features/rig-account/use-rig-sign-in';
import { ImportDocDialog } from '@renderer/features/rig-import/import-doc-dialog';
import { RenameFileDialog } from '@renderer/features/workspace/rename-file-dialog';

beforeAll(() => {
  (
    globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
});

function SignInHarness() {
  const { phase, error, signIn } = useRigSignIn();
  return (
    <div>
      <button type="button" onClick={() => void signIn()}>
        Sign in
      </button>
      <span data-testid="phase">{phase}</span>
      {error && <span data-testid="error">{error}</span>}
    </div>
  );
}

async function setInputValue(input: HTMLInputElement | null, value: string): Promise<void> {
  const valueSetter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
  await act(async () => {
    valueSetter?.call(input, value);
    input?.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

describe('renderer rejection paths settle their busy state', () => {
  let host: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    mocks.login.mockReset();
    mocks.awaitLogin.mockReset();
    mocks.authStatus.mockReset();
    mocks.createRig.mockReset();
    mocks.enableSync.mockReset();
    mocks.getRigHome.mockReset();
    mocks.importDoc.mockReset();
    mocks.openSelectDocumentFileDialog.mockReset();
    mocks.readBinary.mockReset();
    mocks.renameFile.mockReset();
    mocks.authStatus.mockResolvedValue({ signedIn: true });
    mocks.getRigHome.mockResolvedValue({ displayPath: '~/Rig' });
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    host.remove();
  });

  it('returns sign-in to idle when login transport rejects', async () => {
    mocks.login.mockRejectedValue(new Error('transport failed'));
    const queryClient = new QueryClient();

    await act(async () => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <SignInHarness />
        </QueryClientProvider>
      );
    });
    await act(async () => {
      host.querySelector('button')?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await Promise.resolve();
    });

    expect(host.querySelector('[data-testid="phase"]')?.textContent).toBe('idle');
    expect(host.querySelector('[data-testid="error"]')?.textContent).toContain(
      "Couldn't complete sign-in"
    );
  });

  it('returns sign-in to idle when waiting for login rejects', async () => {
    mocks.login.mockResolvedValue({ success: true, data: { url: null } });
    mocks.awaitLogin.mockRejectedValue(new Error('transport failed'));
    const queryClient = new QueryClient();

    await act(async () => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <SignInHarness />
        </QueryClientProvider>
      );
    });
    await act(async () => {
      host.querySelector('button')?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await Promise.resolve();
    });

    expect(host.querySelector('[data-testid="phase"]')?.textContent).toBe('idle');
    expect(host.querySelector('[data-testid="error"]')?.textContent).toContain(
      "Couldn't complete sign-in"
    );
  });

  it('clears import busy state when the import transport rejects', async () => {
    mocks.openSelectDocumentFileDialog.mockResolvedValue('/tmp/example.docx');
    mocks.importDoc.mockRejectedValue(new Error('transport failed'));
    const onOpenChange = vi.fn();
    const onImported = vi.fn();

    await act(async () => {
      root.render(
        <ImportDocDialog
          root="/repo"
          rootId="root-1"
          open
          onOpenChange={onOpenChange}
          onImported={onImported}
        />
      );
    });

    const docxTile = [...document.body.querySelectorAll('button')].find((button) =>
      button.textContent?.includes('Choose a .docx')
    );
    await act(async () => docxTile?.click());
    const chooseFile = [...document.body.querySelectorAll('button')].find((button) =>
      button.textContent?.includes('Choose file')
    );
    await act(async () => chooseFile?.click());
    const importButton = [...document.body.querySelectorAll('button')].find(
      (button) => button.textContent?.trim() === 'Import'
    );
    await act(async () => {
      importButton?.click();
      await Promise.resolve();
    });

    expect(document.body.textContent).not.toContain('Importing');
    expect(document.body.textContent).toContain("Couldn't import this doc");
    expect(onImported).not.toHaveBeenCalled();
  });


  it('clears file-operation busy state when rename transport rejects', async () => {
    mocks.renameFile.mockRejectedValue(new Error('transport failed'));

    await act(async () => {
      root.render(
        <RenameFileDialog
          open
          onOpenChange={vi.fn()}
          absPath="/repo/notes.md"
          root="/repo"
          rootId="root-1"
          currentName="notes.md"
          onRenamed={vi.fn()}
        />
      );
    });

    await setInputValue(
      document.body.querySelector<HTMLInputElement>('#rig-file-rename'),
      'brief.md'
    );
    const saveButton = [...document.body.querySelectorAll('button')].find(
      (button) => button.textContent?.trim() === 'Save'
    );
    await act(async () => {
      saveButton?.click();
      await Promise.resolve();
    });

    expect(document.body.textContent).not.toContain('Saving…');
    expect(document.body.textContent).toContain("Couldn't rename this item. Try again.");
  });
});
