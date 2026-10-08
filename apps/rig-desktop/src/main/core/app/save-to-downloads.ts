import { constants } from 'node:fs';
import { copyFile, cp, stat } from 'node:fs/promises';
import { basename, join } from 'node:path';

/**
 * The name a copy takes in Downloads: the file's own, else with " 2", " 3"…
 * before the extension ("report 2.pdf"). A name that starts with its only
 * dot (".env") has no extension, so the number goes at the end.
 */
export function downloadsName(name: string, attempt: number): string {
  if (attempt <= 1) return name;
  const dot = name.lastIndexOf('.');
  if (dot <= 0) return `${name} ${attempt}`;
  return `${name.slice(0, dot)} ${attempt}${name.slice(dot)}`;
}

const MAX_ATTEMPTS = 1000;

/**
 * Copies a file (or a folder) into `downloadsDir` under the first free name
 * (`downloadsName`), never over something already there. Returns the copy's
 * path.
 */
export async function copyToDownloads(source: string, downloadsDir: string): Promise<string> {
  const name = basename(source);
  const isDir = (await stat(source)).isDirectory();
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const dest = join(downloadsDir, downloadsName(name, attempt));
    try {
      if (isDir) {
        // cp has no exclusive mode for a folder: look first.
        if (await stat(dest).then(() => true, () => false)) continue;
        await cp(source, dest, { recursive: true, errorOnExist: true, force: false });
      } else {
        await copyFile(source, dest, constants.COPYFILE_EXCL);
      }
      return dest;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST' || (error as NodeJS.ErrnoException).code === 'ERR_FS_CP_EEXIST') continue;
      throw error;
    }
  }
  throw new Error(`Downloads already has too many copies of ${name}.`);
}
