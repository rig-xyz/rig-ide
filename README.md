# Rig

Rig is a collaborative agent workspace: a desktop app where agents and
humans work on the same material — co-editing living documents,
discussing them in anchored comment threads, and following agent work on
a live task board. It is powered by the [rig](https://userig.xyz) CLI
and the tap sync layer, so what you see in the app is shared with your
workspace: comments land on the hub, the task board mirrors the agent's
own plan, and an @mentioned agent replies in the thread you asked in.

## Features

- **Living documents** — Markdown files open as a clean writing surface
  (CodeMirror 6) with autosave and a Source/Preview toggle. When an
  agent edits the file you have open, the change is absorbed in place
  with your cursor and scroll preserved.
- **Anchored comment threads** — Select text to comment. Threads persist
  to your workspace's tap relay and stay attached to the passage they
  were made on, re-anchoring as the document changes. Reply, resolve,
  filter, collapse; unread tracking is built in.
- **Agent thread participants** — @mention an agent in a comment and it
  joins the thread: it reads the context, replies in place, and keeps
  the conversation going without further mentions. Tool permission
  prompts render directly in the thread, and the agent can edit the
  document the tab has open.
- **Transcript threads** — Reply in a thread on any agent message or
  tool call: reactions, a reply-count thread bar, and a sidebar thread
  pane with live-streaming agent replies.
- **Rig Tasks** — A right-sidebar board that mirrors the agent's plan as
  it works, published to your workspace so collaborators see progress
  live.
- **Parallel agents** — Everything the upstream app does: run multiple
  coding agents at once, each isolated in its own Git worktree, review
  diffs, and merge what works.

## Development

Requires Node >= 24 and pnpm >= 10.28.

```sh
pnpm install
pnpm -C apps/emdash-desktop run dev
```

## Built on Emdash

Rig is built on [Emdash](https://github.com/generalaction/emdash) by
General Action, Inc. — an open-source desktop app for orchestrating
coding agents in parallel, each in its own Git worktree. Emdash's
architecture is what makes Rig possible: the session engine, the
worktree isolation model, and the chat surface all come from upstream,
and they are excellent foundations to build on. If you want a
general-purpose parallel-agent workbench rather than a rig/tap-connected
workspace, use Emdash.

## License

Apache-2.0. See [LICENSE.md](LICENSE.md) and [NOTICE](NOTICE).
