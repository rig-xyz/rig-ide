#!/bin/sh

set -eu

SCRIPT_DIR=$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd -P)
REPO_ROOT=$(CDPATH='' cd -- "$SCRIPT_DIR/../../.." && pwd -P)
TAP_ROOT=${TAP_CONTEXT_ROOT:-"$REPO_ROOT/../tap-doc-context"}
RIG_ROOT=${RIG_CONTEXT_ROOT:-"$REPO_ROOT/../rig-doc-context"}
POSTGRES_CONTAINER=${TAP_POSTGRES_CONTAINER:-tap-postgres}

TSX="$TAP_ROOT/packages/relay/node_modules/.bin/tsx"
HARNESS="$REPO_ROOT/apps/rig-desktop/scripts/verify-agent-context-e2e.mjs"

if [ ! -x "$TSX" ]; then
  echo "Tap's tsx runtime was not found at $TSX" >&2
  echo "Install the Tap worktree dependencies or set TAP_CONTEXT_ROOT." >&2
  exit 1
fi

# The ACP runtime loads @emdash/core AND @emdash/plugins through their package
# exports, not directly from src (apps/rig-desktop/src/main/core/acp/runtime-process/entry.ts
# imports the plugin registry from @emdash/plugins/agents). Keep the agent env
# allowlist (@emdash/core) and provider spawn behavior, e.g. the Codex
# shell_environment_policy override (@emdash/plugins), in sync with the
# working tree before Electron starts; otherwise a stale dist can silently
# select the developer's older global Rig CLI or drop the Rig context env
# vars from a Codex session's shell.
corepack pnpm --dir "$REPO_ROOT" --filter @emdash/core --filter @emdash/plugins build

postgres_was_running=$(docker inspect -f '{{.State.Running}}' "$POSTGRES_CONTAINER" 2>/dev/null || true)
started_postgres=false
if [ "$postgres_was_running" != 'true' ]; then
  docker start "$POSTGRES_CONTAINER" >/dev/null
  started_postgres=true
fi

cleanup() {
  if [ "$started_postgres" = 'true' ]; then
    docker stop "$POSTGRES_CONTAINER" >/dev/null 2>&1 || true
  fi
}
trap cleanup EXIT HUP INT TERM

attempt=0
while [ "$(docker inspect -f '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' "$POSTGRES_CONTAINER")" != 'healthy' ]; do
  attempt=$((attempt + 1))
  if [ "$attempt" -ge 20 ]; then
    echo "Tap Postgres did not become healthy within 20 seconds." >&2
    exit 1
  fi
  sleep 1
done

set -- --manual
if [ "${RIG_CONTEXT_MANUAL_NO_LAUNCH:-}" = '1' ]; then
  set -- "$@" --no-launch
fi

TAP_CONTEXT_ROOT="$TAP_ROOT" \
RIG_CONTEXT_ROOT="$RIG_ROOT" \
  "$TSX" "$HARNESS" "$@"
