import { appendFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';
import { Octokit } from '@octokit/rest';
import { adapterStatuses, isNewer } from './lib/agent-adapters.ts';
import { GITHUB_OWNER, GITHUB_REPO } from './lib/config.ts';
import { fail, info, step, warn } from './lib/log.ts';
import { resolveReleaseVersion } from './lib/version.ts';
import type { ReleaseChannel } from './lib/version.ts';

const { values } = parseArgs({
  options: {
    channel: { type: 'string', default: 'stable' },
  },
  strict: true,
});

const channel = (values.channel ?? 'stable') as ReleaseChannel;
if (!['stable', 'canary'].includes(channel)) {
  fail(`Unknown channel "${channel}"; must be "stable" or "canary"`);
}

const token = process.env.GH_TOKEN;
if (!token) fail('GH_TOKEN env var is required');

// Agent adapters with a newer release: listed, never blocking (see lib/agent-adapters.ts).
step('Checking the Claude and Codex agent adapters');
for (const { name, pinned, latest } of await adapterStatuses(fileURLToPath(new URL('../../../../', import.meta.url)))) {
  if (latest === null) info(`${name} ${pinned} (npm not reachable, not checked)`);
  else if (isNewer(latest, pinned)) warn(`${name} ${pinned} ships, ${latest} is out. Bump it in its own change, not mid-release.`);
  else info(`${name} ${pinned} is the latest`);
}

const { tag, isCanary } = resolveReleaseVersion(channel);
const octokit = new Octokit({ auth: token });

step(`Ensuring single draft release for ${tag} (channel: ${channel})`);

const { data: releases } = await octokit.rest.repos.listReleases({
  owner: GITHUB_OWNER,
  repo: GITHUB_REPO,
  per_page: 100,
});

const sameTag = releases.filter((r) => r.tag_name === tag);
if (sameTag.some((r) => !r.draft)) {
  fail(
    `A published release already exists for ${tag}; aborting to avoid overwriting a shipped release`
  );
}

const drafts = sameTag.filter((r) => r.draft);
if (drafts.length > 1) {
  const ids = drafts.map((r) => r.id).join(', ');
  fail(
    `Multiple draft releases already exist for ${tag} (ids: ${ids}); clean them up before re-running`
  );
}

let releaseId: number;
if (drafts.length === 1) {
  releaseId = drafts[0].id;
  info(`Reusing existing draft release ${tag} (id: ${releaseId})`);
} else {
  const sha = process.env.GITHUB_SHA;
  const { data } = await octokit.rest.repos.createRelease({
    owner: GITHUB_OWNER,
    repo: GITHUB_REPO,
    tag_name: tag,
    name: tag,
    draft: true,
    prerelease: isCanary,
    ...(sha ? { target_commitish: sha } : {}),
  });
  releaseId = data.id;
  info(`Created draft release ${tag} (id: ${releaseId})`);
}

// Emit the release id to GITHUB_OUTPUT for observability in downstream steps.
const outputFile = process.env.GITHUB_OUTPUT;
if (outputFile) {
  appendFileSync(outputFile, `release_id=${releaseId}\n`);
}
