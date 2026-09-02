# rig-desktop release runbook

Manual procedure for shipping a stable rig-desktop release. There is no working
CI release pipeline for this app (see **Known infra debt** below) — every
release to date, including 0.3.3 (currently live), was produced by running the
scripts under `scripts/release/` by hand, in order, from a machine with the
right local tooling and credentials.

This assumes a `feat/doc-context`-style change has already landed on `main`
and the version bumps for this release are already committed (CLI, relay, and
this app's `package.json` / `RIG_CLI_VERSION` pin).

## Known infra debt

Read this before touching CI. None of it blocks the manual path below, but it
explains why the manual path is the only path, and where the sharp edges are.

**(a) CI workflows still target `apps/emdash-desktop`, not `apps/rig-desktop`.**
`.github/workflows/release-prod.yml`, `.github/workflows/release-canary.yml`,
and `.github/actions/upload-r2/action.yml` all still have
`working-directory: apps/emdash-desktop` on every job step. `apps/emdash-desktop`
is stale fork residue — a leftover copy of the app this repo was forked from —
still checked into this monorepo. Running these workflows today builds and
(if it got far enough) publishes *that* app, not rig-desktop. They have not
been repointed at `apps/rig-desktop`. Until someone does that repointing (and
re-verifies every step against `apps/rig-desktop`'s scripts, which have
diverged — see (c)), treat these workflows as non-functional for rig-desktop
and use the manual scripts below, which are the scripts that actually
produced every rig-desktop release so far, including 0.3.3.

**(b) The canary channel is broken and still branded Emdash — do not use it.**
`electron-builder.canary.config.ts` reads identity from
`src/shared/app-identity.canary.ts`, which hasn't been updated to match the
stable identity file: `APP_NAME_LOWER` is `'emdash-canary'`, and the config
itself still points `publish` at
`{ provider: 'github', owner: 'generalaction', repo: 'emdash' }` — someone
else's repo, not `rig-xyz/rig-ide`. It also carries an `NSMicrophoneUsageDescription`
of *"Emdash needs microphone access for voice dictation and voice mode
features"* (a feature this app doesn't have, and a permission prompt the
stable config deliberately removed), Emdash icon assets
(`src/assets/images/emdash/...`), and Windows `azureSignOptions` naming
`'General Action, Inc.'` / signing account `'emdash'`. None of this is
rig-branded or points at our infrastructure. Do not run a canary build or
`package:mac`-style canary packaging until this file is brought in line with
`app-identity.ts` and `electron-builder.config.ts`.

**(c) `apps/emdash-desktop` and `apps/rig-desktop` publish to the exact same
R2 location — never let the former ship there.** Both apps' stable
`app-identity.ts` set `R2_BASE_URL = 'https://dl.userig.xyz'`,
`UPDATE_CHANNEL = 'v1-stable'`, and `ARTIFACT_PREFIX = 'rig'` — byte-identical.
If the CI workflows in (a) were ever run to completion as they stand today,
`apps/emdash-desktop`'s build would upload `rig-<version>-arm64.dmg` and
`v1-stable-mac.yml` to the same bucket keys rig-desktop uses, silently
overwriting the real release and pointing every installed rig-desktop at
whatever `emdash-desktop` happens to be. This is the concrete failure mode
behind (a)'s "don't run these workflows" advice — it isn't just that they'd
build the wrong app, it's that publishing from the wrong app can clobber the
right one's live update feed.

**(d) The CLI version pin has no automated tie to the CLI repo.**
`scripts/vendor-rig-cli.ts` hardcodes `RIG_CLI_VERSION` (and `TAPD_VERSION`)
as literal strings. Nothing checks that pin against `@rigxyz/cli`'s actual
published `package.json` version, and nothing fails a build if the CLI repo
ships a feature commit without a matching npm publish + pin bump here — the
build just silently vendors whatever version the pin says, which may predate
the feature this release is meant to include. (This is exactly the situation
this release started from: the CLI repo's `package.json` still said `0.12.0`
after a feature commit landed, and `0.12.0` was already on npm *without* that
feature.) Until this is wired up, bumping `RIG_CLI_VERSION` here has to be a
deliberate, manual step done in lockstep with the CLI's own version bump and
publish — never assume the pin is current.

## Release order

The four pieces ship in this order because each later step depends on the
previous one being live: the desktop's vendored CLI must be the version that
was actually published, and the CLI's relay calls must be hitting relay
routes that already exist on the deployed relay.

1. Publish the CLI to npm.
2. Deploy the relay.
3. Build, sign, notarize, and publish the desktop app (this doc's main
   subject).
4. (Optional, cosmetic) Bump the hub's fallback version string.

### 1. Publish the CLI

- **Command:** `npm publish`
- **Working directory:** CLI repo root (`rig-doc-context`)
- **Auth:** npm auth for the `@rigxyz` org (npm login / `NPM_TOKEN`, whatever
  this operator's npm auth is already configured as — no npm-specific secret
  name is wired into this repo's scripts)
- **Verify:** `npm view @rigxyz/cli version` returns the version just
  published

### 2. Deploy the relay

- **Command:** `fly deploy`
- **Working directory:** relay repo root (`tap-doc-context`) — `fly.toml`
  there points the app at `tap-relay`, region `iad`; secrets are already set
  on the app, and `[deploy].release_command` runs migrations automatically
  before the new release goes live, so no separate migration step is needed
- **Auth:** Fly auth for an identity with deploy rights on the `tap-relay`
  app (`fly auth login` / `FLY_API_TOKEN`)
- **Verify:**
  - `fly status -a tap-relay` shows the new release healthy
  - `curl https://tap-relay.fly.dev/healthz` returns 200 (matches the
    `http_service.checks` health check in `fly.toml`)
  - Smoke the new context routes the CLI's `rig context trace`/`read` depend
    on (`GET /v1/me/bindings/:bindingId/provenance`,
    `GET /v1/me/bindings/:bindingId/intents/:intentId`,
    `GET /v1/me/bindings/:bindingId/messages` in
    `packages/relay/src/routes/account.ts`) — an unauthenticated request
    against any of them should come back `401`, not `404`; a `404` means the
    route isn't mounted on the deployed build. Better still, run
    `rig context trace --target <ref> --json` from a real workspace bound to
    this relay and confirm it resolves instead of erroring.

### 3. Build, sign, notarize, and publish rig-desktop

All commands run from `apps/rig-desktop/` unless noted otherwise. Use the
manual scripts, not the CI workflows (see infra debt (a)).

**3.1 — Bump the vendored CLI pin.** Already done for this release:
`RIG_CLI_VERSION` in `scripts/vendor-rig-cli.ts` bumped to `0.13.0`
(`TAPD_VERSION` unchanged at `0.6.3`). This must happen *after* step 1's
`npm publish` succeeds — the pin names a version that has to already exist on
npm, or the next sub-step fails outright.

**3.2 — Vendor the CLI.**
- **Command:** `pnpm run vendor:rig-cli`
- **Working directory:** `apps/rig-desktop`
- **Auth:** none (public npm registry read)
- **Verify:** the script itself is self-verifying and fails loudly on
  mismatch — it prints `vendor-rig-cli: OK — rig --version -> 0.13.0` and
  `vendor-rig-cli: OK — tapd --version -> 0.6.3` on success, running the
  actual vendored binaries rather than trusting `package.json` alone. Do not
  run this yet if 0.13.0 isn't on npm — it will fail with "npm install
  failed for @rigxyz/cli@0.13.0" and name the pin as the likely cause.

**3.3 — Commit the version bump.** `package.json` version is already bumped
to `0.4.0` for this release.
- **Command:**
  ```
  git add apps/rig-desktop/package.json apps/rig-desktop/scripts/vendor-rig-cli.ts
  git commit -m "chore(rig-desktop): bump version to 0.4.0"
  ```
- **Working directory:** repo root (`rigdash`)
- Follows the single-line-subject-plus-trailer shape of commit `443b2119f`
  (`chore(rig-desktop): bump version to 0.3.2`).
- **Verify:** `git log -1 --stat` shows just the two files changed.

**3.4 — Create the draft GitHub release.**
- **Command:** `GH_TOKEN=<token> node --experimental-strip-types scripts/release/prepare-release.ts --channel stable`
- **Working directory:** `apps/rig-desktop`
- **Auth:** `GH_TOKEN` — needs `contents: write` on `rig-xyz/rig-ide`
  (`GITHUB_OWNER`/`GITHUB_REPO` in `scripts/release/lib/config.ts`); the
  release tag is derived from `package.json`'s version as `v0.4.0`
  (`resolveReleaseVersion` in `scripts/release/lib/version.ts`)
- **Verify:** `gh release view v0.4.0 --repo rig-xyz/rig-ide` shows a draft
  release exists (the script itself fails if a *published* `v0.4.0` already
  exists, or if more than one draft for that tag exists — clean those up
  first if so)

**3.5 — Build, sign (mac, arm64, stable).**
- **Command:** `GH_TOKEN=<token> node --experimental-strip-types scripts/release/build.ts --platform mac --arch arm64 --channel stable`
- **Working directory:** `apps/rig-desktop`
- **Auth:**
  - A `Developer ID Application` certificate + private key in the local
    keychain (electron-builder's mac signing auto-discovers it; no env var
    names this identity in these scripts)
  - `GH_TOKEN` — same token as 3.4; used here to upload duplicated
    `v1-stable*.yml` manifests to the draft release (the script warns and
    skips that upload, but still builds, if `GH_TOKEN` is unset)
- This step vendors again defensively (`vendor:rig-cli` inside `build.ts`) and
  builds `out/` from source before packaging — it does not trust a
  pre-existing `out/` (a stale dev build there would silently ship broken).
- **Verify:**
  - `release/mac-arm64/Rig.app` and `release/rig-0.4.0-arm64.{dmg,zip}` exist
  - `release/latest-mac.yml` and `release/v1-stable-mac.yml` both exist (the
    R2-channel manifest is a duplicate the script produces because
    `publish.channel` in `electron-builder.config.ts` is `v1-stable`, same as
    the GitHub feed's `latest`, so no separate electron-builder pass is
    needed)
  - Optionally, `node --experimental-strip-types scripts/release/verify-mac.ts --expected-team-id <APPLE_TEAM_ID>` confirms the codesign identity and
    (on arm64) binary architecture

**3.6 — Notarize and staple.**
- **Command:** `node --experimental-strip-types scripts/release/notarize-mac.ts --app-bundle "Rig.app"`
- **Working directory:** `apps/rig-desktop`
- **Auth:** `APPLE_API_KEY` (path to the `.p8`, or the key content inline —
  the script writes it to a temp file if so), `APPLE_API_KEY_ID`,
  `APPLE_API_ISSUER`
- Note the app bundle name: `"Rig.app"`, not `"Emdash.app"` — the stale
  `release-prod.yml` (infra debt (a)) hardcodes `"Emdash.app"`, which is
  correct for `apps/emdash-desktop` but wrong for this app; `PRODUCT_NAME` in
  `src/shared/app-identity.ts` is `'Rig'` for the stable channel.
- **Verify:** script output ends with `Notarized and stapled: <dmg path>` and
  `Gatekeeper passed for <dmg path>` for each dmg found in `release/`

**3.7 — Upload to R2.**
- **Command:** `node --experimental-strip-types scripts/release/upload-r2.ts`
- **Working directory:** `apps/rig-desktop`
- **Auth:** `R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`,
  `R2_BUCKET`
- No `--channel`/`--prefix` flags needed — they default to this app's own
  `UPDATE_CHANNEL` (`v1-stable`) and `ARTIFACT_PREFIX` (`rig`) from
  `app-identity.ts`. **Never** run this step from `apps/emdash-desktop` — see
  infra debt (c).
- **Verify:**
  - Script prints `Uploaded <file>` for each manifest/installer/blockmap
  - Optionally, the real integrity check:
    `node --experimental-strip-types scripts/release/verify-manifest.ts --channel v1-stable --platform mac` —
    fetches the manifest back from `https://dl.userig.xyz` and compares it
    byte-for-byte (version + per-file sha512/size) against the local
    `release/` output

**3.8 — Publish the GitHub release.**
- **Command:** `GH_TOKEN=<token> node --experimental-strip-types scripts/release/finalize-release.ts --channel stable`
- **Working directory:** `apps/rig-desktop`
- **Auth:** `GH_TOKEN` (same as 3.4/3.5)
- **Verify:** `gh release view v0.4.0 --repo rig-xyz/rig-ide` shows
  `isDraft: false`

**3.9 — Final end-to-end verification.**
- `curl https://dl.userig.xyz/v1-stable-mac.yml` — `version:` reads `0.4.0`
- https://userig.xyz/download renders 0.4.0 as the current download (this
  page reads the manifest live — see step 4, no deploy needed for this to be
  correct)

### 4. Hub (no deploy needed)

The download page at `rig/hub/web/src/app/download/page.tsx` fetches the
current version from the manifest at request time, so nothing needs
redeploying for it to show 0.4.0. It does hardcode a cosmetic
`FALLBACK_VERSION = "0.3.2"` constant used only if that live fetch fails —
bumping it to `"0.4.0"` keeps the failure-mode display current. Out of scope
for this runbook; noted here so it isn't forgotten on the next pass through
that repo.
