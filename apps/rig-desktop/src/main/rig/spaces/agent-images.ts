import { randomUUID } from 'node:crypto';
import { mkdir, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { nativeImage } from 'electron';
import { ATTACHMENT_IMAGE_CONTENT_MAX_BYTES } from '@shared/rig/attachments';
import { fitImagePlan, type PrepareImage } from './attachment-context';

/**
 * The Electron half of `PrepareImage`: an attached image, shrunk to a long
 * side of 2000 px and at most 5 MB when it has to be, written to a temp file
 * the ACP runtime reads. The space's own file is never changed. Only the
 * boot wiring imports this (it needs Electron).
 */

const MAX_AGE_MS = 24 * 60 * 60 * 1000;

async function clean(dir: string): Promise<void> {
  let names: string[];
  try {
    names = await readdir(dir);
  } catch {
    return;
  }
  const cutoff = Date.now() - MAX_AGE_MS;
  for (const name of names) {
    const path = join(dir, name);
    try {
      if ((await stat(path)).mtimeMs < cutoff) await rm(path, { force: true });
    } catch {
      // raced
    }
  }
}

export function createImagePreparer(tempDir: string): PrepareImage {
  return async (abs, mime) => {
    const bytes = (await stat(abs)).size;
    const image = nativeImage.createFromPath(abs);
    // Not decodable here (e.g. an animated or odd file): send it as is only if it already fits.
    if (image.isEmpty()) return bytes <= ATTACHMENT_IMAGE_CONTENT_MAX_BYTES ? { path: abs, mimeType: mime } : null;
    const { width, height } = image.getSize();
    const plan = fitImagePlan({ width, height, bytes });
    if (plan.kind === 'keep') return { path: abs, mimeType: mime };
    const sized = plan.kind === 'resize' ? image.resize({ width: plan.width, height: plan.height, quality: 'good' }) : image;
    // PNG keeps sharp screenshots sharp; JPEG when PNG is still too big.
    let data = mime === 'image/png' ? sized.toPNG() : sized.toJPEG(85);
    let mimeType: 'image/png' | 'image/jpeg' = mime === 'image/png' ? 'image/png' : 'image/jpeg';
    if (data.length > ATTACHMENT_IMAGE_CONTENT_MAX_BYTES) {
      data = sized.toJPEG(80);
      mimeType = 'image/jpeg';
    }
    if (data.length > ATTACHMENT_IMAGE_CONTENT_MAX_BYTES) data = sized.toJPEG(60);
    if (data.length > ATTACHMENT_IMAGE_CONTENT_MAX_BYTES) return null;
    await mkdir(tempDir, { recursive: true });
    await clean(tempDir);
    const path = join(tempDir, `${randomUUID()}${mimeType === 'image/png' ? '.png' : '.jpg'}`);
    await writeFile(path, data);
    return { path, mimeType };
  };
}
