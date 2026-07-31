import { WebLinksAddon } from '@xterm/addon-web-links';
import { Terminal } from '@xterm/xterm';
import { Check, Copy, ExternalLink, Loader2 } from 'lucide-react';
import { reaction } from 'mobx';
import { useEffect, useRef, useState } from 'react';
import { AcpAuthLoginBinding } from '@renderer/lib/acp/auth-login-binding';
import { normalizeExternalHttpUrl } from '@renderer/lib/external-url';
import { rpc } from '@renderer/lib/ipc';
import type { BaseModalProps } from '@renderer/lib/modal/modal-provider';
import { isPrimaryMouseButton } from '@renderer/lib/pty/file-link-provider';
import {
  buildTheme,
  TERMINAL_LETTER_SPACING,
  TERMINAL_LINE_HEIGHT,
  TERMINAL_PADDING_PX,
} from '@renderer/lib/pty/pty';
import { computeGridDimensions, measureTerminalCell } from '@renderer/lib/pty/pty-dimensions';
import { buildTerminalFontFamily } from '@renderer/lib/pty/terminal-font';
import { Button } from '@renderer/lib/ui/button';
import {
  DialogContentArea,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@renderer/lib/ui/dialog';
import { TERMINAL_FONT_SIZE_DEFAULT } from '@shared/core/terminals/terminal-settings';

export type AgentSignInModalArgs = {
  providerId: string;
  methodId: string;
  providerName: string;
};

type AgentSignInModalProps = BaseModalProps<void> & AgentSignInModalArgs;

const HTTP_URL_PATTERN = /^https?:\/\//i;

/**
 * Opens a login URL in the system browser directly, WITHOUT the
 * confirmExternalLinkModal. The modal system holds one modal at a time, so the
 * confirm dialog would replace this one — unmounting the terminal the user has
 * to paste their auth code back into, killing the sign-in halfway through.
 * Informed consent is preserved a different way: the URL is rendered in full in
 * the banner right next to the button that opens it.
 */
function openLoginUrl(url: string): void {
  const normalized = normalizeExternalHttpUrl(url);
  if (!HTTP_URL_PATTERN.test(normalized)) return;
  void rpc.app.openExternal(normalized).catch(() => {});
}

/** The sign-in URL the agent printed, with copy + open kept inside this modal. */
function LoginUrlBanner({ url }: { url: string }) {
  const [copied, setCopied] = useState(false);

  const copy = () => {
    void rpc.app.clipboardWriteText(url).then((result) => {
      if (!result.success) return;
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  };

  return (
    <div className="mx-3 mt-3 flex flex-col gap-2 rounded-md border border-border p-3">
      <p className="text-xs text-foreground-muted">
        Finish signing in in your browser. If you're given a code, come back and paste it into the
        terminal below.
      </p>
      <code className="truncate font-mono text-xs text-foreground-muted" title={url}>
        {url}
      </code>
      <div className="flex gap-2">
        <Button size="sm" onClick={() => openLoginUrl(url)}>
          <ExternalLink className="h-3.5 w-3.5" />
          Open in Browser
        </Button>
        <Button size="sm" variant="outline" onClick={copy}>
          {copied ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
          {copied ? 'Copied' : 'Copy link'}
        </Button>
      </div>
    </div>
  );
}

export function AgentSignInModal({
  providerId,
  methodId,
  providerName,
  onSuccess,
  onClose,
}: AgentSignInModalProps) {
  const [error, setError] = useState<string | null>(null);
  const [ready, setReady] = useState(false);
  const [pendingUrl, setPendingUrl] = useState<string | null>(null);
  const terminalHostRef = useRef<HTMLDivElement | null>(null);
  const bindingRef = useRef<AcpAuthLoginBinding | null>(null);
  const handledUrlsRef = useRef(new Set<string>());

  useEffect(() => {
    const host = terminalHostRef.current;
    if (!host) return;

    let disposed = false;
    let animationFrame: number | null = null;
    const terminal = createLoginTerminal();
    terminal.open(host);
    styleLoginTerminal(terminal);
    terminal.focus();

    const inputDisposable = terminal.onData((data) => {
      bindingRef.current?.sendInput(data);
    });
    const resize = () => {
      if (disposed) return;
      resizeLoginTerminal(terminal, host, bindingRef.current);
    };
    const observer = new ResizeObserver(() => {
      if (animationFrame !== null) cancelAnimationFrame(animationFrame);
      animationFrame = requestAnimationFrame(resize);
    });
    observer.observe(host);
    resize();

    void AcpAuthLoginBinding.create({ providerId, methodId, terminal }).then(
      (binding) => {
        if (disposed) {
          binding.dispose();
          return;
        }
        bindingRef.current = binding;
        setReady(true);
        resize();
      },
      (err: unknown) => {
        if (!disposed) setError(err instanceof Error ? err.message : String(err));
      }
    );

    return () => {
      disposed = true;
      if (animationFrame !== null) cancelAnimationFrame(animationFrame);
      observer.disconnect();
      inputDisposable.dispose();
      bindingRef.current?.dispose();
      bindingRef.current = null;
      terminal.dispose();
    };
  }, [methodId, providerId]);

  useEffect(() => {
    const binding = bindingRef.current;
    if (!binding || !ready) return;
    return reaction(
      () => binding.status.current(),
      (state) => {
        if (state.status.kind === 'authenticated') {
          binding.dispose(false);
          bindingRef.current = null;
          onSuccess();
          return;
        }

        const nextUrl = state.login?.pendingUrl;
        if (!nextUrl || handledUrlsRef.current.has(nextUrl.id)) return;
        handledUrlsRef.current.add(nextUrl.id);
        // Surfaced inside THIS modal rather than via confirmOpenExternalLink —
        // that shows a second modal, and the modal system holds one at a time,
        // so it would replace this one and kill the login terminal mid-flow.
        setPendingUrl(nextUrl.url);
        binding.markUrlHandled(nextUrl.id);
      },
      { fireImmediately: true }
    );
  }, [onSuccess, ready]);

  return (
    <>
      <DialogHeader>
        <DialogTitle>Sign in to {providerName}</DialogTitle>
      </DialogHeader>
      <DialogContentArea className="flex h-[520px] flex-col p-0">
        {pendingUrl && <LoginUrlBanner url={pendingUrl} />}
        <div className="relative m-3 min-h-0 flex-1">
          <div
            ref={terminalHostRef}
            className="h-full rounded-md border border-border bg-(--xterm-bg)"
          />
          {!ready && !error && (
            <div className="absolute inset-0 flex items-center justify-center gap-2 bg-background/60 text-sm text-foreground-muted">
              <Loader2 className="h-4 w-4 animate-spin" />
              Starting sign-in terminal...
            </div>
          )}
          {error && (
            <div className="text-destructive absolute inset-0 bg-background p-4 text-sm">
              {error}
            </div>
          )}
        </div>
      </DialogContentArea>
      <DialogFooter>
        <Button variant="outline" onClick={onClose}>
          Close
        </Button>
      </DialogFooter>
    </>
  );
}

function createLoginTerminal(): Terminal {
  const terminal = new Terminal({
    cols: 120,
    rows: 32,
    scrollback: 100_000,
    fontFamily: buildTerminalFontFamily(),
    fontSize: TERMINAL_FONT_SIZE_DEFAULT,
    lineHeight: TERMINAL_LINE_HEIGHT,
    letterSpacing: TERMINAL_LETTER_SPACING,
    allowProposedApi: true,
    scrollOnUserInput: false,
    // Links open directly here too: the URL is visible in the terminal the
    // user is clicking, and the confirm dialog would replace this modal and
    // kill the login PTY (see openLoginUrl).
    linkHandler: {
      activate: (event, text) => {
        if (!isPrimaryMouseButton(event)) return;
        openLoginUrl(text);
      },
    },
    theme: buildTheme(),
  });
  terminal.loadAddon(
    new WebLinksAddon((event, uri) => {
      if (!isPrimaryMouseButton(event)) return;
      event.preventDefault();
      openLoginUrl(uri);
    })
  );
  return terminal;
}

function styleLoginTerminal(terminal: Terminal): void {
  const element = (terminal as unknown as { element?: HTMLElement }).element;
  if (!element) return;
  element.style.width = '100%';
  element.style.height = '100%';
  element.style.boxSizing = 'border-box';
  element.style.padding = `${TERMINAL_PADDING_PX}px`;
  element.style.backgroundColor = 'var(--xterm-bg)';
}

function resizeLoginTerminal(
  terminal: Terminal,
  host: HTMLElement,
  binding: AcpAuthLoginBinding | null
): void {
  const cell = measureTerminalCell(
    buildTerminalFontFamily(),
    TERMINAL_FONT_SIZE_DEFAULT,
    TERMINAL_LINE_HEIGHT,
    TERMINAL_LETTER_SPACING
  );
  if (!cell) return;
  const dims = computeGridDimensions({
    widthPx: host.clientWidth,
    heightPx: host.clientHeight,
    cellWidth: cell.width,
    cellHeight: cell.height,
    paddingPx: TERMINAL_PADDING_PX,
  });
  if (!dims) return;
  if (terminal.cols !== dims.cols || terminal.rows !== dims.rows) {
    terminal.resize(dims.cols, dims.rows);
  }
  binding?.resize(dims.cols, dims.rows);
}
