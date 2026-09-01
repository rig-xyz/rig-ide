#!/usr/bin/env node

/**
 * Minimal disposable relay for `--loopback` in run-fresh-user.sh.
 *
 * Reuses the same Tap test scaffold as verify-agent-context-e2e.mjs's manual
 * fixture (disposable Postgres sandbox DB, fake Clerk verifier, in-memory
 * object store) but seeds NOTHING beyond one signed-up user and a minted
 * relay PAT — no workspace, no binding, no documents, no comments. The
 * fresh-user harness seeds nothing on the rig-desktop side either; a real
 * "create first rig" / "sign up" journey happens against this relay exactly
 * like it would against the hosted one.
 *
 * Run with Tap's own tsx runtime so its TypeScript modules load without
 * publishing a package first (same requirement as the manual fixture):
 *
 *   TAP_CONTEXT_ROOT=/path/to/tap \
 *     /path/to/tap/packages/relay/node_modules/.bin/tsx \
 *     scripts/run-fresh-user-loopback-relay.mjs --info-file /tmp/x/loopback.json
 *
 * Prints nothing to stdout until ready, then writes `{ relayUrl, token,
 * userId }` to --info-file and logs a one-line "ready" marker. Stays alive
 * until SIGINT/SIGTERM, then tears down the sandbox DB and HTTP server.
 */

import assert from 'node:assert/strict';
import { once } from 'node:events';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, '../../..');
const tapRoot = path.resolve(
  process.env.TAP_CONTEXT_ROOT || path.join(repoRoot, '../tap-doc-context')
);

const infoFileFlagIndex = process.argv.indexOf('--info-file');
const infoFile = infoFileFlagIndex !== -1 ? process.argv[infoFileFlagIndex + 1] : null;
if (!infoFile) {
  throw new Error('Usage: run-fresh-user-loopback-relay.mjs --info-file <path>');
}

function moduleUrl(root, relativePath) {
  return pathToFileURL(path.join(root, relativePath)).href;
}

async function main() {
  const [{ createApp }, sandboxModule, authModule, honoServer] = await Promise.all([
    import(moduleUrl(tapRoot, 'packages/relay/src/app.ts')),
    import(moduleUrl(tapRoot, 'packages/relay/tests/_sandbox.ts')),
    import(moduleUrl(tapRoot, 'packages/relay/tests/_test-auth.ts')),
    import(moduleUrl(tapRoot, 'packages/relay/node_modules/@hono/node-server/dist/index.mjs')),
  ]);
  const { createSandbox, isPostgresReachable } = sandboxModule;
  const { fakeClerkVerifier, makeTestUser } = authModule;

  if (!(await isPostgresReachable())) {
    throw new Error(
      'Tap Postgres is not reachable. Start its local postgres service before using --loopback.'
    );
  }

  const files = new Map();
  const fakeStorage = {
    bucket: 'fresh-user-loopback',
    async presignPutUrl() {
      return 'http://unused.example/put';
    },
    async presignGetUrl() {
      return 'http://unused.example/get';
    },
    async headObject(key) {
      const value = files.get(key);
      return value ? { size: value.length } : null;
    },
    async getRange(key, options) {
      const value = files.get(key);
      if (!value) throw new Error(`missing fixture object: ${key}`);
      return new Uint8Array(value.subarray(0, options.end + 1));
    },
  };

  const sandbox = await createSandbox('fresh_user_loopback');
  const app = createApp({
    db: sandbox.db,
    clerkVerifier: fakeClerkVerifier(),
    storage: fakeStorage,
  }).app;
  const server = honoServer.serve({ fetch: app.fetch, hostname: '127.0.0.1', port: 0 });
  if (!server.listening) await once(server, 'listening');
  const address = server.address();
  assert(address && typeof address === 'object');
  const relayUrl = `http://127.0.0.1:${address.port}`;

  const user = await makeTestUser(sandbox, {
    clerkId: 'clerk_fresh_user_loopback',
    email: 'fresh-user@example.com',
  });

  const tokenResponse = await app.request('/v1/me/tokens', {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...user.bearer },
    body: JSON.stringify({ label: 'fresh-user-loopback' }),
  });
  assert.equal(tokenResponse.status, 201);
  const token = (await tokenResponse.json()).token;

  await writeFile(infoFile, JSON.stringify({ relayUrl, token, userId: user.id }, null, 2), 'utf8');
  console.log(`Loopback relay ready at ${relayUrl} (user ${user.id}).`);
  console.log('This is a disposable relay: no workspace, binding, or document is seeded.');
  console.log('Press Ctrl-C here (or let the parent launcher do it) to tear it down.');

  let shuttingDown = false;
  const shutdown = async () => {
    if (shuttingDown) return;
    shuttingDown = true;
    await new Promise((resolve) => server.close(resolve));
    await sandbox.cleanup();
    process.exit(0);
  };
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);

  // Keep the event loop alive until a signal arrives.
  await new Promise(() => {});
}

main().catch((error) => {
  console.error(error?.stack || error);
  process.exitCode = 1;
});
