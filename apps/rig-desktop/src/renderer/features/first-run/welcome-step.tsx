import { Activity, Check, CircleDot, Loader2, Play, type LucideIcon } from 'lucide-react';
import { useEffect } from 'react';
import { ActionButton } from '@renderer/features/home-feed/action-button';
import { RigMark } from '@renderer/lib/ui/rig-mark';
import type { RigAccountState } from './env';
import { StepFrame, type StepProps } from './first-run';

const PROMISES: { icon: LucideIcon; title: string; body: string }[] = [
  {
    icon: CircleDot,
    title: 'Built on your Claude',
    body: 'Rig works through the Claude you already use, and every tool it’s connected to.',
  },
  {
    icon: Check,
    title: 'Does the work, not the list',
    body: 'It drafts the reply, the review, the fix. You decide.',
  },
  {
    icon: Activity,
    title: 'Sharper every day',
    body: 'It learns what matters to you from what you send, change and skip.',
  },
];

/** The first name to greet a returning person by, when the account has one. */
function firstName(rig: RigAccountState): string | null {
  if (rig.kind !== 'signedIn') return null;
  return rig.name?.trim().split(/\s+/)[0] || null;
}

/** Step 1: one promise over the agent field, and Get started. Returning users meet their new Home. */
export function WelcomeStep({ env, plan, onNext, advancing, setFieldLook }: StepProps) {
  useEffect(() => setFieldLook('hero'), [setFieldLook]);
  const back = plan?.returning ?? env.user.hasSeenOnboarding;
  const name = firstName(env.rig);

  return (
    <StepFrame
      guide={
        <>
          <span className="fr-in font-mono text-2xs tracking-[0.09em] text-text-muted uppercase">
            {back ? 'New in Rig' : 'Welcome to Rig'}
          </span>
          <h1
            className="fr-in m-0 font-display text-2xl leading-[1.15] font-semibold tracking-[-0.015em] text-balance text-text-primary"
            style={{ animationDelay: '80ms' }}
          >
            {back
              ? `Welcome back${name ? `, ${name}` : ''}. Meet your new Home.`
              : 'Let’s give you your mornings back.'}
          </h1>
          <p
            className="fr-in m-0 text-chat leading-[1.55] text-text-secondary"
            style={{ animationDelay: '160ms' }}
          >
            {back
              ? 'Rig now keeps up with your tools and gets work ready before you ask. Your spaces stay exactly as they are.'
              : 'Rig is your Claude, working ahead of you. It keeps up with your tools and gets things ready while you’re busy with everything else.'}
          </p>
          <div className="flex flex-col gap-3 pt-1">
            {PROMISES.map(({ icon: Icon, title, body }, k) => (
              <div
                key={title}
                className="fr-in grid grid-cols-[30px_minmax(0,1fr)] items-start gap-[11px]"
                style={{ animationDelay: `${300 + k * 100}ms` }}
              >
                <span className="fr-glass size-[30px] rounded-[10px] text-accent">
                  <Icon className="size-[15px]" strokeWidth={1.8} />
                </span>
                <div>
                  <b className="block text-sm font-medium text-text-primary">{title}</b>
                  <span className="text-sm text-text-secondary">{body}</span>
                </div>
              </div>
            ))}
          </div>
          <div className="flex-1" />
          <div
            className="fr-in flex flex-wrap items-center gap-2.5"
            style={{ animationDelay: '700ms' }}
          >
            <ActionButton
              variant="primary"
              icon={advancing ? Loader2 : Play}
              onClick={onNext}
              disabled={advancing}
              data-testid="first-run-get-started"
            >
              Get started
            </ActionButton>
            <span className="text-meta text-text-muted">
              {advancing ? 'Checking this Mac…' : back ? 'About 2 minutes' : 'About 3 minutes'}
            </span>
          </div>
        </>
      }
      stage={
        <div
          className="fr-in flex flex-col items-center gap-[22px] text-center"
          style={{ animationDuration: '800ms' }}
        >
          <span className="fr-glass fr-hero-mark size-16 rounded-[20px]">
            <RigMark size={30} />
          </span>
          <h2 className="m-0 max-w-[18ch] font-display text-[clamp(30px,4.2vw,46px)] leading-[1.08] font-semibold tracking-[-0.025em] text-balance text-text-primary">
            Your Claude, <span className="fr-hero-fade">working ahead of you.</span>
          </h2>
        </div>
      }
    />
  );
}
