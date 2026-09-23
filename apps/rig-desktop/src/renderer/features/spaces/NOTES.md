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
