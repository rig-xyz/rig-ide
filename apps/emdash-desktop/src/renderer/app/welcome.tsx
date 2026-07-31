import { detectPlatform, matchesKeyboardEvent } from '@tanstack/react-hotkeys';
import { motion, type Variants } from 'framer-motion';
import { useCallback, useEffect, useRef, useState } from 'react';
import IconLight from '@/assets/images/rig/rig.png';
import { useAppSettingsKey } from '@renderer/features/settings/use-app-settings-key';
import { getEffectiveHotkey } from '@renderer/lib/hooks/useKeyboardShortcuts';
import { useTheme } from '@renderer/lib/hooks/useTheme';
import { Button } from '@renderer/lib/ui/button';
import { BoundShortcut } from '@renderer/lib/ui/shortcut';

const PLATFORM = detectPlatform();
const SHORTCUT_PRESS_DURATION_MS = 120;

interface WelcomeScreenProps {
  onGetStarted: () => void;
}

export function WelcomeScreen({ onGetStarted }: WelcomeScreenProps) {
  const { effectiveTheme } = useTheme();
  const { value: keyboard } = useAppSettingsKey('keyboard');
  const confirmHotkey = getEffectiveHotkey('confirm', keyboard);
  const [isShortcutPressed, setIsShortcutPressed] = useState(false);
  const shortcutPressTimeoutRef = useRef<number | null>(null);

  const handleGetStarted = useCallback(() => {
    if (shortcutPressTimeoutRef.current !== null) {
      window.clearTimeout(shortcutPressTimeoutRef.current);
      shortcutPressTimeoutRef.current = null;
    }

    setIsShortcutPressed(false);
    onGetStarted();
  }, [onGetStarted]);

  useEffect(() => {
    if (confirmHotkey === null) return;

    const handleKeyDown = (event: KeyboardEvent) => {
      if (!matchesKeyboardEvent(event, confirmHotkey, PLATFORM)) return;

      event.preventDefault();
      event.stopPropagation();
      event.stopImmediatePropagation();

      if (shortcutPressTimeoutRef.current !== null) return;

      setIsShortcutPressed(true);
      shortcutPressTimeoutRef.current = window.setTimeout(() => {
        handleGetStarted();
      }, SHORTCUT_PRESS_DURATION_MS);
    };

    document.addEventListener('keydown', handleKeyDown, { capture: true });
    return () => document.removeEventListener('keydown', handleKeyDown, { capture: true });
  }, [confirmHotkey, handleGetStarted]);

  useEffect(() => {
    return () => {
      if (shortcutPressTimeoutRef.current !== null)
        window.clearTimeout(shortcutPressTimeoutRef.current);
    };
  }, []);

  const containerVariants: Variants = {
    hidden: { opacity: 0 },
    visible: {
      opacity: 1,
      transition: {
        staggerChildren: 0.3,
        delayChildren: 0.7,
      },
    },
  };

  const itemVariants: Variants = {
    hidden: { opacity: 0, y: 20 },
    visible: {
      opacity: 1,
      y: 0,
      transition: {
        duration: 0.9,
        ease: [0.25, 0.1, 0.25, 1] as [number, number, number, number], // Properly typed cubic-bezier
      },
    },
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-background">
      <div className="absolute right-0 bottom-0 left-0 h-3/5">
        {/*
          Was upstream's YouTube channel banner, which carries their wordmark
          burned into the image. It went unnoticed because this screen has been
          unreachable since the upstream sign-in step was removed. A wash gives
          the same visual weight without shipping someone else's branding.
        */}
        <div
          className="absolute inset-0 opacity-40"
          style={{
            backgroundImage:
              'radial-gradient(ellipse 120% 70% at 50% 100%, rgba(125,145,185,0.38) 0%, transparent 65%)',
            maskImage:
              'linear-gradient(to bottom, transparent 0%, transparent 30%, rgba(0,0,0,0.4) 60%, rgba(0,0,0,0.8) 100%)',
            WebkitMaskImage:
              'linear-gradient(to bottom, transparent 0%, transparent 30%, rgba(0,0,0,0.4) 60%, rgba(0,0,0,0.8) 100%)',
          }}
        />
      </div>

      <motion.div
        className="relative z-10 flex flex-col items-center justify-center space-y-4 p-8"
        variants={containerVariants}
        initial="hidden"
        animate="visible"
      >
        {/*
          The mark, unboxed — the icon is already a dark squircle, so it sits
          directly on the backdrop with a hairline ring and a slow metallic
          sheen sweeping across it. overflow-hidden clips the sheen to the
          squircle; the skewed gradient strip is what reads as "shine".
        */}
        <motion.div
          className="relative overflow-hidden rounded-xl shadow-lg shadow-black/40 ring-1 ring-white/15"
          variants={itemVariants}
        >
          <img src={IconLight} alt="Rig" className="block h-16 w-16" />
          <motion.div
            aria-hidden
            className="pointer-events-none absolute inset-y-0 left-0 w-1/2 -skew-x-12 bg-gradient-to-r from-transparent via-white/30 to-transparent"
            initial={{ x: '-150%' }}
            animate={{ x: '300%' }}
            transition={{
              repeat: Infinity,
              duration: 1.6,
              ease: 'easeInOut',
              repeatDelay: 2.6,
              delay: 0.8,
            }}
          />
        </motion.div>

        <motion.h1
          className="text-lg font-semibold tracking-tight text-foreground"
          variants={itemVariants}
        >
          Welcome.
        </motion.h1>

        <motion.div
          variants={itemVariants}
          whileHover={{ scale: 1.02 }}
          whileTap={{ scale: 0.97 }}
          transition={{ duration: 0.1, ease: 'easeInOut' }}
        >
          <div
            className={`transition-transform duration-100 ease-in-out ${
              isShortcutPressed ? 'scale-[0.97]' : ''
            }`}
          >
            <Button
              onClick={handleGetStarted}
              size="sm"
              className={
                effectiveTheme === 'emdark' ? 'bg-gray-200 text-gray-900 hover:bg-gray-300' : ''
              }
            >
              <span className="flex items-center gap-2">
                Start shipping
                <BoundShortcut settingsKey="confirm" variant="keycaps" />
              </span>
            </Button>
          </div>
        </motion.div>
      </motion.div>
    </div>
  );
}
