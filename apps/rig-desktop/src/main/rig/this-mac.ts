import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { hostname } from 'node:os';
import { dirname, join } from 'node:path';
import { app } from 'electron';

/**
 * Which of a person's computers this is, for the relay: one Rig account
 * can be signed in on several Macs. `thisMacId` is a random id made once
 * per install and kept in userData, so it says nothing about the computer;
 * `thisMacName` is what the person called the Mac ("Dylan's MacBook Pro"),
 * used to label the devices this Mac adds to a space.
 */

let cachedId: string | null = null;

export function thisMacId(): string {
  if (cachedId) return cachedId;
  const file = join(app.getPath('userData'), 'this-mac.json');
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8')) as { id?: unknown };
    if (typeof parsed.id === 'string' && parsed.id) return (cachedId = parsed.id);
  } catch {
    // First launch, or an unreadable file: make a new one.
  }
  const id = randomUUID();
  try {
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, JSON.stringify({ id }) + '\n');
  } catch {
    // Still usable for this run.
  }
  return (cachedId = id);
}

let cachedName: Promise<string> | null = null;

/** The Mac's name from System Settings › General › About, or its host name. */
export function thisMacName(): Promise<string> {
  cachedName ??= new Promise((resolve) => {
    const fallback = () => hostname().replace(/\.local$/i, '') || 'Mac';
    execFile('/usr/sbin/scutil', ['--get', 'ComputerName'], { timeout: 2000 }, (error, stdout) => {
      const name = String(stdout ?? '').trim();
      resolve(!error && name ? name.slice(0, 64) : fallback());
    });
  });
  return cachedName;
}
