# Rig Resilience Roadmap

Status: accepted for implementation
Last updated: 2026-08-27
Scope: the "now" and "next" resilience work; broader collaboration features are intentionally excluded

## Implementation Status

- M0: lifecycle characterization coverage added as part of M1; structured lifecycle logging remains
  pending.
- M1: implementation complete in the working tree on 2026-08-24. Automated lifecycle, navigation,
  ACP cleanup, and registry stress tests pass. A packaged-app test with real providers remains before
  release sign-off.
- M2: implementation complete in the working tree on 2026-08-25. Acknowledgement, transaction
  rollback, ordered retry, pagination, renderer recovery, and rejection-settling tests pass. Manual
  packaged-app validation of native renderer-crash recovery and persistence degradation messaging
  remains before release sign-off.
- M3.1: implementation complete in the working tree on 2026-08-25. Opaque root capabilities,
  relative-only file/import operations, canonical containment, capability-scoped watchers, and
  adversarial path tests pass.
- M4.3: implementation complete in the working tree on 2026-08-27. Native command availability,
  Settings, focused-tab Close, Undo/Redo, update, feedback, and confirmed Quit are wired and tested;
  rejected sign-in, create/sync, file, import, and image operations settle visibly. A packaged-app
  pass over the real macOS menu remains before release sign-off. M3.2, M4.1, and M4.2 are not
  started.

The current wire protocol cannot cancel a truly never-settling ACP start or resume request. Renderer
operations are now safely serialized and late successes are cleaned up before a retry starts, but a
retry must wait if the underlying request never settles. True cancellation remains a future runtime
protocol change.

## Diagnosis

Rig's highest-risk failure mode is session lifetime being coupled to renderer view lifetime.
Collapsing chat, returning home, or switching rigs can unmount the view that owns live session
stores while asynchronous ACP startup and replay work is still completing. Related boundaries
also fail too quietly: navigation can resolve out of order, failed history writes are acknowledged
as success, renderer startup can remain blank, and several inherited desktop paths are either
over-broad or unnecessarily expensive.

The product outcome is not merely fewer crashes. A user should always understand whether an agent
is starting, active, resuming, degraded, or stopped, and ordinary navigation must never threaten
ongoing work.

## Guiding Policies

- UI visibility never determines runtime lifetime.
- Only an explicit user action terminates a session.
- Every loading operation reaches success, recoverable failure, or cancellation.
- Main owns filesystem security and persistence durability boundaries.
- Characterize the failure first, make the smallest viable correction, then stress the invariant.
- Use the existing TypeScript, MobX, typed RPC, Drizzle, Wire, and Vitest stack.
- Do not mix behavioral changes with broad formatting or inherited-code deletion.
- Keep diagnostics useful without logging prompts, file contents, or full working-directory paths.

## Program Definition of Done

- Hiding or navigating away never terminates an active session.
- Failed startup leaves no runtime, subscription, or stale renderer mutation behind.
- Starting and resuming are serialized per conversation and safe to retry.
- The latest navigation request always wins.
- Session history cannot be silently dropped.
- A renderer feature failure has a visible recovery path and useful diagnostics.
- Renderer file RPC cannot escape the opened rig root.
- Large repositories do not require a full-tree traversal before becoming usable.
- Enabled native macOS commands perform the same actions as their visible UI equivalents.
- Formatting, linting, type checking, focused stress tests, and the full test suite are green.

## Milestones

The estimates assume one primary engineer and include implementation, tests, and review. They are
planning ranges, not delivery commitments.

| Milestone | Scope | Estimate | Depends on |
| --- | --- | ---: | --- |
| M0 | Safety net and lifecycle diagnostics | 1-2 engineer-days | Nothing |
| M1 | Session ownership, ACP safety, and navigation ordering | 8-12 engineer-days | M0 |
| M2 | Recovery states and durable session history | 6-9 engineer-days | M0; M2.2 benefits from M1 |
| M3 | Filesystem containment and large-tree performance | 5-8 engineer-days | M0 |
| M4 | IPC/startup diet and native desktop completeness | 4-7 engineer-days | M1-M3 for final verification |

Expected total: 25-38 engineer-days, or roughly 6-8 weeks for one engineer with normal review and
stabilization overhead.

## M0: Safety Net and Diagnostics

### M0.1 - Lifecycle characterization

Add structured lifecycle logs containing `conversationId`, `rigBindingId`, `providerId`, a unique
`operationId`, lifecycle stage, result, and duration.

Add characterization tests for:

- disposal while `AcpLiveSession.create()` is pending;
- disposal while stored history is loading;
- a resume timeout followed by retry;
- slow rig A navigation followed by fast rig B navigation;
- collapsing and reopening chat with active sessions; and
- switching rigs while several turns are active.

Acceptance criteria:

- Tests detect late subscriptions, duplicate starts, and unintended stops.
- Each lifecycle transition can be followed in development logs without exposing user content.
- The current behavior is captured before ownership changes begin.

Primary source areas:

- `apps/rig-desktop/src/renderer/features/chat/rig-chat-store.ts`
- `apps/rig-desktop/src/renderer/features/chat/chat-panel.tsx`
- `apps/rig-desktop/src/renderer/lib/acp/acp-live-session.ts`
- `apps/rig-desktop/src/renderer/tests/browser/rig-chat-store.test.ts`

## M1: Session Lifecycle and Navigation

### M1.1 - Immediate lifecycle containment

- Add an explicit disposed state and bootstrap generation to `RigChatStore`.
- Check the generation after every asynchronous boundary.
- Dispose a session immediately if it arrives after its owning operation was invalidated.
- Prevent post-disposal MobX mutations and subscription installation.
- Apply the same rule to replay and preference-memory initialization.
- Add a monotonic generation to `openPath`; only the newest request may update the current rig.

Acceptance criteria:

- Disposing during create, resume, history load, or preference initialization leaves no live
  subscription or late state mutation.
- Overlapping navigation always displays the most recently requested rig.

### M1.2 - Introduce a `RigSessionRegistry`

Move session-store ownership outside `ChatPanel`, keyed by stable conversation ID. Keep the
registry focused on lifetime rather than rendering concerns.

Proposed contract:

```ts
attach(conversationId): RigChatStore;
detach(conversationId): void;
stop(conversationId): Promise<void>;
stopAll(reason): Promise<void>;
getActiveSessions(): RigSessionSummary[];
```

Required semantics:

- `attach` creates or reuses a live store.
- `detach` removes the view subscription but keeps the session active.
- collapse, home navigation, and rig switching detach rather than stop;
- closing a session explicitly stops ACP and marks stored history closed; and
- app shutdown performs bounded cleanup.

Acceptance criteria:

- Four active sessions survive 100 collapse, home, and rig-switch cycles.
- View detachment causes zero ACP stop calls.
- Explicit close causes exactly one stop and one stored-session close transition.
- Returning to a rig does not duplicate prompts or subscriptions.

### M1.3 - Make ACP startup and resume exception-safe

- Wrap runtime creation and live-model readiness in compensating cleanup.
- Stop the runtime and dispose replicas if readiness or history acquisition fails.
- Serialize start and resume operations per conversation.
- Give each operation an ID and reject late responses from invalidated operations.
- Distinguish timeout, provider failure, cancellation, and lost connection in user-facing state.
- Add real server cancellation later only if the existing protocol can support it cleanly; safe
  serialization and late-result rejection are required in this milestone.

Acceptance criteria:

- Failed startup returns the runtime/session count to baseline.
- Retry cannot overlap a still-running start or resume operation.
- A late result cannot replace a newer live session.

Primary source areas:

- `apps/rig-desktop/src/renderer/App.tsx`
- `apps/rig-desktop/src/renderer/features/chat/chat-panel.tsx`
- `apps/rig-desktop/src/renderer/features/chat/rig-chat-store.ts`
- `apps/rig-desktop/src/renderer/lib/acp/acp-live-session.ts`
- `apps/rig-desktop/src/main/rig/session-registry.ts`

## M2: Recovery and Durable History

### M2.1 - Explicit boot and renderer recovery states

Replace blank startup rendering with an explicit state machine:

```text
initializing -> ready
initializing -> degraded
initializing -> failed
```

- Always render the application shell.
- Show the current startup stage and a fallback when initialization exceeds its deadline.
- Provide Retry, Reload Window, and Export Diagnostics actions where applicable.
- Add a root renderer error boundary and a chat feature boundary.
- Handle rejection of dynamically imported transcript components.
- Forward structured renderer errors to the existing main-process logger.
- Handle `render-process-gone` and correlate the recovery screen with diagnostics.

Acceptance criteria:

- Startup cannot remain blank indefinitely.
- A chat rendering failure does not destroy the sidebar, editor, or other sessions.
- Every rejected sign-in, sync, file-read, and image-load operation clears its busy state.
- Diagnostics contain correlation data without transcript or file content.

### M2.2 - Acknowledged session persistence

Change event persistence to return an explicit acknowledgement:

```ts
{ ok: true, at, persistedThroughSeq };
{ ok: false, retryable, message };
```

- Advance the renderer persistence watermark only after acknowledgement.
- Maintain one ordered pending queue per session.
- Retry idempotently with capped exponential backoff.
- Prevent a later batch from overtaking an earlier failed batch.
- Use a transaction for event insertion and session status/timestamp updates.
- Flush on explicit close with a bounded timeout.
- Show a non-blocking "History is not being saved" state after repeated failure.
- Replace the silent 200-event replay cap with pagination or an explicit retention policy.

Acceptance criteria:

- Fault-injected database failures do not lose or reorder events.
- Recovery persists each sequence exactly once.
- Closing either flushes the queue or explicitly reports that it could not.
- Restart reconstructs the exact transcript order.

Implementation notes:

- Persistence uses an in-memory, per-session, single-flight queue. Acknowledged batches advance the
  local watermark; rejected batches retry with capped exponential backoff and cannot be overtaken.
- Explicit close waits for a bounded flush. If the queue cannot drain, the user is told that some
  history was not saved before the stored session is closed.
- Event insertion and session metadata updates share one SQLite transaction. No schema migration was
  required.
- Session replay is cursor-paginated with a bounded page size; the compatibility reader follows every
  page instead of silently truncating after 200 events.
- Renderer error reports use content-free structured metadata and a correlation ID. A crashed render
  process offers an explicit reload rather than automatically entering a crash loop.

Primary source areas:

- `apps/rig-desktop/src/main/rig/sessions.ts`
- `apps/rig-desktop/src/main/rig/sessions.db.test.ts`
- `apps/rig-desktop/src/renderer/features/chat/session-writer.ts`
- `apps/rig-desktop/src/renderer/features/chat/rig-chat-store.ts`
- `apps/rig-desktop/src/renderer/main.tsx`
- `apps/rig-desktop/src/main/lib/file-logger.ts`

## M3: Filesystem Safety and Large-Repository Performance

### M3.1 - Replace renderer absolute-path authority

Main issues a root or binding token when a rig opens. Renderer file calls use the token and a
relative path. Main normalizes the path, resolves canonical paths, verifies root containment, and
applies the same checks to listing, reads, writes, binary reads, and watchers.

Register legitimate Git worktrees as separate roots rather than weakening containment.

Tests cover:

- `..` traversal and absolute-path input;
- symlink escape and symlink loops;
- valid nested symlinks;
- valid linked worktrees; and
- watcher operations after a rig closes.

Acceptance criteria:

- No renderer request can access an unregistered path.
- Rejections are actionable without leaking unnecessary absolute paths.
- Existing legitimate worktree behavior remains supported.

Implementation notes:

- Each successful rig open receives an opaque, revocable `rootId`; renderer file RPCs and import
  destinations carry only that capability plus relative paths.
- Main canonicalizes registered roots, rejects POSIX and Windows absolute paths, traversal, empty
  segments, NUL bytes, broken/looping links, and links that resolve outside the root. Internal links
  remain readable, while rename/archive reject a symlink entry to avoid mutating its target.
- Root replacement/removal is rechecked for every operation. Node does not expose descriptor-relative
  `openat` mutations, so an external process replacing a validated parent in the final syscall window
  remains a narrow OS-level TOCTOU limitation; closing it would require a native helper and is outside
  the renderer-request containment threat model for this milestone.
- Watchers are reference-counted by `rootId`, handle asynchronous watcher failure, and are forcibly
  closed when the capability is released. Stale handles fail explicitly.
- Root registrations are capped, including registrations in flight, so repeated renderer calls cannot
  grow the capability table without bound.
- Native picker source paths remain an explicit machine-scoped import capability; every destination
  path, including imported assets and images, is resolved through the registered root policy.
- Linked Git worktrees register independently; their `.git` pointer file does not weaken containment.

### M3.2 - Lazy file tree

- Replace eager recursive listing with `listChildren({ rootId, relativeDirectory })`.
- Fetch children only when a directory expands.
- Cancel or ignore stale results for collapsed nodes.
- Cache children and invalidate them from filesystem watcher events.
- Render only expanded nodes.
- Reuse an existing virtualization primitive if one exists; avoid a new dependency otherwise.

Acceptance criteria on a representative 10,000-file repository:

- Opening the rig does not traverse the full tree.
- The initial request transfers only root children.
- Directory expansion shows feedback within 100 ms.
- Local results render within a provisional p95 budget of 200 ms.
- Rapid expand/collapse cannot insert stale children.

Primary source areas:

- `apps/rig-desktop/src/main/rig/files.ts`
- `apps/rig-desktop/src/shared/rig/files.ts`
- `apps/rig-desktop/src/renderer/features/workspace/file-tree.tsx`

## M4: IPC, Startup, and Native Desktop Completeness

### M4.1 - Slim agent-status RPC

Add a purpose-built endpoint for chat that returns only runnable state and compact display data.
Cache static provider metadata separately.

Acceptance criteria:

- Repeated status responses contain no embedded SVG or installation configuration.
- A typical response is below 50 KB.
- Development RPC logging records method, duration, status, and approximate size rather than full
  large results.

### M4.2 - Rig-specific startup composition

Classify each service initialized during main startup as:

- required before the first window;
- safe to initialize lazily;
- inherited and currently unused; or
- required for background correctness.

Measure packaged development and release builds before changing startup. Move safe services to lazy
initialization first. Remove inherited domains only after verifying they have no indirect consumers.

Acceptance criteria:

- The PR records time to window, time to usable shell, startup work, and renderer IPC volume before
  and after.
- Startup has fewer eager failure points without breaking background correctness.

### M4.3 - Wire native macOS commands and rejected-action states

Route Settings, Close Tab, Undo, Redo, Check for Updates, Give Feedback, and Quit through the same
command actions used by visible UI controls. Disabled commands must appear disabled rather than
silently doing nothing.

Ensure rejected sign-in, sync, file, and image operations always leave their busy state and present
an actionable result.

Acceptance criteria:

- Every enabled native menu item performs a visible action.
- Menu items and keyboard shortcuts share command behavior with their UI equivalents.
- Rejected operations never leave a permanent spinner or disabled control.

Primary source areas:

- `apps/rig-desktop/src/main/index.ts`
- `apps/rig-desktop/src/main/rpc.ts`
- `apps/rig-desktop/src/main/app/menu.ts`
- `apps/rig-desktop/src/renderer/features/chat/useRunnableAgents.ts`
- `apps/rig-desktop/src/renderer/lib/commands/`

## Final Stabilization Gate

- Run the lifecycle stress suite repeatedly.
- Run formatting, linting, type checking, focused tests, and the full workspace test suite.
- Resolve the current lint errors and hook-dependency warnings.
- If the existing broad formatting baseline remains, address it in a separate mechanical PR.
- Verify a packaged macOS build, not only the Vite development environment.
- Test sleep/wake, offline/online transitions, provider-process death, and renderer reload.
- Test both a small rig and a deliberately large repository.

## Delivery and Tracking

- Each numbered subsection should normally be one focused PR. Split it further if review becomes
  difficult; do not combine milestones merely to reduce PR count.
- PR descriptions should link this roadmap, name the acceptance criteria covered, list checks run,
  and include UI or diagnostic evidence where relevant.
- Update `Status` and this section when sequencing or scope changes. Record meaningful changes below
  so the roadmap remains a debuggable decision artifact rather than a stale checklist.

## Decision Log

- 2026-08-24: Accepted the eight-part resilience plan. Prioritized session ownership and recovery
  before broader human-agent collaboration features. Chose the existing technical stack and small,
  reversible PRs over a runtime or state-management rewrite.
- 2026-08-24: Implemented M1 with a renderer-level `RigSessionRegistry`, detach-versus-stop
  semantics, generation-guarded stores, exception-safe ACP startup/resume, and latest-wins rig
  navigation. Kept app shutdown under the existing bounded main-process ACP cleanup rather than
  marking resumable sessions closed from renderer unload.
- 2026-08-27: Implemented M4.3 with renderer-reported native menu capability state, focused-pane
  Close Tab behavior, editable-target Undo/Redo, shared update and feedback actions, and a native
  Cmd-Q confirmation that enters the existing bounded shutdown path. Kept unavailable commands
  disabled and added transport-rejection coverage for create, sync, file rename, import, sign-in,
  and image reads.
