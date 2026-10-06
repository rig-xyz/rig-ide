import { useEffect, useState } from 'react';
import { events, rpc } from '@renderer/lib/ipc';
import { Button } from '@renderer/lib/ui/button';
import { Dialog, DialogClose, DialogContent, DialogTitle } from '@renderer/lib/ui/dialog';
import { Textarea } from '@renderer/lib/ui/textarea';
import { menuReportProblemChannel } from '@shared/events/appEvents';

/**
 * Help › Report a Problem. The person says what happened; Rig sends it to
 * the relay with the bundle listed below (built in main, see
 * `main/rig/problem-report.ts`) and shows the reference to quote. When it
 * can't be sent (offline, signed out, an older server) the same bundle can be
 * saved to a file instead.
 */

const ATTACHED = [
  'The recent app log, with secrets removed',
  'Versions of Rig, the rig command, sync and your agents',
  'Sync status of your open spaces',
  'Your account',
];

type Phase =
  | { kind: 'editing' }
  | { kind: 'sending' }
  | { kind: 'sent'; ref: string }
  | { kind: 'failed'; message: string };

/** Mounted once in `App.tsx`: opens the dialog when the Help menu asks. */
export function ReportProblemDialogHost() {
  const [open, setOpen] = useState(false);
  useEffect(() => events.on(menuReportProblemChannel, () => setOpen(true)), []);
  return <ReportProblemDialog open={open} onOpenChange={setOpen} />;
}

export function ReportProblemDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <div className="flex shrink-0 items-center justify-between px-4 py-3">
          <DialogTitle>Report a problem</DialogTitle>
          <DialogClose />
        </div>
        {/* Remounted per open, so a reopened dialog starts empty. */}
        {open && <ReportProblemForm onClose={() => onOpenChange(false)} />}
      </DialogContent>
    </Dialog>
  );
}

function ReportProblemForm({ onClose }: { onClose: () => void }) {
  const [text, setText] = useState('');
  const [phase, setPhase] = useState<Phase>({ kind: 'editing' });
  const [signedIn, setSignedIn] = useState<boolean | null>(null);
  const [saveNote, setSaveNote] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    let live = true;
    rpc.rig.problemReport
      .status()
      .then((status) => live && setSignedIn(status.signedIn))
      .catch(() => live && setSignedIn(false));
    return () => {
      live = false;
    };
  }, []);

  const send = async () => {
    setPhase({ kind: 'sending' });
    setSaveNote(null);
    try {
      const result = await rpc.rig.problemReport.send({ text });
      if (result.kind === 'sent') setPhase({ kind: 'sent', ref: result.ref });
      else if (result.kind === 'signedOut') {
        setSignedIn(false);
        setPhase({ kind: 'editing' });
      } else setPhase({ kind: 'failed', message: result.message });
    } catch {
      setPhase({ kind: 'failed', message: "Rig couldn't send it." });
    }
  };

  const save = async () => {
    setSaving(true);
    setSaveNote(null);
    try {
      const result = await rpc.rig.problemReport.saveToFile({ text });
      if (result.kind === 'saved') setSaveNote('Saved. Attach the file when you write to us.');
      else if (result.kind === 'failed') setSaveNote(result.message);
    } catch {
      setSaveNote("Couldn't save the file.");
    } finally {
      setSaving(false);
    }
  };

  const copy = async () => {
    if (phase.kind !== 'sent') return;
    const result = await rpc.app.clipboardWriteText(phase.ref).catch(() => null);
    if (result && result.success !== false) setCopied(true);
  };

  if (phase.kind === 'sent') {
    return (
      <div className="flex flex-col gap-3 px-4 pb-4" data-testid="report-problem-sent">
        <p className="text-sm text-text-primary">
          Sent. Your reference is <span className="font-mono">{phase.ref}</span>
        </p>
        <p className="text-xs text-text-muted">Quote it if you write to us about this.</p>
        <div className="flex justify-end gap-2 pt-1">
          <Button variant="ghost" size="sm" onClick={() => void copy()}>
            {copied ? 'Copied' : 'Copy'}
          </Button>
          <Button size="sm" onClick={onClose}>
            Done
          </Button>
        </div>
      </div>
    );
  }

  const sending = phase.kind === 'sending';
  const canSend = signedIn === true && text.trim().length > 0 && !sending;
  const offerSave = signedIn === false || phase.kind === 'failed';

  return (
    <div className="flex flex-col gap-3 px-4 pb-4">
      <label
        className="flex flex-col gap-1.5 text-sm text-text-secondary"
        htmlFor="report-problem-text"
      >
        What happened?
        <Textarea
          id="report-problem-text"
          value={text}
          onChange={(event) => setText(event.target.value)}
          placeholder="What you were doing, and what went wrong"
          className="min-h-24"
          disabled={sending}
          autoFocus
        />
      </label>

      <div className="flex flex-col gap-1 rounded-control border border-border-hairline bg-bg-2 p-2.5">
        <p className="text-xs text-text-secondary">Rig attaches</p>
        <ul className="flex flex-col gap-0.5 text-xs text-text-muted">
          {ATTACHED.map((item) => (
            <li key={item}>{item}</li>
          ))}
        </ul>
        <p className="pt-1 text-xs text-text-muted">Never your files, messages or prompts.</p>
      </div>

      {signedIn === false && (
        <p className="text-xs text-text-secondary" data-testid="report-problem-signed-out">
          Sign in to Rig to send this. You can still save it to a file.
        </p>
      )}
      {phase.kind === 'failed' && (
        <p className="text-xs text-danger" data-testid="report-problem-failed">
          Couldn't send it. {phase.message} You can save it to a file instead.
        </p>
      )}
      {saveNote && <p className="text-xs text-text-secondary">{saveNote}</p>}

      <div className="flex justify-end gap-2 pt-1">
        <Button variant="ghost" size="sm" onClick={onClose} disabled={sending}>
          Cancel
        </Button>
        {offerSave && (
          <Button
            variant="outline"
            size="sm"
            onClick={() => void save()}
            disabled={saving || sending}
          >
            {saving ? 'Saving…' : 'Save to a file'}
          </Button>
        )}
        <Button size="sm" onClick={() => void send()} disabled={!canSend}>
          {sending ? 'Sending…' : phase.kind === 'failed' ? 'Try again' : 'Send'}
        </Button>
      </div>
    </div>
  );
}
