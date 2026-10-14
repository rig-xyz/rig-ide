import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { fail, info, step } from './lib/log.ts';
import { resolveReleaseVersion } from './lib/version.ts';

/**
 * The last step of a release: puts the internal notes into the team's
 * feedback space as `releases/<version>.md`, where everyone can open, comment
 * on and ask agents about them, then posts one short message pointing to it.
 * Run it only once the release is live (after finalize-release).
 *
 *   npx tsx scripts/release/post-notes.ts --notes <internal-notes.md> \
 *     --summary "pins land where you put them, comments on code files" \
 *     [--space ~/Rig/clear-harbor] [--model claude-opus-5-5] [--dry-run]
 *
 * The space folder comes from --space, else RIG_FEEDBACK_SPACE_DIR. It must be
 * a synced space on this Mac: the file syncs to members like any other.
 */
const { values } = parseArgs({
  options: {
    notes: { type: 'string' },
    summary: { type: 'string' },
    space: { type: 'string' },
    model: { type: 'string', default: 'claude-opus-5-5' },
    'dry-run': { type: 'boolean', default: false },
  },
  strict: true,
});

const notesPath = values.notes;
if (!notesPath || !existsSync(notesPath)) fail('--notes must point to the internal notes markdown file');
const summary = values.summary?.trim();
if (!summary) fail('--summary is required: one line on what this release brings');
const space = values.space ?? process.env.RIG_FEEDBACK_SPACE_DIR;
if (!space || !existsSync(join(space, 'rig.toml'))) {
  fail('--space or RIG_FEEDBACK_SPACE_DIR must be the feedback space folder on this Mac');
}

const { version } = resolveReleaseVersion('stable');
const rel = `releases/${version}.md`;
const body = readFileSync(notesPath!, 'utf8').trim();
const doc = body.startsWith('#') ? `${body}\n` : `# Rig ${version}: internal notes\n\n${body}\n`;
const message = `Rig ${version} is out: ${summary.replace(/\.$/, '')}. Internal notes: ${rel}`;

step(`Posting the ${version} notes to ${space}`);
if (values['dry-run']) {
  info(`Would write ${rel} (${doc.length} characters)`);
  info(`Would post: ${message}`);
  process.exit(0);
}

const dest = join(space!, rel);
if (existsSync(dest)) fail(`${rel} already exists; this release's notes were posted already`);
mkdirSync(join(space!, 'releases'), { recursive: true });
writeFileSync(dest, doc);
info(`Wrote ${rel}`);

const rig = process.env.RIG_BIN ?? 'rig';
const sent = spawnSync(rig, ['chat', 'send', '--agent', '--model', values.model!, message], {
  cwd: space,
  encoding: 'utf8',
});
if (sent.status !== 0) fail(`rig chat send failed: ${(sent.stderr || sent.stdout || '').trim()}`);
info(`Posted: ${message}`);
