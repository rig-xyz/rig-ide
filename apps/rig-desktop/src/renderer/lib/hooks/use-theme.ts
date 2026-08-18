import { useEffect, useState } from 'react';

export type Theme = 'dark' | 'light';

function readTheme(): Theme {
  const attr = document.documentElement.getAttribute('data-theme');
  if (attr === 'light' || attr === 'dark') return attr;
  return window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
}

/**
 * The live theme, read off `<html data-theme>` — the attribute `App`'s own
 * toggle writes (and persists to localStorage) — falling back to the OS
 * preference when no override is set yet.
 *
 * `App` remains the sole writer; this is a read-only mirror via
 * `MutationObserver` for components that need to pick a light/dark asset
 * (e.g. `AgentIcon`) without theme being threaded through props from the top.
 */
export function useTheme(): Theme {
  const [theme, setTheme] = useState<Theme>(readTheme);

  useEffect(() => {
    const observer = new MutationObserver(() => setTheme(readTheme()));
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['data-theme'],
    });
    return () => observer.disconnect();
  }, []);

  return theme;
}
