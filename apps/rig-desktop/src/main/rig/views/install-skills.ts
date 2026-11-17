import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { log } from '@main/lib/logger';

/**
 * The skills that teach a space's agent to build views and standing work (spike, Rig Alpha). They
 * ship with the app and are written beside the rig skill, in the member's own skill folders
 * (`~/.claude/skills`, `~/.agents/skills` for Codex), never into a space: a space's own skill
 * folders are owner-only, and these must reach every member's agent whoever owns the space.
 *
 * Written when Alpha is on, and rewritten only when the app's copy differs, so a newer app
 * replaces an older skill and nothing else is touched.
 */
/** Every file of every bundled skill, by its path under the skills folder (`rig-views/design.md`), as text. */
export const VIEW_SKILL_FILES: Record<string, string> = Object.fromEntries(
  Object.entries(
    import.meta.glob<string>('./skills/**/*', { query: '?raw', import: 'default', eager: true })
  ).map(([path, text]) => [path.replace(/^\.\/skills\//, ''), text])
);

const SKILL_HOMES = ['.claude/skills', '.agents/skills'];

export async function installViewSkills(home = homedir()): Promise<void> {
  for (const root of SKILL_HOMES) {
    for (const [path, text] of Object.entries(VIEW_SKILL_FILES)) {
      const file = join(home, root, path);
      try {
        if ((await readFile(file, 'utf8').catch(() => null)) === text) continue;
        await mkdir(dirname(file), { recursive: true });
        await writeFile(file, text);
      } catch (error) {
        log.warn('Rig views: could not write a skill file', { path, root, error: String(error) });
      }
    }
  }
}
