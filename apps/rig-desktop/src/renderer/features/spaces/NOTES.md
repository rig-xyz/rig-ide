# Spaces — lane 2 (Room UI)

Built against a recorded feed. No relay dependency. Everything here lives
under `renderer/features/spaces/` and is mounted only when `spacesEnabled`
(Settings → Experimental) is on.

## What's built

**Flag.** `spacesEnabled: boolean` in `RigSettings` (`shared/rig/settings.ts`),
default `false`, wired the same way `smartHighlighterEnabled` was in the
commit right before this one: `main/rig/settings.ts`'s `normalizeSettings`,
`main/rig/settings.test.ts`, and a second row (`SpacesRow`) in
`shell/settings-modal.tsx`'s Experimental section.

**Fixtures** (`fixtures/`):
- `session-runs.json` + `session-events/*.json` — the real `session_runs`
  and `session_events` rows for 6 runs, exported from the
  `tap-spike-sessions` spike Postgres database (`experiment/spaces-session-
  log`), not synthesized. `fixtures/index.ts` documents the exact export
  steps and has the DB-shape types. Every file is under 200KB; the two
  "worst-case tool output" runs had 49KB `available_commands_update`
  payloads and 60KB+ diff blocks, trimmed to a short command list and a
  head+tail text snippet respectively, both marked `truncated: true` with
  an `originalBytes` count (see `types.ts`'s `SessionEvent`).
- `room-feed.ts` — the scripted Bob/Alice/Carol room story (`buildRoomFeed()`
  returns a `RoomFeedScript`), condensed from the product reference demo.
  Every session card in the story is backed by one of the 6 real runs above
  (used exactly once each) rather than fabricated step-by-step tool calls;
  see the file's own header comment for exactly which real run backs which
  narrative moment, and why the agent doing the work (Claude vs Codex)
  occasionally differs from the reference demo's own assignment.

**Data layer**:
- `types.ts` — `RoomMessage`/`MessageMeta` (text | session | invite |
  comment_mirror | system), `RoomEvent` (the append-only feed), `RoomSnapshot`
  (materialized state), and the session-projection types.
- `projection.ts` — `projectSessionCard`/`applySessionEvent`, ported and
  hardened from the spike's `session-log/lib.ts` (never throws on a
  malformed payload; understands `truncated`/`originalBytes`).
  `projection.test.ts` runs it against all 6 real fixtures: step count
  matches the transcript's `tool_call` count, and an incrementally-built
  card equals one built from scratch (`toEqual`), for every run.
- `room-source.ts` — the `RoomSource` interface (`getSnapshot`/`subscribe`/
  `play`/`pause`/`replayAll`/`dispose`) and `FixtureRoomSource`, which
  replays a `RoomFeedScript`'s beats with real timers (dev) or synchronously
  via `replayAll()` (tests). `room-source.test.ts` replays the full story
  end to end and checks every session settles, every invited member joins,
  no agent is left busy, and subscribers see every event exactly once.

**Components** (`components/`):
- `room-transcript.tsx` — the keyed, `AnimatePresence`/`motion.div` list
  (`layout` prop so a growing session card animates its own height),
  follow-scroll that stops on user scroll-up and resumes near the bottom.
- `transcript-items.tsx` — `MessageBubble` (own messages right/accent-tint
  with own avatar, others left with name), `TypingBubble`, `JoinRow`,
  `DayDivider`, `InviteRow` (avatar/name/email/role chip/status/copy link,
  no Revoke), `ConnectorCard`, `CommentMirrorLine`, `SystemRow`.
- `session-card.tsx` — header (agent logo + owner avatar badge + name +
  model + elapsed + Stop while running), body (current step + spinner,
  output rows with +/-, final answer), footer ("N steps" toggle expanding
  the full log in place).
- `composer.tsx` — textarea, `/` opens the skills palette, `@` opens
  people+agent completion, `+`/paperclip is presentation-only (no attach
  target yet), Enter button with ↵.
- `space-card.tsx` — floating card reusing `workspace/pinned-card.tsx`'s row
  grammar: People, one row per agent, Connectors, Skills, Activity.
- `room-view.tsx` — owns one `FixtureRoomSource`, play/pause dev control.
- `logos.tsx` — `BrandLogo`, the simple-icons paths for Claude/OpenAI/
  Metabase/Mixpanel/Google Ads copied verbatim from the reference demo.

**Mount**: `App.tsx` reads `spacesEnabled` via `use-spaces-enabled.ts` (same
live-read pattern as `docs/paintbrush/use-paintbrush.ts`) and, when on, shows
a "Room (preview)" icon button next to the topbar's `LayoutSwitcher`. It
opens `RoomView` as a full overlay on top of the current rig pane — this
was a deliberate choice over adding a fourth `RigLayout` value: `RigLayout`
("chat"/"split"/"files") is deeply wired into `App.tsx`'s tab/artefact
machinery (hidden-tab counts, focus-view rules, etc.), and `RoomView` has
nothing to do with any of that — it owns its own `FixtureRoomSource` and
needs none of the surrounding state. An overlay is the lowest-risk, purely
additive integration; nothing renders or changes when the flag is off.

## Contract assumed from the relay (for lane 3)

`RoomSource` (`room-source.ts`) is the seam. A `RelayRoomSource` needs to
satisfy the same interface `FixtureRoomSource` does:

- `getSnapshot()` always returns the current materialized `RoomSnapshot`.
- `subscribe(listener)` delivers `(event, snapshotAfterEvent)` for every
  event, in order, exactly once each.
- `play()`/`pause()`/`isPlaying()`/`isDone()` — a live room source can
  treat `isDone()` as always `false` and `play()`/`pause()` as connect/
  disconnect from the stream; `RoomView`'s play/pause button is a dev
  affordance for the scripted feed specifically and probably shouldn't
  ship for a live room (see below).

The `RoomEvent` union in `types.ts` is written close to the shape sketched
in the build doc (`message_created`/`session_event_appended`/
`agent_request_created`/etc.), but **`message_created` and
`session_event_appended` carry the full payload inline** (`message:
RoomMessage`, `event: SessionEvent`) rather than just `id`/`seq` — because
`FixtureRoomSource` has no separate store to resolve them from. A real
relay's wire event may well be leaner (message/session-event bodies in
their own table, fetched by id), in which case `RelayRoomSource` should
resolve them itself before calling `reduce`/notifying subscribers, so
`RoomTranscript` and friends never have to know the difference.

`SessionEvent.originalBytes` (camelCase here) corresponds to what the build
doc calls `original_bytes` — this app's own addition for a fixture that had
to truncate a payload to stay under the 200KB budget. Whether the real relay
ever needs to truncate and report this, or just caps event size at write
time and never sends an oversized one, is open — see below.

## What lane 3 needs to build

1. **Session publisher** — the thing that turns a running ACP agent's
   events (`tool_call`/`tool_call_update`/`agent_message_chunk`/etc., the
   exact shapes `projection.ts` already consumes) into `SessionEvent`s
   appended to a run, and turns a chat message into a `RoomMessage`. The
   spike's `session-log/lib.ts` (`createEventPublisher`) is the reference
   for the batching/HTTP shape; this app's `projection.ts` is a straight
   port of its reducer, so whatever the publisher emits should already be
   compatible without changes to `projection.ts`.
2. **`RelayRoomSource`** implementing `RoomSource`, backed by the room's
   real event stream (presumably SSE, matching the spike's `subscribe()`)
   instead of `FixtureRoomSource`'s scripted beats. `RoomView` should be
   able to swap `FixtureRoomSource` for `RelayRoomSource` with no changes
   to any component — that's the whole point of the seam.
3. **Sending** — `Composer`'s `onSend` is currently a no-op (`room-
   view.tsx`'s comment explains why: there's nothing to persist a message
   to yet). Lane 3 needs a real `send(text)` that posts a message and gets
   it back through the event stream — at which point `RoomView` just wires
   `onSend` straight through instead of swallowing it.
4. **Invite/connector/skill actions** — `InviteRow`'s "Copy link" and the
   composer's `+`/mention-insert affordances are presentation-only right
   now (no click handler wired to a real action). Once there's a relay,
   these need real handlers.

## Open questions

- **`message_created`/`session_event_appended` payload shape.** Flagged
  above — does the real relay send the full body inline, or just an id to
  fetch? Whichever it is, `RelayRoomSource` should normalize to the inline
  shape before this UI ever sees it, so nothing here has to change.
- **`agent_request_created`'s purpose.** Currently a pure no-op in
  `reduceRoom` — nothing renders off it. Is it meant to drive a "your agent
  was asked to do X, want to approve?" affordance (an actual queued
  intent), or is it just an audit-trail event? Affects whether it needs a
  `status` field (`pending`/`accepted`/`declined`).
- **Comment-mirror state transitions.** This build models a comment
  reaching an agent and the agent's reply as two separate, immutable
  `comment_mirror` messages (see `room-feed.ts`'s `commentMirrorMessage`
  and its `replyFromAgent` flag) rather than one message whose state
  changes from "working" to "done" in place, because `RoomMessage` is
  immutable in this event-sourced model. If the relay's real contract
  needs a single thread whose status updates, that's a
  `comment_mirror_updated` event this app doesn't have yet.
- **Play/pause for a live room.** `RoomView`'s play/pause toggle only makes
  sense for a scripted replay. Lane 3 should decide whether a live Room
  view keeps any version of that control (e.g. "pause following new
  events" while still being connected) or drops it entirely.
- **`SessionRunMeta.model` when the database has no model.** Half of the 6
  real fixture runs have `model: null` in `session_runs` (the two real ACP
  runs whose harness didn't record one) — `room-feed.ts`'s `runMeta()`
  falls back to a per-chapter "friendly model" string (`opus-5`,
  `sonnet-5`, `gpt-5-codex`) so the session card header always has
  something to show. A real room shouldn't need this fallback once the
  publisher reliably records the model.
- **Stop button.** `SessionCard` renders Stop while `status === 'running'`
  but only calls `onStop` if the caller passes one; `RoomTranscript` doesn't
  pass one today (there's nothing to stop against a fixture). Lane 3 needs
  to decide what stopping actually does against a live run and wire it
  through.

## Lane 3 — what's live

Everything below is behind `spacesEnabled`; the fixture-only path is
unchanged (and stays reachable — see the dev toggle below).

**Relay HTTP client** (`main/rig/spaces/relay-api.ts`) — `SpacesRelayApi`,
a small DI-able interface wrapping every route in tap-spaces'
`SPACES_NOTES.md` (sessions, agent-requests, members, messages).
`createHttpSpacesRelayApi()` is the one real implementation, reusing
`resolveContext()` (now exported from `main/rig/account.ts`) so it never
re-derives the relay trust gate. One bug this surfaced before it ever hit
a real relay: the member roster must be read from
`GET /v1/me/bindings/:id/members` (PAT-authed), not
`GET /v1/bindings/:id/members` (device-capability-token-only,
`authMiddleware` — the same trap `comments.ts`'s own header comment
already flags for a different route).

**Session publisher** (`main/rig/spaces/session-publisher.ts`) —
`SessionEventPublisher`: batches at 250ms/32 events (whichever first),
assigns its own monotonic `seq`, retries a failed batch in place (never
reorders/drops), bounds its retry queue (oldest dropped past the cap),
and `finish(status)` drains the tail and patches the run's terminal
status. `record()` is synchronous and never throws — publishing can never
block or slow the local agent session, per the brief.

**Request claiming** (`main/rig/spaces/request-claim.ts`) —
`claimAndDispatchQueued`/`claimOne` list+claim+dispatch; a 409 (another
device won the race) is a silent no-op, never a retry. `RequestClaimPoller`
polls on an interval and coalesces overlapping `checkNow()` calls (for
"on connect and on `agent_request_created`", per the brief) into one
re-run rather than skipping or double-running. `dispatch` is injected —
this module has zero ACP/runtime knowledge, which is also what keeps it
fully unit-testable (see Tests below). **Two things only the live
integration check surfaced**: `claim`'s `deviceId` has a real foreign key
into `binding_devices` on the relay (mint one via
`POST /v1/me/bindings/:id/devices` first — an ad-hoc string 500s the
route) and `PATCH .../agent-requests/:id {status:'running', runId}`'s
`runId` has a real foreign key into `session_runs` (create the run via
`api.createSession` before advancing status) — both now called out in
`request-claim.ts`'s own doc comments.

**`RelayRoomSource`** (`renderer/features/spaces/relay-room-source.ts`) —
implements lane 2's `RoomSource` directly in the renderer (own
`@hocuspocus/provider` connection to `space:<bindingId>`, own `fetch`
calls), NOT proxied through main like every other relay caller in this
codebase — see the file's own header comment for why (lane 2's own
contract plus the "test against a mocked provider" brief both point at a
renderer-owned class) and the tradeoff that implies: the renderer now
holds the PAT for the lifetime of an open Room, handed to it once by a
new minimal RPC, `rig.spacesConnection.getConnectionInfo()`
(`main/rig/spaces-connection.ts`). Flagged here explicitly for review —
it is the one deliberate departure from "every relay call goes through
main," not an oversight.

Bootstraps the member roster + recent messages, resolves the first
`kind:'session'` message naming an unseen run into a synthesized
`session_started` + full event backlog, and catches up over HTTP
(`?after=`/`?latest=`) on connect and on every stateless
`message_created`/`session_event_appended` notification — coalescing
overlapping catch-ups into one re-run, same pattern as the request
poller. `send()`/`requestOwnAgent()` post a message / file an agent
request targeting the sender.

**Room UI wiring** (`components/room-view.tsx`, `App.tsx`) — `RoomView`
takes `bindingId`/`spaceName` (the open rig's own) and opens a
`RelayRoomSource` by default; a radio-tower toggle in the room header (and
an automatic offer on a failed connection) switches to the scripted
`FixtureRoomSource` demo — the dev fallback the brief asked for. Play/
pause now only renders for the fixture. Composer's `onSend` posts through
`RelayRoomSource.send()` and, when the text mentions the sender's OWN
`@claude`/`@codex`, also files an agent request targeting the sender
(linked via the posted message's id) — never a teammate's agent, per the
brief.

**Not done in this pass, and why:**
- **The Stop button** stays unwired. _(Done in lane 4 — see "Lane 4 — what's
  live" below.)_ Cancelling a live run needs an ACP
  session registry keyed by relay `run_id → conversationId`, which doesn't
  exist yet (this pass didn't create local agent sessions for spaces at
  all — see the next point). Lane 2's own NOTES.md already flagged this as
  an open decision; it's carried forward, not newly deferred.
- **The publisher and request-claim poller are not wired into the running
  app.** _(Done in lane 4 — see "Lane 4 — what's live" below.)_ Both are
  complete, real, and integration-tested (see below)
  against a real relay, but nothing in `main/index.ts` starts a
  `RequestClaimPoller` on sign-in, and nothing feeds a local ACP session's
  events into a `SessionEventPublisher`. The reason isn't scope-cutting for
  its own sake: the raw per-event ACP notifications
  `SessionEventPublisher.record()` needs (the exact `tool_call`/
  `tool_call_update`/`agent_message_chunk` kinds `projection.ts` already
  consumes) are consumed and reduced into `TranscriptTurn` state inside
  `packages/runtime/src/acp-agents/session/cell.ts` before they ever reach
  main — there is no existing hook that re-emits them raw (the closest
  thing, `comment-agent.ts`'s `followProgress`, only exposes coarse
  activity+text, not per-tool-call events). Wiring a new raw-passthrough
  hook into `packages/runtime` (shared by chat too) is real, cross-cutting
  surgery on the agent runtime that deserved more verification time than
  this pass had, rather than a hasty change to code every other agent
  session depends on. **Concrete next step**: add a hook alongside
  `agentHookService`'s `agent:event` (or extend it) that re-emits the raw
  ACP `session/update` payload per turn, keyed by `conversationId`, so a
  spaces-aware caller can call `publisher.record(update.sessionUpdate,
  update)` directly — `cell.ts`'s own `case 'tool_call':` branch (and
  siblings) is the exact point that already sees these shapes today.
- **Invite/connector/skill actions** (lane 2's own item 4) — still
  presentation-only; out of this lane's scope.

## Tests

- `main/rig/spaces/relay-api.ts` has no dedicated unit test file (it's a
  thin shape-mapping layer over `fetch`); it's exercised indirectly by
  every publisher/claim test via the `SpacesRelayApi` fakes, and directly
  by the live integration check below.
- `session-publisher.test.ts` (8 tests): batch-at-32 vs. flush-at-250ms,
  monotonic seq across multiple flushes, retry-without-reordering on a
  failing relay, retry-queue bounding, `finish()` draining + patching
  status (including when the relay never comes back), and that `record()`
  never throws post-`dispose()`.
- `request-claim.test.ts` (10 tests): claim→dispatch→mark-running,
  dispatch-failure→mark-failed (including a thrown dispatch), a 409
  conflict never calling dispatch, `claimAndDispatchQueued` skipping
  non-queued rows, and — the one the brief specifically asked for — two
  simulated devices racing the SAME request via a shared in-memory store
  that enforces atomic claim-once, proving exactly one ever dispatches.
  `RequestClaimPoller` coalesces overlapping `checkNow()` calls.
- `relay-room-source.test.ts` (7 tests): bootstrap ordering, the
  first-session-message synthesis (`session_started` + backlog), seq-bounded
  catch-up after a stateless notification, `send()`/`requestOwnAgent()`
  payload shapes, and provider teardown on `pause()`/`dispose()` — against
  a hand-written fake Hocuspocus provider and a routed fake `fetch`, per
  the brief.

### Integration check (live relay)

Ran once, successfully, against a **real** relay: real Postgres, real
Hocuspocus (`TAP_REALTIME=1`), lane 1's own `startRelay()` — not a fake.
**Environment note**: this machine's `initdb`/`pg_ctl` cannot start ANY
local Postgres cluster right now — every attempt (fresh cluster, the
existing Homebrew data dir, both inside and outside the sandbox) fails at
`shmget` with `ENOMEM` on even a 56-byte segment, a host-level SysV-IPC
condition, not a sandbox artifact, and not something to work around by
changing kernel settings. The session's coordinator stood up a disposable
Postgres 16 container instead (OrbStack, `postgresql://tap:tap@127.0.0.1:
55470/tap_dev`) and the check ran against that.

To reproduce (with a working local Postgres, adjust the connection
string):

```
# 1. Seed + start a real relay (tap-spaces checkout):
cd tap-spaces
DATABASE_URL=postgresql://<user>:<pass>@<host>:<port>/<db> \
  pnpm --filter @tap/relay exec tsx .spike/lane3-server.ts /tmp/lane3-conn.json
# prints connection info (relayUrl, wsUrl, bindingId, ownerToken,
# ownerUserId, two real deviceIds) to /tmp/lane3-conn.json and blocks —
# this script isn't committed (`.spike/` is gitignored); recreate it from
# `startRelay`/`createSandbox`/`makeTestUser` per this file's own
# reasoning above if it's gone.

# 2. In a second shell, from rig-desktop, with HOME pointed somewhere
#    WITHOUT a real ~/.config/rig/config.json (that file's relay_token
#    wins over RIG_RELAY_TOKEN by design — see main/rig/config.ts):
HOME=/tmp/fake-home \
SPACES_INTEGRATION_RELAY_URL=<relayUrl> \
SPACES_INTEGRATION_WS_URL=<wsUrl> \
SPACES_INTEGRATION_BINDING_ID=<bindingId> \
SPACES_INTEGRATION_OWNER_TOKEN=<ownerToken> \
SPACES_INTEGRATION_OWNER_ID=<ownerUserId> \
SPACES_INTEGRATION_DEVICE_A_ID=<deviceAId> \
SPACES_INTEGRATION_DEVICE_B_ID=<deviceBId> \
pnpm --filter @rigxyz/desktop exec vitest run --project node \
  src/main/rig/spaces/integration.local.test.ts \
  src/renderer/features/spaces/relay-room-source.integration.local.test.ts
```

Both gated test files (`*.integration.local.test.ts`,
`*.local.test.ts`) `describe.skipIf` themselves out of the normal suite
when `SPACES_INTEGRATION_RELAY_URL` is unset — `pnpm test` never depends
on a running relay.

**Result, this run**: all 3 pass. (1) A session run created via
`api.createSession`, published through the real `SessionEventPublisher`
(batch size 2, forcing a real multi-batch split), reads back with the
exact assigned seq `[1,2,3]` and status `done`. (2) `RelayRoomSource`
posts a message via `send()`; the real Hocuspocus room's stateless
`message_created` notification round-trips it into the source's own
locally-polled snapshot with no other synchronization. (3) Two devices
(real, pre-minted via `POST .../devices`) call `claimOne` concurrently
against the SAME queued request over real HTTP; exactly one dispatches
and creates a real session run, the other gets the relay's 409 and is a
no-op; the request ends up `running` with a real `runId`.

## What lane 4 (the dispatcher) needs from this lane

- `main/rig/spaces/relay-api.ts`'s `SpacesRelayApi` is the one relay
  client to reuse rather than re-wrapping `fetch` a second time — it
  already covers every route lane 4's own section of `SPACES_NOTES.md`
  calls for (`listAgentRequests`, `claimAgentRequest`, `patchAgentRequest`,
  `createSession`).
- `main/rig/spaces/request-claim.ts`'s `RequestClaimPoller`/
  `claimAndDispatchQueued` already implement the claim-then-advance state
  machine end-to-end (409 → no-op; dispatch failure → `failed`; dispatch
  success → `running` with `runId`) and are integration-proven against a
  real relay (two real devices, one winner). What's missing is exactly one
  thing: a real `dispatch` callback that (a) mints/reuses a real device id
  (`POST /v1/me/bindings/:id/devices`), (b) starts a local headless agent
  turn with the request's prompt in the target binding's local workspace
  (reuse `comment-agent.ts`'s dispatch pattern —
  `getAcpRuntimeClient().startSession(...)` — for how permissions stay
  local/owner-approved), and (c) returns `{runId}` from a real
  `api.createSession()` call made BEFORE returning (that FK is real — see
  above). Then start one `RequestClaimPoller` per signed-in account on
  sign-in/app-start.
- `main/rig/spaces/session-publisher.ts`'s `SessionEventPublisher` is
  ready to take whatever raw per-event stream a finished dispatch wiring
  produces — see "Not done in this pass" above for exactly where that
  stream doesn't exist yet (`packages/runtime`'s `cell.ts`) and what hook
  to add.

## Lane 4 — what's live

**Raw-event hook in the runtime** (`packages/runtime/src/acp-agents/
runtime/session-manager.ts`) — `SessionManager.observeRawSessionEvents
(conversationId, observer)`: a minimal, opt-in, per-conversation hook
fired synchronously, in arrival order, right alongside the existing
`SessionCell.push` reduction inside `onSessionUpdate`. A conversation with
no observer costs one `Map.get` returning `undefined` — chat (which never
registers one) is unaffected, proven by `session-manager.test.ts`'s own
"does not change transcript reduction when no observer is registered"
case. A throwing observer is caught and logged (`SessionManager: raw
session event observer threw`) and never breaks the session or other
observers.

That hook is exposed across the ACP runtime worker/main process boundary
(main only ever talks to the worker over `@emdash/wire`'s RPC contract —
there is no shared-memory shortcut) as a new `sessionRawEvents` **liveLog**
wire endpoint, reusing the existing `terminalOutput` transport rather than
inventing a new one: `SessionManager.rawEventsLog(conversationId)` lazily
creates a `LiveLog` of newline-delimited JSON `{sessionId, update}` lines,
wired to `observeRawSessionEvents` on first creation — so the log (and the
cost of maintaining it) only exists for a conversation something has
actually subscribed to. Added to `packages/core/src/acp/api/contract.ts`
and `packages/runtime/src/acp-agents/api/controller.ts`. Covered by new
`session-manager.test.ts` cases (order, throw-safety, unsubscribe,
reduction-unaffected, opt-in log creation) and a wire round-trip test in
`api/contract.test.ts` using a real `ReplicaLog`.

**Dispatcher** (`main/rig/spaces/dispatch.ts`) — `createSpacesDispatcher`
is the real `dispatch` callback `RequestClaimPoller` needed. One
persistent ACP session per `(bindingId, targetOwnerUserId, targetAgent)`:
a second claimed request for the same key reuses the running session via
`queuePrompt` rather than starting a second CLI process. Raw events are
subscribed (via the hook above, over `ReplicaLog`) BEFORE the session
starts, so nothing from the very first turn is missed, and forwarded to
whichever queued request's `SessionEventPublisher` is the currently active
turn — correlated FIFO purely off the session's own `isGenerating`
busy/idle edges, since the ACP session machine's `lastStopReason` at that
edge already distinguishes normal completion (a real reason), an explicit
cancel (`'cancelled'`), and an in-turn error (left `null` — the session
machine's own `TurnEnded` handling never sets a reason on an `'errored'`
outcome, which turned out to be exactly the deterministic signal this
needed; no extra hook required). `available_commands_update` notifications
are dropped before publishing, per the goal's own instruction (19–50KB
each, useless in the log). The seam is `SpacesAcpSessions` — everything
this module needs from the ACP runtime, small enough to fake in tests
without a real runtime worker or wire transport; `createRuntimeAcpSessions`
(same file) is the one real implementation, thin and deliberately
untested in isolation, same posture `relay-api.ts`'s HTTP implementation
already takes.

`createDeviceIdResolver` mints and memoizes a device id per binding
(`SpacesRelayApi.mintDevice`, `POST /v1/me/bindings/:id/devices`, added to
`relay-api.ts`) — necessary because `RequestClaimPoller`'s `deviceId` must
vary per claimed request's own `bindingId` (`listAgentRequests` is
cross-binding), not stay fixed for the whole poller. `request-claim.ts`'s
`ClaimAndDispatchOptions.deviceId` now also accepts a resolver function
(`(bindingId) => Promise<string>`) in addition to the plain string every
existing test still uses unchanged.

**Wired into the running app** — `main/rig/spaces/dispatch-controller.ts`'s
`SpacesDispatchController` owns the one `RequestClaimPoller` this device
runs, starting it exactly when `spacesEnabled` is on AND the app is signed
in, stopping it the moment either isn't — re-evaluated on every settings
change and on a 15s interval (there's no existing sign-in/out event to
react to directly, so sign-in is re-polled rather than pushed; up to 15s
latency noticing a sign-in that happened with the flag already on).
Reentrancy-guarded so an overlapping settings-change + interval tick can
never double-start a poller. Initialized in `main/index.ts` (alongside
`acpAgentStatusBridge`), disposed in `app/shutdown.ts`. The real wiring
(settings store, ACP runtime client, `resolveLocalPathsImpl`'s DB read)
lives in the sibling `dispatch-controller-instance.ts`, deliberately kept
out of `dispatch-controller.ts` itself: those touch Electron's `app`/the
SQLite DB at module load time, which fails under this app's plain `node`
Vitest project (the same pre-existing gap `context.test.ts`/
`comments.smoke.test.ts`/`files.smoke.test.ts`/`share-links.test.ts` hit)
— splitting the class out keeps `SpacesDispatchController` itself
importable, and unit-testable, on its own.

**Stop button** — `components/room-transcript.tsx` threads a new
`onStopSession(runId)` down to `SessionCard`'s existing `onStop` prop, but
only for the current user's OWN agent session (`meta.owner === ownId`) —
the same "own agent only" rule the composer's `@mention` dispatch already
follows. `room-view.tsx` wires it to a new `rig.spacesDispatch.stopRun`
main RPC route (`rpc.ts`), only when the room is on the real relay
(`RelayRoomSource`), never the scripted demo (nothing to stop there).
Ownership is also enforced STRUCTURALLY on the main side, not just by the
renderer hiding the button: `dispatch.ts`'s `stopRun(runId)` only ever
finds runs THIS device's own dispatcher registry is tracking — a run
dispatched by a teammate's device is simply not there, so there is
nothing a curious or compromised renderer could stop by guessing a
different `runId`. Stopping the CURRENTLY RUNNING turn calls the runtime's
`cancelTurn`; stopping a still-PENDING (queued but not yet started) turn
removes it from the queue and settles it `stopped` immediately, without
touching the runtime at all.

**Tests**: `session-manager.test.ts`/`contract.test.ts` (runtime, see
above), `dispatch.test.ts` (17 cases against a fully fake
`SpacesAcpSessions` plus a working fake `SpacesRelayApi`: session reuse,
raw-event filtering/FIFO correlation, normal/error/stop outcomes, stop-
while-running vs. stop-while-pending, failure cleanup, and the device id
resolver), `dispatch-controller.test.ts` (8 cases against injected fakes:
the enabled/signed-in gate in all four combinations, reacting to a
settings change, the periodic sign-in re-check, no double-start, dispose,
stop-run delegation), and 2 new `request-claim.test.ts` cases for the
device id resolver form. `integration.local.test.ts` gained a third case,
"a claimed request drives a fake ACP agent whose events land in the relay
run in order" — the real `createSpacesDispatcher` and a real relay `api`,
against a fake `SpacesAcpSessions` (there is no real ACP runtime worker in
that test process), asserting `available_commands_update` never reaches
the relay and the two real events land with seq `[1, 2]` and the run/
request both settle `done`. **Not run live this pass**: the tap-spaces
checkout this relies on had another agent actively committing to it at
the time (`tap-spaces` root, per this task's own instructions, read/run
only, no edits), and no relay process was already running to attach to —
starting a fresh one risked colliding with that session's own in-flight
Postgres migrations. The test is written and gated exactly like its two
siblings (`describe.skipIf(!RELAY_URL)`), so it costs nothing in the
normal suite and is ready to run the next time a relay is available; see
this file's own "To reproduce" instructions above.

**Not done in this pass, and why**:
- **Invite/connector/skill actions** — still presentation-only; unchanged
  from lane 3, out of this lane's scope too.

## Lane 5 — in-band turn boundaries, cleanup, permission auto-reject (this pass)

**In-band turn boundaries (review finding, fixed).** `dispatch.ts` used to
attribute raw events to a turn from `subscribeBusy` (busy/idle) edges — a
separate live channel from `subscribeRaw` with no ordering guarantee
relative to it. That dropped events arriving before the busy→generating
edge (`current` still null) and, worse, events arriving after the
generating→idle edge, including the turn's own final
`agent_message_chunk`, since the busy edge had already finished the
publisher. Fixed at the source: `packages/runtime`'s `SessionCell`
(`session/cell.ts`) now emits synthetic `{kind:'turn_start', turnId}` /
`{kind:'turn_end', turnId, stopReason}` markers via a new
`SessionCellCallbacks.onTurnBoundary` hook, right around the same
`agent.prompt()` call whose `session/update` notifications a raw observer
sees — `turn_start` synchronously before the first one, `turn_end` at
`agent.prompt()`'s own resolve time (or on a thrown error, with
`stopReason: null`), so ACP's own guarantee that a turn's updates precede
its prompt response means `turn_end` is always ordered after every one of
them. `SessionManager.RawSessionEvent` is now a union
(`{kind:'acp_update',...} | {kind:'turn_start',...} | {kind:'turn_end',...}`)
delivered on the SAME `observeRawSessionEvents`/`rawEventsLog` stream
dispatch.ts already subscribed to — opt-in, unchanged for chat (which
never registers the callback). `queuePrompt` (`cell.ts`, `SessionManager`,
`AcpRuntime`, the wire contract's `queuePromptResponseSchema`) now returns
the queued prompt's own `turnId` alongside `queued`, so a caller can bind
a specific queued request to exactly its own turn instead of inferring it
from position.

`dispatch.ts` no longer has `subscribeBusy`/`BusyChange` at all — it
attributes events and finalizes turns from `turn_start`/`turn_end` markers
only. `QueuedTurn.turnId` starts `null` and is stamped either when
`queuePrompt`'s own RPC resolves or, if a `turn_start` marker for it wins
that race (a real possibility — the RPC ack and the raw-stream marker it
caused travel over different sub-channels of the same connection),
retroactively by `claimTurn`'s FIFO fallback (safe because the ACP session
processes its prompt queue serially). Tests reproducing both original
failures live in `dispatch.test.ts`'s "in-band turn boundaries (review
findings (a) and (b))" block, plus ordering/turnId-binding tests in
`packages/runtime`'s `session-manager.test.ts`.

**Cleanup (review finding, fixed).** `SessionManager.removeRecord` now
deletes both `rawEventLogs` and `rawObservers` for the conversation —
previously neither was ever disposed, so a long-lived app process would
accumulate one `LiveLog` (each replaying up to the same 1MB buffer
`terminalOutput` uses) and one observer `Set` per conversation ever
started, forever. `rawEventsLog` also drops `available_commands_update` at
the source now (19–50KB per event), not just at dispatch's own
already-existing filter — belt and suspenders, since the log is shared by
anything that subscribes to it, not just spaces. Covered by
`session-manager.test.ts`'s "in-band turn boundaries and raw-log cleanup"
block (added in the approvals pass below; this pass originally claimed
these tests but hadn't written them).

**Permission requests** — superseded by the approvals pass below. This
pass auto-declined them; that was replaced once the product decision
below made the requester always the owner.

## Lane 5 continued — the renderer no longer holds the PAT (this pass)

`RelayRoomSource` used to take the relay PAT directly (`token` option) and
make its own `fetch`/WebSocket calls from the renderer — flagged for
review in lane 3's own header comment. tap-spaces' `feat/spaces-relay` now
mints short-lived (~10 minute), single-binding realtime tickets
(`POST /v1/me/bindings/:id/realtime-ticket` — see its `SPACES_NOTES.md`
"Realtime ticket" section) specifically to remove that need. This pass:

- **Every HTTP call `RelayRoomSource` makes now goes through main.**
  `main/rig/spaces-connection.ts`'s `rig.spacesConnection` RPC controller
  gained `mintRealtimeTicket`/`listMembers`/`listMessages`/
  `getSessionEvents`/`postMessage`/`requestOwnAgent`, each a thin proxy
  over `SpacesRelayApi` (`main/rig/spaces/relay-api.ts` — reused, not
  re-wrapped; it already had every one of these calls except
  `mintRealtimeTicket`, added there alongside it). `RelayRoomSource` takes
  a small injected `RelayRoomClient` interface mirroring these 1:1 instead
  of `fetchImpl`+`token`; `room-view.tsx`'s `createRelayRoomClient()` is
  the one real implementation, a pass-through over `rpc.rig.
  spacesConnection`.
- **The Hocuspocus connection opens with a minted ticket, not the PAT.**
  `@hocuspocus/provider`'s `token` option accepts a function
  (`() => Promise<string>`), not just a static string — exactly the hook
  needed. `RelayRoomSource.ensureFreshTicket()` mints one via
  `RelayRoomClient.mintRealtimeTicket`, caches it, and re-mints once it's
  within 60s of its own `expiresAt`. Since Hocuspocus calls this function
  again before every reconnect (`onAuthenticate` runs once per document
  open), a fresh ticket is supplied automatically on both a normal
  connect and any later reconnect, without this class needing to know
  when a reconnect happens.
- **`getConnectionInfo` no longer returns a token of any kind.** Its
  result is now `{relayUrl, wsUrl, selfUserId}` — `mintRealtimeTicket` is
  the only credential this controller ever hands the renderer, scoped to
  one binding and ~10 minutes.
- **Tests**: `spaces-connection.test.ts` (new) proves the no-token
  contract directly and that every proxy method delegates to the relay
  client with the right arguments. `relay-room-source.test.ts` was
  rewritten against a fake `RelayRoomClient` (in place of a fake `fetch`)
  plus a new case proving the provider is handed a ticket minted through
  that client, not a static token.
  `relay-room-source.integration.local.test.ts` (gated,
  `SPACES_INTEGRATION_RELAY_URL`) now plays main's part directly
  (`directHttpRelayClient`, since this renderer-only test process has no
  real Electron main to proxy through) and asserts a REAL ticket was
  minted (`relay.mintCalls > 0`) before asserting the message round-trip —
  see this task's own final report for the live run's actual output.

## Approvals pass — owner approves in their own card; own agents only

**Product decision (Dylan, 2026-09-23): no cross-person delegation in the
MVP.** `@claude`/`@codex` always means the sender's own agent, running on
their own machine. The relay enforces it: POST agent-requests defaults the
target owner to the caller and returns 403 `agent_request_not_own_agent`
for anyone else (tap `feat/spaces-relay`). So the requester is always the
owner, and approvals belong to them.

- **dispatch.ts** holds each permission request per run instead of
  settling it. It records `permission_requested` with `requestId`, the tool
  title, and the offered options. `resolvePermission(runId, requestId,
  optionId)` answers with the owner's choice and records
  `permission_decided` (`allowed`/`declined`). Anything still held when the
  turn ends or is stopped is settled `cancelled` so no card keeps it
  pending. A request that beats its own `turn_start` marker (it arrives on
  the session-state channel, not the raw stream) is attributed to the
  oldest queued turn. Nothing is ever auto-approved or auto-declined.
- **RPC** `rig.spacesDispatch.resolvePermission`: owner-only in the UI and
  structurally in main (a device that didn't dispatch the run finds
  nothing).
- **Session card**: the owner sees the approval prompt
  (`features/chat/permission-prompt.tsx`, extracted from the chat composer
  so both surfaces are the same component). Everyone else sees at most one
  muted "Waiting on X's approval" line while it's pending, and nothing once
  it's decided. The detail stays in the step log. The principle: the space
  keeps the full trace but doesn't push every agent's details at everyone.
- **Composer**: the mention picker lists only the viewer's own agents.

## Parked post-MVP

- **Cross-person delegation** (tagging a teammate's agent). It needs a
  consent model for running someone else's prompt on your machine. Relay
  and desktop both refuse it today.
- **Jev dispatcher** (tap `src/dispatch/*`, `TAP_DISPATCHER=1`). The code
  is kept and off by default. It is the one path that can still write an
  owner≠requester request row, so revisit it with delegation. Candidate
  uses once revived:
  - should my agent speak up untagged;
  - is a thread reply a steer or a new request;
  - resolving same-passage edit conflicts;
  - is this a task for a teammate's agent, or a question the space's
    trace can answer.

