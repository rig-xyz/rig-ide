# Rig

Rig is a collaborative agent workspace: a desktop app where people and
their agents work on the same material. A **rig** is a shareable folder —
documents, the skills and configuration that make an agent useful in it,
and the record of what everyone did. Open one, edit it, ask an agent to
work in it, share it with a teammate whose own agent then has the same
context.

Powered by the [rig](https://userig.xyz) CLI and the tap sync layer.

## Install

Download the app: **[dl.userig.xyz](https://dl.userig.xyz)** (macOS,
Apple silicon — signed and notarized).

The bundled CLI comes with it. To use rig from a terminal as well:

```sh
npm install -g @rigxyz/cli
```

## What it does

- **Home is a briefing.** A narrated summary of what changed across your
  rigs — written from real activity, with the people you work with and
  what they touched. Ask questions across everything you have access to
  ("what's changed recently?") and get answers with their sources.
- **Rigs, not projects.** Open a folder that is a rig and you get its
  files, its sessions, and its people. Markdown opens as a writing
  surface; code and config open with syntax highlighting; images preview;
  nothing is a dead end.
- **Agents you already use.** Claude Code, Codex, and any of ~35 harnesses
  the plugin registry knows: detected automatically, signed in from inside
  the app, with the model, reasoning effort and permission mode surfaced
  in the composer. Sessions persist and resume.
- **Anchored comment threads.** Select text to comment. Threads persist to
  the rig's relay and stay attached to the passage as the document
  changes. @mention an agent and it joins the thread, replies in place,
  and can edit the document you have open.
- **Sharing that agents understand.** Share a file by link and a human
  gets a readable page while an agent gets a self-describing protocol
  card it can act on. Invite teammates by email with view or edit access;
  they set the rig up on their own machine in one step.
- **Bring documents in.** Import from a Google Docs link or a `.docx`,
  converted to markdown with images extracted.

## Development

Requires Node >= 24 and pnpm >= 10.28.

```sh
pnpm install
pnpm -C apps/rig-desktop run dev
```

`apps/rig-desktop` is the app. `apps/emdash-desktop` is kept as the
upstream reference it was forked from and is not built or shipped.

## Built on Emdash

Rig is built on [Emdash](https://github.com/generalaction/emdash) by
General Action, Inc. — an open-source desktop app for orchestrating
coding agents in parallel, each in its own Git worktree. Emdash's
architecture is what makes Rig possible: the session engine, the ACP
runtime, and the chat surface all come from upstream, and they are
excellent foundations to build on. If you want a general-purpose
parallel-agent workbench rather than a rig/tap-connected workspace, use
Emdash.

## License

Apache-2.0. See [LICENSE.md](LICENSE.md) and [NOTICE](NOTICE).
