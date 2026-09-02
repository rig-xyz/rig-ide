# Fresh-user regression checklist

The ordered first-run journey a brand-new beta user hits, for a human tester
to run through and tick off. Launch with the harness in
`scripts/run-fresh-user.sh` (`corepack pnpm run dev:fresh-user` from
`apps/rig-desktop/`) — it isolates every persistent location rig-desktop and
the bundled rig CLI touch (the "Isolated:" block it prints on every launch is
the live, authoritative list; its `--help` and source comments explain the
reasoning behind each one) and seeds nothing: no rig config/tokens, no
managed `~/Rig` home, no global `rig` on PATH, no app database, no app
settings, no prior workspaces, no cached provider state.

Run `corepack pnpm run dev:fresh-user` (equivalently `sh scripts/run-fresh-user.sh`)
from `apps/rig-desktop/` for the default journey below. See **Flags** at the
bottom for `--no-providers`, `--loopback`, and `--no-launch`.

## First-run journey

- [ ] **Launch.** `corepack pnpm run dev:fresh-user`. Expect: `@emdash/core` and
      `@emdash/plugins` rebuild, then an "Isolated:" summary printing the
      temp root and what's redirected there, then the Electron window opens.
- [ ] **First screen.** No prior rig, no prior sign-in — expect the Welcome
      screen and nothing else: the mark, one line of copy, and exactly one
      button, **Start fresh** (no recent-rigs list, no "Welcome back", no
      sign-in, no provider setup).
- [ ] **Create first rig.** Click **Start fresh**. Since this is a genuinely
      fresh profile you're signed out, so this is the FIRST thing a real new
      user experiences: the button should become **Waiting for sign-in…**
      (disabled) with one quiet line beneath, "Rig is collaborative — sign
      in to start," and the browser should open to `rig login`'s real
      Clerk sign-up/sign-in flow. "Quick" means exactly that: no dialog, no
      name/location/sync questions on this side, sign in the browser, and
      the app continues on its own the moment it lands — no second click
      back in the app. Expect it to then create immediately and land inside
      the isolated `~/Rig` (i.e. `<temp root>/home/Rig/untitled-rig`, not
      your real `~/Rig`) open on `Start here.md` in Preview. If sign-in is
      cancelled or fails, expect the button to return to idle **Start
      fresh** with a short, honest error line beneath it — not a stuck
      spinner.
- [ ] **Rename inline.** Expect the rig name in the topbar to already be
      auto-focused in edit mode with its text selected; type a name and
      press Enter. Expect the folder itself to be renamed (confirm via
      Settings → "Rig folder" or the rig switcher), not just the on-screen
      label.
- [ ] **Select text, leave a comment.** Expect the comment to anchor to the
      selection and render in the margin.
- [ ] **@claude or @codex mention** in a comment thread. Since `HOME` is
      isolated, this is a REAL first-time provider sign-in even if you're
      already signed in to Claude/Codex on this machine outside the
      harness — expect the provider's own auth flow to open right there,
      inline with the mention, then a fresh headless session to spawn and
      reply in-thread.
- [ ] **"Why is this here?"** — ask the mentioned agent about a passage.
      Expect a prose answer that cites provenance; the underlying
      `rig context trace` tool call must NOT surface as a raw tool-call card
      in the thread — the answer should just read as an answer.
- [ ] **"Make this X"** — an edit request. Expect either a "Wants to edit
      `<file>`" permission card (default — Settings → Agents →
      "Auto-approve agent actions" is off), or, if you turned auto-approve
      on, the edit to apply directly with no card. Either way, the agent's
      reply must describe what it actually did (not a generic
      acknowledgement) — check the two paths separately if you have time.
- [ ] **Toggle Edit mode.** Expect every comment left in Preview to still be
      present and anchored immediately — no re-sync delay, nothing dropped.
- [ ] **Share the rig.** Click the topbar **Share** button. Do this against
      the REAL relay (no `--loopback` — see the flag note below for why).
      You signed in at Start fresh, and one-click create synced the rig
      invisibly, so expect the popover to go STRAIGHT to the invite-link UI
      — no sign-in, no toggle, no second screen. (To exercise the
      local-only path — *Sign in to share* / "Sharing turns on sync for
      this rig" — open a never-synced folder via the rig switcher instead.)
- [ ] **Generate an invite link.** Expect a copyable link tied to the rig you
      created.
- [ ] **Import a Google Doc.** From the file navigator (the artefact pane's
      Files button), use "Import a Google Doc" — paste a Docs link or
      choose a `.docx`. Expect it to import into the CURRENT rig and open
      the resulting file.
- [ ] **Advanced location, in Settings.** Settings → "Rig folder" should
      show the current home path and an "Advanced: choose location…"
      picker with the same at-your-own-risk warning the old create dialog
      had — confirm creation itself never asks about location anymore.
- [ ] **Second isolated profile joins and sees comments** (optional, see
      **Two-profile run** below).
- [ ] **Quit and relaunch** (same temp root, same command — do NOT delete the
      temp root between these two steps). Expect the rig you created, its
      settings, and your sign-in state to all still be there — the isolation
      is per temp-root, not per-launch.

## Two-profile run

To see a second person join and see the first person's comments, run the
harness TWICE, each with its own temp root, and use the invite link from run
1 in run 2:

1. Terminal A: `corepack pnpm run dev:fresh-user`. Sign in, create a rig, leave a
   comment, generate an invite link (see journey above).
2. Terminal B, a SEPARATE shell: `corepack pnpm run dev:fresh-user` again — each
   invocation gets its own `mktemp -d` temp root, so the two are fully
   independent (separate `HOME`, separate userData, separate app DB). Sign in
   as a different account (a second email/Clerk identity — the real relay
   does not let one identity join through two profiles as two different
   people) and open the invite link from step 1.
3. Expect: profile B lands in the shared rig and sees profile A's comment
   without any manual sync step.

Both terminals' temp roots get removed independently on their own Ctrl-C —
interrupt them in either order.

## "Clean machine" assumptions

What we found tracing `src/main/rig/bundled-cli.ts` and
`src/main/core/dependencies/`:

- **Node/Electron itself**: not a beta-user concern — the packaged app
  bundles its own Electron/Node runtime. This only matters for a DEV build
  (this harness), which needs the repo's own toolchain (`pnpm`, `corepack`)
  already installed.
- **The rig CLI**: a packaged build always has its own bundled copy
  (`<resources>/rig-cli`, vendored by `scripts/vendor-rig-cli.ts`) — a real
  beta user needs NOTHING preinstalled for `rig` itself to work. This dev
  harness fakes that guarantee via `RIG_DEV_CLI_DIR` pointing at a rig CLI
  checkout (see `RIG_CLI_ROOT` in the harness's usage text), since a dev
  build has no bundled copy of its own.
- **Claude/Codex CLIs**: NOT bundled. `src/main/core/dependencies/registry.ts`
  builds `AGENT_DEPENDENCIES` from the plugin registry and probes for them on
  PATH via `HostDependencyManager` — a real beta user needs to install
  whichever provider CLI(s) they want to use themselves. The app's own
  install-guidance path is what should catch a user with neither installed
  — exercise it with `--no-providers` (below).
- **git**: also probed via `HostDependencyManager` / `DEPENDENCIES`, same
  "not bundled, needs a real install" story as the provider CLIs.
- **Keychain**: confirmed unused on this whole path. `safeStorage`-backed
  storage (`src/main/core/secrets/encrypted-app-secrets-store.ts`) is fully
  lazy — its only callers are SSH credentials, GitHub integration
  credentials, and legacy GitHub token migration, none of which the renderer
  calls today (see the removed-eager-reconciliation comment in
  `src/main/index.ts`). A fresh-user run should never trigger an OS
  keychain/credential-vault prompt.

## Flags

- **`--no-providers`**: also strips `claude`/`codex` from the app's PATH (in
  addition to `rig`, which is always stripped) — use this to exercise the
  app's own "provider not installed" install-guidance UI instead of a real
  provider sign-in. Best-effort: `src/main/utils/userEnv.ts`'s
  `resolveUserEnv()` re-derives PATH from your REAL login shell at Electron
  boot, which can reintroduce a system-wide install (Homebrew, `/usr/local/
  bin`) regardless of what the harness stripped — if a provider still shows
  as detected under `--no-providers`, check Settings → About / the
  dependency status to see what path it actually resolved, and treat that as
  a real signal, not a harness bug.
- **`--loopback`**: swaps the real hosted relay for a disposable local one
  (same Tap sandbox mechanism as `scripts/run-agent-context-manual.sh`).
  Needs Tap's local Postgres reachable and a `tap-doc-context` checkout
  (`TAP_CONTEXT_ROOT`, defaults to `../tap-doc-context`). IMPORTANT: this
  pre-authenticates the app via `RIG_RELAY_TOKEN` — the disposable relay's
  fake auth verifier has no real Clerk device-flow UI to drive interactively,
  so `--loopback` SKIPS the sign-in/sign-up journey step. Use it for steps 3
  onward (create rig, comment, share, invite) when you want a cheap,
  offline-friendly, repeatable relay; run the sign-in step at least once
  without `--loopback` against the real thing.
- **`--no-launch`**: runs prep only (rebuild, temp root, CLI dir, PATH plan,
  isolation summary) without starting Electron — a fast check of the harness
  itself, not a substitute for the journey above.

## Known non-isolated bits

- `apps/rig-desktop/.emdash-logs/emdash.log` — the app's own `dev` script
  sets `EMDASH_LOG_FILE` inline, which always wins over an inherited
  override, so logs land in the repo checkout regardless of the harness.
- macOS Dock "Recent Documents" (`app.addRecentDocument`) — OS-level Launch
  Services state, not app data; out of scope by design.
