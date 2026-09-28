import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { MessageAttachment } from '@shared/rig/attachments';
import { AGENT_TAKES_IMAGES, fitImagePlan, imageCandidates, MAX_PROMPT_IMAGES, promptImages } from './attachment-context';

const image = (i: number, mime = 'image/png'): MessageAttachment => ({
  name: `s${i}.png`,
  size: 10,
  mime,
  kind: 'copied',
  path: `attachments/s${i}.png`,
});

describe('fitImagePlan', () => {
  it('keeps small images, shrinks the long side to 2000 px, re-encodes heavy ones', () => {
    expect(fitImagePlan({ width: 1600, height: 900, bytes: 400_000 })).toEqual({ kind: 'keep' });
    expect(fitImagePlan({ width: 8000, height: 5000, bytes: 30_000_000 })).toEqual({ kind: 'resize', width: 2000, height: 1250 });
    expect(fitImagePlan({ width: 1000, height: 4000, bytes: 1 })).toEqual({ kind: 'resize', width: 500, height: 2000 });
    expect(fitImagePlan({ width: 1900, height: 1900, bytes: 6 * 1024 * 1024 })).toEqual({ kind: 'reencode' });
  });
});

describe('imageCandidates', () => {
  const present = (items: MessageAttachment[]) => ({ present: new Map(items.map((a) => [a.path!, `/space/${a.path}`])), missing: [] });

  it('only images here, of a type the runtime takes, at most five', () => {
    const items = [...Array.from({ length: 7 }, (_, i) => image(i)), image(9, 'image/heic')];
    const picked = imageCandidates(items, present(items), 'claude');
    expect(picked).toHaveLength(MAX_PROMPT_IMAGES);
    expect(picked.every((c) => c.attachment.mime === 'image/png')).toBe(true);
    expect(imageCandidates([image(1)], { present: new Map(), missing: [image(1)] }, 'claude')).toEqual([]);
  });

  it('none for an agent whose adapter takes no images', () => {
    const was = AGENT_TAKES_IMAGES.codex;
    AGENT_TAKES_IMAGES.codex = false;
    try {
      expect(imageCandidates([image(1)], present([image(1)]), 'codex')).toEqual([]);
    } finally {
      AGENT_TAKES_IMAGES.codex = was;
    }
  });

  it('drops an image that cannot be made to fit, keeping the rest', async () => {
    const items = [image(1), image(2)];
    const out = await promptImages(imageCandidates(items, present(items), 'claude'), async (abs) =>
      abs.endsWith('s1.png') ? null : { path: `${abs}.jpg`, mimeType: 'image/jpeg' }
    );
    expect(out.images).toEqual([{ path: '/space/attachments/s2.png.jpg', mimeType: 'image/jpeg', name: 's2.png' }]);
    expect([...out.spacePaths]).toEqual(['attachments/s2.png']);
  });
});

describe('the installed ACP adapters', () => {
  // AGENT_TAKES_IMAGES is read from the pinned adapters; a bump that stops advertising image prompts must fail here.
  const require = createRequire(import.meta.url);
  const initializeTakesImages = (pkg: string, file: string) => {
    const source = readFileSync(join(dirname(require.resolve(`${pkg}/package.json`)), file), 'utf8');
    return /promptCapabilities:\s*\{[^}]*image:\s*true/.test(source);
  };

  it('claude-agent-acp and codex-acp both say they take image prompts', () => {
    expect(initializeTakesImages('@agentclientprotocol/claude-agent-acp', 'dist/acp-agent.js')).toBe(AGENT_TAKES_IMAGES.claude);
    expect(initializeTakesImages('@agentclientprotocol/codex-acp', 'dist/index.js')).toBe(AGENT_TAKES_IMAGES.codex);
  });
});
