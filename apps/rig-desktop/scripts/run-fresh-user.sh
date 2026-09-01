#!/bin/sh
#
# Launches the rig-desktop dev app exactly as a brand-new beta user would see
# it on a machine that has NEVER had rig installed: no rig config/tokens, no
# managed rig home, no global rig CLI on PATH, no app database, no app
# settings, no prior workspaces or recent-rigs list, no cached provider
# state, no rig-desktop-specific localStorage. Seeds NOTHING — contrast with
# scripts/run-agent-context-manual.sh, which pre-seeds a workspace, users,
# and skills for a different (provenance-testing) purpose. This script only
# borrows that fixture's SHAPE: isolated app DB, temp dirs, cleanup on exit.
#
# See apps/rig-desktop/docs/fresh-user-regression.md for the manual checklist
# to run through once the app is up.
#
# Usage:
#   scripts/run-fresh-user.sh [--no-launch] [--no-providers] [--loopback]
#
#   --no-launch     Run prep only (build, temp root, CLI dir, PATH plan) and
#                    print the isolation summary, but never start Electron.
#                    Useful for a fast CI-style check of the harness itself.
#   --no-providers  Also strip claude/codex from the app's PATH (best-effort
#                    — see the PATH note printed at launch) to exercise the
#                    app's own "provider not installed" install-guidance path
#                    instead of a real provider sign-in.
#   --loopback      Use a disposable local relay (same Tap sandbox mechanism
#                    as run-agent-context-manual.sh) instead of the real
#                    hosted relay. Needs Tap's local Postgres reachable and
#                    TAP_CONTEXT_ROOT (or the ../tap-doc-context default).
#
# Env overrides:
#   RIG_CLI_ROOT        Path to a rig CLI checkout used for RIG_DEV_CLI_DIR.
#                        Defaults to ../rig-doc-context next to this repo.
#   TAP_CONTEXT_ROOT     Path to a tap checkout, only used by --loopback.
#                        Defaults to ../tap-doc-context next to this repo.
#   TAP_POSTGRES_CONTAINER  Docker container name for --loopback's Postgres.
#                        Defaults to tap-postgres.
#   RIG_RELAY_URL       Relay to sign up/sign in against when NOT using
#                        --loopback. Unset by default, which means the app's
#                        own default applies — the REAL production relay
#                        (tap-relay.fly.dev, see src/main/rig/account.ts).
#                        There is no separate staging relay wired into this
#                        app; anything other than that host or loopback is
#                        rejected by src/main/rig/relay-trust.ts unless it is
#                        listed in RIG_RELAY_ALLOW_HOSTS.

set -eu

SCRIPT_DIR=$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd -P)
APP_DIR=$(CDPATH='' cd -- "$SCRIPT_DIR/.." && pwd -P)
REPO_ROOT=$(CDPATH='' cd -- "$APP_DIR/../.." && pwd -P)
RIG_CLI_ROOT_SRC=${RIG_CLI_ROOT:-"$REPO_ROOT/../rig-doc-context"}
TAP_ROOT=${TAP_CONTEXT_ROOT:-"$REPO_ROOT/../tap-doc-context"}
POSTGRES_CONTAINER=${TAP_POSTGRES_CONTAINER:-tap-postgres}

NO_LAUNCH=0
NO_PROVIDERS=0
LOOPBACK=0
for arg in "$@"; do
  case "$arg" in
    --no-launch) NO_LAUNCH=1 ;;
    --no-providers) NO_PROVIDERS=1 ;;
    --loopback) LOOPBACK=1 ;;
    -h | --help)
      sed -n '2,33p' "$0" | sed 's/^#$//;s/^# //'
      exit 0
      ;;
    *)
      echo "Unknown flag: $arg (see --help)" >&2
      exit 1
      ;;
  esac
done

if [ ! -x "$RIG_CLI_ROOT_SRC/bin/rig.mjs" ]; then
  echo "No rig CLI checkout found at $RIG_CLI_ROOT_SRC/bin/rig.mjs" >&2
  echo "Set RIG_CLI_ROOT to a rig CLI checkout with dependencies installed." >&2
  exit 1
fi

TMP_ROOT=$(mktemp -d "${TMPDIR:-/tmp}/rig-fresh-user.XXXXXX")
HOME_DIR="$TMP_ROOT/home"
USER_DATA_DIR="$TMP_ROOT/userdata"
CLI_BIN_DIR="$TMP_ROOT/rig-cli-bin"
LOG_DIR="$TMP_ROOT/logs"
mkdir -p "$HOME_DIR" "$USER_DATA_DIR" "$CLI_BIN_DIR" "$LOG_DIR"
ln -s "$RIG_CLI_ROOT_SRC/bin/rig.mjs" "$CLI_BIN_DIR/rig"

LOOPBACK_PID=""
LOOPBACK_INFO="$TMP_ROOT/loopback-relay.json"
POSTGRES_STARTED_BY_US=0
CHILD_PID=""

# `corepack pnpm run dev` fans out through pnpm -> electron-vite -> Electron
# -> Electron's own gpu/utility/renderer helper processes. A plain `kill` of
# just CHILD_PID does not reliably reach the bottom of that chain (observed
# directly while testing this script: Electron helper processes outlived a
# TERM to their electron-vite ancestor). Walk the real process tree first...
kill_tree() {
  tree_pid=$1
  tree_sig=$2
  for tree_child in $(pgrep -P "$tree_pid" 2>/dev/null); do
    kill_tree "$tree_child" "$tree_sig"
  done
  kill -"$tree_sig" "$tree_pid" 2>/dev/null || true
}

# Bounded poll instead of `wait`: a plain `wait "$pid"` can hang cleanup()
# indefinitely if the target ignores TERM (and `wait` only works on this
# shell's own children in the first place — CHILD_PID's grandchildren are
# not waitable this way regardless). Give it a few seconds, then move on;
# the pkill sweep below is the real backstop for anything left standing.
wait_briefly() {
  wait_pid=$1
  wait_tries=0
  while kill -0 "$wait_pid" 2>/dev/null && [ "$wait_tries" -lt 5 ]; do
    wait_tries=$((wait_tries + 1))
    sleep 1
  done
}

cleanup() {
  status=$?
  if [ -n "$CHILD_PID" ] && kill -0 "$CHILD_PID" 2>/dev/null; then
    kill_tree "$CHILD_PID" TERM
    wait_briefly "$CHILD_PID"
    # Electron installs its own signal handling for crash reporting that can
    # swallow a plain TERM without quitting (observed directly: electron-vite
    # and the Electron process it spawned both outlived a TERM sweep here).
    # SIGKILL cannot be caught or ignored, so escalate rather than let
    # cleanup — and the temp-root removal after it — stall indefinitely.
    if kill -0 "$CHILD_PID" 2>/dev/null; then
      kill_tree "$CHILD_PID" KILL
      wait_briefly "$CHILD_PID"
    fi
  fi
  # ...and, since Electron's own helper processes are not always reachable as
  # ordinary process-tree descendants, sweep by the one thing every process
  # in THIS run's Electron tree (main + gpu/utility/renderer helpers) is
  # guaranteed to carry: --user-data-dir pointing at our own temp root. Safe
  # to pattern-match on — mktemp gives it a unique path, so this can never
  # catch another run's processes.
  if [ -d "$USER_DATA_DIR" ]; then
    pkill -TERM -f -- "$USER_DATA_DIR" 2>/dev/null || true
    sleep 1
    pkill -KILL -f -- "$USER_DATA_DIR" 2>/dev/null || true
  fi
  if [ -n "$LOOPBACK_PID" ] && kill -0 "$LOOPBACK_PID" 2>/dev/null; then
    kill -TERM "$LOOPBACK_PID" 2>/dev/null || true
    wait_briefly "$LOOPBACK_PID"
  fi
  if [ "$POSTGRES_STARTED_BY_US" = 1 ]; then
    docker stop "$POSTGRES_CONTAINER" >/dev/null 2>&1 || true
  fi
  rm -rf "$TMP_ROOT"
  echo "Removed temp root: $TMP_ROOT"
  exit "$status"
}
trap cleanup EXIT HUP INT TERM

echo "Rebuilding @emdash/core and @emdash/plugins (stale dists are a real bug class here)..."
corepack pnpm --dir "$REPO_ROOT" --filter @emdash/core --filter @emdash/plugins build

# ---------------------------------------------------------------------------
# PATH: drop any directory that currently resolves `rig` (always) and, with
# --no-providers, `claude`/`codex` too. Best-effort only: src/main/utils/
# userEnv.ts's resolveUserEnv() re-derives PATH from the user's REAL login
# shell at Electron boot (`$SHELL -ilc 'env'`), which can reintroduce
# whatever ~/.zshrc or a system profile (Homebrew's path_helper, etc.) adds
# — independent of what PATH we hand the process here. Two things make `rig`
# resolution deterministic anyway: RIG_DEV_CLI_DIR (set below) is preferred
# over any bare-PATH `rig` lookup by src/main/rig/bundled-cli.ts's
# ensurePreferredRigBinInPath(), which runs AFTER resolveUserEnv() and always
# wins. There is no equivalent override for claude/codex, so --no-providers
# hiding them is only reliable when they are on PATH via a HOME-relative
# dotfile entry (which the isolated HOME below also sidesteps) rather than a
# system-wide install (Homebrew, /usr/local/bin, etc.) — check the app's own
# dependency status (Settings -> About, or the provider sign-in screen) to
# confirm what actually got detected.
# ---------------------------------------------------------------------------
strip_names="rig"
if [ "$NO_PROVIDERS" = 1 ]; then
  strip_names="rig claude codex"
fi
NEW_PATH=""
OLD_IFS=$IFS
IFS=:
for dir in $PATH; do
  IFS=$OLD_IFS
  [ -n "$dir" ] || continue
  keep=1
  for name in $strip_names; do
    if [ -x "$dir/$name" ]; then
      keep=0
      break
    fi
  done
  if [ "$keep" = 1 ]; then
    NEW_PATH="${NEW_PATH:+$NEW_PATH:}$dir"
  fi
  IFS=:
done
IFS=$OLD_IFS

RELAY_URL=""
RELAY_TOKEN=""
if [ "$LOOPBACK" = 1 ]; then
  TSX="$TAP_ROOT/packages/relay/node_modules/.bin/tsx"
  if [ ! -x "$TSX" ]; then
    echo "Tap's tsx runtime was not found at $TSX" >&2
    echo "Install the Tap worktree dependencies or set TAP_CONTEXT_ROOT." >&2
    exit 1
  fi
  postgres_was_running=$(docker inspect -f '{{.State.Running}}' "$POSTGRES_CONTAINER" 2>/dev/null || true)
  if [ "$postgres_was_running" != 'true' ]; then
    docker start "$POSTGRES_CONTAINER" >/dev/null
    POSTGRES_STARTED_BY_US=1
  fi
  attempt=0
  while [ "$(docker inspect -f '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' "$POSTGRES_CONTAINER")" != 'healthy' ]; do
    attempt=$((attempt + 1))
    if [ "$attempt" -ge 20 ]; then
      echo "Tap Postgres did not become healthy within 20 seconds." >&2
      exit 1
    fi
    sleep 1
  done

  echo "Starting disposable loopback relay..."
  TAP_CONTEXT_ROOT="$TAP_ROOT" "$TSX" "$SCRIPT_DIR/run-fresh-user-loopback-relay.mjs" \
    --info-file "$LOOPBACK_INFO" >"$LOG_DIR/loopback-relay.log" 2>&1 &
  LOOPBACK_PID=$!

  attempt=0
  while [ ! -s "$LOOPBACK_INFO" ]; do
    if ! kill -0 "$LOOPBACK_PID" 2>/dev/null; then
      echo "Loopback relay exited before it was ready — see $LOG_DIR/loopback-relay.log" >&2
      exit 1
    fi
    attempt=$((attempt + 1))
    if [ "$attempt" -ge 30 ]; then
      echo "Loopback relay did not become ready within 30 seconds." >&2
      exit 1
    fi
    sleep 1
  done
  RELAY_URL=$(node -e "console.log(JSON.parse(require('node:fs').readFileSync(process.argv[1],'utf8')).relayUrl)" "$LOOPBACK_INFO")
  RELAY_TOKEN=$(node -e "console.log(JSON.parse(require('node:fs').readFileSync(process.argv[1],'utf8')).token)" "$LOOPBACK_INFO")
  echo "Loopback relay: $RELAY_URL"
  echo "NOTE: --loopback's relay uses a fake auth verifier (no real Clerk"
  echo "device-flow UI exists for it), so this run pre-authenticates via"
  echo "RIG_RELAY_TOKEN and SKIPS the real sign-in/sign-up step. Run the"
  echo "checklist's sign-in step without --loopback at least once."
fi

echo ""
echo "Fresh-user harness ready."
echo "Temp root:      $TMP_ROOT"
echo "Isolated:"
echo "  HOME                 -> $HOME_DIR   (rig config/token, ~/Rig home, ~/.claude & ~/.agents skills, shell PATH probe)"
echo "  Electron userData    -> $USER_DATA_DIR   (settings.json, app DB, localStorage/session partitions)"
echo "  rig CLI (dev)        -> $CLI_BIN_DIR   (RIG_DEV_CLI_DIR, shadows any global rig)"
echo "  keychain / safeStorage -> untouched by a fresh-user run (confirmed unused on this path; see inventory)"
if [ "$LOOPBACK" = 1 ]; then
  echo "  relay                -> $RELAY_URL (disposable loopback, no workspace/binding/document seeded)"
else
  echo "  relay                -> production default (tap-relay.fly.dev) unless RIG_RELAY_URL is set"
fi
if [ "$NO_PROVIDERS" = 1 ]; then
  echo "  PATH                 -> rig, claude, codex stripped (best-effort — see script comment)"
else
  echo "  PATH                 -> rig stripped (best-effort — see script comment); claude/codex left as found"
fi
echo ""
echo "NOT isolated:"
echo "  - apps/rig-desktop/.emdash-logs/emdash.log: the dev script's own"
echo "    inline EMDASH_LOG_FILE always wins over an inherited override."
echo "  - macOS Dock 'Recent Documents' (app.addRecentDocument): OS-level"
echo "    Launch Services state, not app data — out of scope by design."
echo ""

if [ "$NO_LAUNCH" = 1 ]; then
  echo "--no-launch: prep complete, not starting Electron."
  exit 0
fi

echo "Launching rig-desktop dev app. Close it or press Ctrl-C here to remove the temp root."
echo ""

# NOTE: not passing EMDASH_LOG_FILE here — apps/rig-desktop's own "dev"
# script sets it inline (`EMDASH_LOG_FILE=.emdash-logs/emdash.log electron-vite
# dev`), and an inline shell assignment always wins over an inherited env var
# of the same name. Logs land in apps/rig-desktop/.emdash-logs/emdash.log
# regardless of this harness; not further isolated.
cd "$APP_DIR"
env \
  HOME="$HOME_DIR" \
  PATH="$NEW_PATH" \
  RIG_DEV_USER_DATA_DIR="$USER_DATA_DIR" \
  RIG_DEV_CLI_DIR="$CLI_BIN_DIR" \
  TELEMETRY_ENABLED=false \
  RIG_RELAY_URL="$RELAY_URL" \
  RIG_RELAY_TOKEN="$RELAY_TOKEN" \
  corepack pnpm run dev &
CHILD_PID=$!
# Polling instead of a blocking `wait "$CHILD_PID"`: observed directly while
# testing this script — this shell does not reliably interrupt a blocked
# `wait` on SIGINT/TERM, so Ctrl-C could sit unhandled until the dev app
# exits on its own. A trap is always checked between simple commands, so a
# short poll loop gets Ctrl-C's cleanup running within about a second.
while kill -0 "$CHILD_PID" 2>/dev/null; do
  sleep 1
done
