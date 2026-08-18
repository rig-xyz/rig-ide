import { WebLinksAddon } from '@xterm/addon-web-links';
import { Terminal, type ITerminalOptions } from '@xterm/xterm';
import { Check, Copy, ExternalLink, Loader2 } from 'lucide-react';
import { reaction } from 'mobx';
import { useEffect, useRef, useState } from 'react';
import { AcpAuthLoginBinding } from '@renderer/lib/acp/auth-login-binding';
import { rpc } from '@renderer/lib/ipc';
import { computeGridDimensions, measureTerminalCell } from '@renderer/lib/pty/pty-dimensions';
import { buildTerminalFontFamily } from '@renderer/lib/pty/terminal-font';
import { Button } from '@renderer/lib/ui/button';
import { Dialog, DialogClose, DialogContent, DialogTitle } from '@renderer/lib/ui/dialog';

/**
 * The embedded-terminal sign-in dialog — ported behavior-for-behavior from
 * emdash-desktop's `AgentSignInModal.tsx` (read-only reference), rebuilt on
 * this app's own smaller `dialog.tsx` (no `DialogHeader`/`DialogFooter`/
 * `DialogContentArea` here, so the header/content/footer rows are
 * hand-composed inside `DialogContent`, matching `settings-modal.tsx`'s own
 * pattern) and driven by local `open`/`onOpenChange` state instead of
 * emdash's global modal registry (this app has none — see `dialog.tsx`'s
 * own header comment).
 *
 * Correction round (Dylan's screenshots): the terminal wasn't fitting to
 * its host and a stray teal-bordered box floated top-left. Root cause was
 * `renderer/index.css` never importing `@xterm/xterm/css/xterm.css` — see
 * that file's own comment. Fixed here on top of that: the terminal host
 * gets a FIXED, deterministic size (~640×400, width 100%) instead of
 * inheriting whatever height the dialog's flex layout happened to resolve
 * to, and the terminal is constructed with cols/rows already SEEDED to
 * roughly that size (`seedGridDimensions`) instead of emdash's fixed
 * `cols:120,rows:32` — which was sized for that app's own `h-[520px]`
 * modal and is comically large for this one, hence "huge unfitted black
 * area" before the real ResizeObserver-driven resize ever landed.
 *
 * Terminal theme is a fixed dark palette independent of the app's own
 * light/dark theme (a terminal reads as a terminal either way) rather than
 * porting emdash's `--xterm-*` CSS-variable indirection, which this app has
 * no other user for.
 */

const TERMINAL_LINE_HEIGHT = 1.2;
const TERMINAL_LETTER_SPACING = 0;
const TERMINAL_PADDING_PX = 8;
const TERMINAL_FONT_SIZE = 13;
/** The host's own fixed height — deterministic, so the terminal never has to guess a size while the dialog's own layout is still settling. */
const TERMINAL_CONTENT_HEIGHT = 400;
/** Only a SEED for the terminal's construction-time cols/rows, close to the dialog's actual content width (`max-w-2xl` minus padding) — not read from the DOM, so it's available before the host has ever been laid out. The real width (host.clientWidth, measured post-mount) immediately supersedes it via the resize effect below; this just avoids a visible too-big/too-small flash before that first measurement lands. */
const TERMINAL_SEED_WIDTH = 640;

const LOGIN_TERMINAL_THEME: ITerminalOptions['theme'] = {
  background: '#09090b',
  foreground: '#fafafa',
  cursor: '#5fa8a3',
  cursorAccent: '#09090b',
  selectionBackground: 'rgba(95, 168, 163, 0.3)',
  selectionForeground: '#fafafa',
};

/** cols/rows to construct the terminal with, before it has a real mounted host to measure — see `TERMINAL_SEED_WIDTH`'s own comment. Falls back to a classic 80×24 if canvas text measurement is unavailable. */
function seedGridDimensions(): { cols: number; rows: number } {
  const fallback = { cols: 80, rows: 24 };
  const cell = measureTerminalCell(
    buildTerminalFontFamily(),
    TERMINAL_FONT_SIZE,
    TERMINAL_LINE_HEIGHT,
    TERMINAL_LETTER_SPACING
  );
  if (!cell) return fallback;
  const dims = computeGridDimensions({
    widthPx: TERMINAL_SEED_WIDTH,
    heightPx: TERMINAL_CONTENT_HEIGHT,
    cellWidth: cell.width,
    cellHeight: cell.height,
    paddingPx: TERMINAL_PADDING_PX,
  });
  return dims ?? fallback;
}

/**
 * Wraps the real xterm `Terminal` so the FIRST `write`/`reset` call (i.e.
 * the first byte of real CLI output, whether from the login replica's
 * initial snapshot or a live append) flips the dialog out of its "Starting
 * {agent}…" state — never the mere existence of a binding, which can be
 * ready before the CLI has actually printed anything. Only `reset`/`write`
 * are forwarded, matching exactly what `createXtermLogSink` (inside
 * `AcpAuthLoginBinding`) ever calls on the object it's given.
 */
function trackFirstOutput(terminal: Terminal, onOutput: () => void): Pick<Terminal, 'reset' | 'write'> {
  let seen = false;
  const mark = () => {
    if (seen) return;
    seen = true;
    onOutput();
  };
  return {
    reset: () => {
      mark();
      terminal.reset();
    },
    write: (data, callback) => {
      mark();
      terminal.write(data, callback);
    },
  };
}

/** `event.button` is `undefined` for a synthetic/keyboard activation, `0` for the primary mouse button — anything else (right/middle click) should not trigger a link open. */
function isPrimaryMouseButton(event: MouseEvent): boolean {
  return event.button === undefined || event.button === 0;
}

const HTTP_URL_PATTERN = /^https?:\/\//i;

/**
 * Opens a login URL in the system browser directly — never through a
 * confirm-first wrapper. This app's `confirmOpenExternalLink` already is a
 * direct passthrough (no confirm step, no competing modal system — see its
 * own header comment), so unlike emdash there is no real risk of a second
 * modal unmounting this dialog mid-login; this still calls `rpc.app.openExternal`
 * directly rather than importing that helper, to make the "no ceremony
 * here, the URL is already visible in the banner" reasoning local and
 * explicit rather than relying on a shared helper staying that way.
 */
function openLoginUrl(url: string): void {
  const trimmed = url.trim();
  if (!HTTP_URL_PATTERN.test(trimmed)) return;
  void rpc.app.openExternal(trimmed).catch(() => {});
}

/** The sign-in URL the agent printed, with copy + open kept inside this dialog. */
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
    <div className="border-border-hairline mx-4 mt-4 flex flex-col gap-2 rounded-control border p-3">
      <p className="text-text-muted text-xs">
        Finish signing in in your browser. If you&apos;re given a code, come back and paste it into
        the terminal below.
      </p>
      <code className="text-text-muted truncate font-mono text-xs" title={url}>
        {url}
      </code>
      <div className="flex gap-2">
        <Button size="sm" onClick={() => openLoginUrl(url)}>
          <ExternalLink className="size-3.5" strokeWidth={1.5} />
          Open in Browser
        </Button>
        <Button size="sm" variant="outline" onClick={copy}>
          {copied ? <Check className="size-3.5" strokeWidth={1.5} /> : <Copy className="size-3.5" strokeWidth={1.5} />}
          {copied ? 'Copied' : 'Copy link'}
        </Button>
      </div>
    </div>
  );
}

/** Trailing pattern this text-only regex-anchor matches: `errorMessage`'s own `"Sign-in failed (<type>)"` format for an `AgentConfigError` with no human message — everything else (a genuine `Error.message`) has no reason to end in a bare parenthesized code and just renders plainly. */
const CODE_SUFFIX_PATTERN = /^(.*?)\s*\(([^()]+)\)$/;

/** D3 fix: an internal error code (e.g. `provider_not_supported`) landing bare in the dialog read as an unexplained crash. `errorMessage` (in `auth-login-binding.ts`) now always wraps that case in a sentence; this splits the parenthesized code back out to render it as a quiet, muted mono aside rather than part of the sentence itself. */
function SignInErrorMessage({ text }: { text: string }) {
  const match = CODE_SUFFIX_PATTERN.exec(text);
  if (!match) return <>{text}</>;
  return (
    <>
      {match[1]} <code className="text-text-muted font-mono text-xs">({match[2]})</code>
    </>
  );
}

export type AgentSignInDialogProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  providerId: string;
  methodId: string;
  providerName: string;
  /** Fires once the CLI reports `authenticated` — never fires on cancel/close. */
  onSuccess: () => void;
};

export function AgentSignInDialog({
  open,
  onOpenChange,
  providerId,
  methodId,
  providerName,
  onSuccess,
}: AgentSignInDialogProps) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      {/*
       * Opened from a row INSIDE the Settings modal (or the onboarding
       * agents step) — Settings stays open underneath rather than closing
       * itself first: base-ui's `Dialog.Root` explicitly supports nested
       * Roots (`hasNestedDialogOpen` on `Popup`), and reopening Settings
       * after every sign-in would be its own bit of ceremony to explain.
       * Two REAL fixes are needed to make that nesting read as one clean
       * stack rather than "ambiguous layering," though: `backdropClassName`
       * makes this dialog's own backdrop transparent (Settings' own
       * opaque one already dims the whole screen — two overlapping 30%
       * backdrops would double-darken it), and `z-[60]` puts this popup
       * unambiguously above Settings' `z-50` one instead of relying on
       * DOM-append-order tie-breaking.
       */}
      <DialogContent className="z-[60] max-w-2xl" backdropClassName="z-[55] bg-transparent">
        {open && (
          <AgentSignInDialogBody
            providerId={providerId}
            methodId={methodId}
            providerName={providerName}
            onSuccess={onSuccess}
            onClose={() => onOpenChange(false)}
          />
        )}
      </DialogContent>
    </Dialog>
  );
}

/**
 * Split from `AgentSignInDialog` so the terminal/binding lifecycle
 * (`useEffect` below) only ever runs while the dialog is genuinely open —
 * `open && (...)` above unmounts this on close exactly the way emdash's
 * modal host unmounts `AgentSignInModal`, which is what the cleanup effect
 * relies on to call `binding.dispose()` (and, by default, `cancelLogin`).
 */
function AgentSignInDialogBody({
  providerId,
  methodId,
  providerName,
  onSuccess,
  onClose,
}: {
  providerId: string;
  methodId: string;
  providerName: string;
  onSuccess: () => void;
  onClose: () => void;
}) {
  const [error, setError] = useState<string | null>(null);
  const [ready, setReady] = useState(false);
  const [hasOutput, setHasOutput] = useState(false);
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
    const scheduleResize = () => {
      if (animationFrame !== null) cancelAnimationFrame(animationFrame);
      animationFrame = requestAnimationFrame(resize);
    };
    const observer = new ResizeObserver(scheduleResize);
    observer.observe(host);
    // Deliberately NOT a synchronous `resize()` here: the host may still be
    // 0×0 for the very first effect tick (a dialog animating open, or just
    // not yet laid out), and `computeGridDimensions` would silently no-op
    // on that — leaving the terminal at its (already close, thanks to
    // `seedGridDimensions`) construction-time size until the FIRST real
    // ResizeObserver callback lands, which `scheduleResize` handles the
    // same way as every subsequent resize.
    scheduleResize();

    const trackedTerminal = trackFirstOutput(terminal, () => setHasOutput(true));
    void AcpAuthLoginBinding.create({ providerId, methodId, terminal: trackedTerminal }).then(
      (binding) => {
        if (disposed) {
          binding.dispose();
          return;
        }
        bindingRef.current = binding;
        setReady(true);
        scheduleResize();
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
        setPendingUrl(nextUrl.url);
        binding.markUrlHandled(nextUrl.id);
      },
      { fireImmediately: true }
    );
  }, [onSuccess, ready]);

  return (
    <>
      <div className="flex shrink-0 items-center justify-between px-4 py-3">
        <DialogTitle>Sign in to {providerName}</DialogTitle>
        <DialogClose />
      </div>
      {/*
       * `min-h-0` + `overflow-y-auto` (rather than emdash's fixed
       * `h-[480px]`, which fought `DialogContent`'s own
       * `max-h-[calc(100dvh-4rem)]` on a short viewport and could push the
       * dialog past the window edge — Dylan's screenshot): this section
       * now sizes to its own content (banner + the terminal's fixed
       * `TERMINAL_CONTENT_HEIGHT` + margins) on a tall viewport, and
       * genuinely SHRINKS — scrolling internally rather than overflowing —
       * on a short one.
       */}
      <div className="flex min-h-0 flex-1 flex-col overflow-y-auto">
        {pendingUrl && <LoginUrlBanner url={pendingUrl} />}
        <div className="relative m-4" style={{ height: TERMINAL_CONTENT_HEIGHT }}>
          <div ref={terminalHostRef} className="border-border-hairline h-full w-full rounded-control border" />
          {!hasOutput && !error && (
            <div className="bg-bg-1/80 text-text-muted absolute inset-0 flex items-center justify-center gap-2 text-sm">
              <Loader2 className="size-4 animate-spin" strokeWidth={1.5} />
              Starting {providerName}…
            </div>
          )}
          {error && (
            <div className="bg-bg-1 text-danger absolute inset-0 p-4 text-sm">
              <SignInErrorMessage text={error} />
            </div>
          )}
        </div>
      </div>
      <div className="border-border-hairline flex shrink-0 items-center justify-end gap-2 border-t px-4 py-3">
        {/* E fix: ghost, matching create-rig-dialog's own Close/Done convention. */}
        <Button variant="ghost" onClick={onClose}>
          Close
        </Button>
      </div>
    </>
  );
}

function createLoginTerminal(): Terminal {
  const { cols, rows } = seedGridDimensions();
  const terminal = new Terminal({
    cols,
    rows,
    scrollback: 100_000,
    fontFamily: buildTerminalFontFamily(),
    fontSize: TERMINAL_FONT_SIZE,
    lineHeight: TERMINAL_LINE_HEIGHT,
    letterSpacing: TERMINAL_LETTER_SPACING,
    allowProposedApi: true,
    scrollOnUserInput: false,
    // Links open directly in the system browser (see `openLoginUrl`'s own
    // comment) — the URL is visible in the terminal the user is clicking.
    linkHandler: {
      activate: (event, text) => {
        if (!isPrimaryMouseButton(event)) return;
        openLoginUrl(text);
      },
    },
    theme: LOGIN_TERMINAL_THEME,
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
  element.style.backgroundColor = LOGIN_TERMINAL_THEME?.background ?? '#09090b';
}

function resizeLoginTerminal(
  terminal: Terminal,
  host: HTMLElement,
  binding: AcpAuthLoginBinding | null
): void {
  const cell = measureTerminalCell(
    buildTerminalFontFamily(),
    TERMINAL_FONT_SIZE,
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
