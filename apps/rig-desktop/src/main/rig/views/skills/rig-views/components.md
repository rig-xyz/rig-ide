# What a view page has to work with

Everything here is supplied by Rig inside the frame. Use it as is: do not redefine these classes, load anything else, or paste Rig's files into the page.

## The runtime: `rig`

```js
const { h, raw, esc, card, note, pill, tag, prio, empty, av, ago, time, state } = rig;
rig.mount((data, ctx) => h`…`);   // ctx.me, ctx.state, ctx.changed
```

| | |
|---|---|
| `rig.mount(render, el?)` | Draws `render(data, ctx)` into `#root` now and again whenever the data or the viewer changes. Call it once. |
| `` h`…` `` | Builds markup. Every `${value}` is escaped; an inner `` h`…` `` or an array of them stays markup; `null`, `undefined`, `false` and `''` draw nothing. Use it for all markup. |
| `raw(html)` | Marks a string you built yourself as markup (an inline SVG). Never pass text from the data through it. |
| `card(step)` | The decision card. `step`: `{ id, label?, title?, body?, why?, note?, actions: [{ act, label, primary? }] }`. `label` is a small quiet line above everything, for the kind of step ("Draft · #bug-bash"). `title` is a short name for the step, in bold ("Assign 134 bugs to their owners"). `body` is the thing itself when it is text to read (a draft, a message): regular weight, line breaks kept. Use one or both; a draft is `body` only. `why` is one quiet line of context. `note` is the placeholder of the line the person can type, or `false` for none. All take text or `` h`…` ``. See SKILL.md, "Steps that need a person". |
| `note(text)` | Rig's note: what happened and what most deserves attention, with the Rig mark. Draws nothing when `text` is empty. Use this, not hand-built markup. |
| `pill(text, tone?, dot?)` | A state pill: `tone` is `ok`, `warn`, `bad`, `accent`, `violet`, `quiet` or empty for neutral; `dot` true puts a live dot before the text. Same as writing `.rv-pill` by hand. |
| `tag(text, tone?)` | A label on an item (`.rv-tag`): `tone` is `ok`, `warn`, `bad`, `accent`, `violet` or empty. |
| `prio(value)` | Priority as colored text (`.rv-prio-*`): `prio('High')`. Draws nothing for an empty value. |
| `empty(title, text)` | The empty state: a bold line saying what is missing, then when it will fill. |
| `av(name)` | A person, as a small colored initial. `av(null)` draws an empty one ("nobody"). Wrap several in `.rv-avs`. |
| `ago(iso)` | "3 min ago", "2 h ago", "4 d ago". Use it for freshness and waiting times. |
| `time(iso)` | A clock time in the viewer's zone; the date too when it is not today. Never print a raw ISO string. |
| `rig.state` | A plain object for page state (filters, what is open). It survives data refreshes and is lost when the tab closes. Set a default with `state.x ??= …`. |
| `rig.rerender()` | Redraw after you change `rig.state`. |
| `rig.me`, `ctx.me` | `{ id, name }` of the person looking, or `null` for a moment at first load: write `!ctx.me || …` in filters. |
| `rig.data` | The last data drawn. |
| `rig.act(intent, fields)` | Sends a choice from code. Prefer a button with `data-act`. |

Attributes the runtime acts on:

- **`data-key="…"`** on every item, number and note that can change. After a refresh, only elements whose key is new or whose markup changed flash. Keys must be unique on the page and stable across refreshes (the item's own id, not its position).
- **`data-act="intent"`** on a button, plus any `data-…` fields (`data-id`, `data-to`). A click sends the intent and the fields to the session of the person who clicked. Inside a `card`, the typed line rides along as `note`.
- **`<a href="https://…">`** opens in the person's browser. Only web addresses; anything else does nothing.

Your own click handling (filters, disclosures) is a normal `document.addEventListener('click', …)` that changes `rig.state` and calls `rig.rerender()`. Give those buttons a `data-` attribute of your own, never `data-act`.

## The stylesheet: `rv-` classes

**Page**

| Class | Use |
|---|---|
| `.rv-page` | On `<main id="root">`. Padding, a column with gaps, 1280px at most. Add `.rv-narrow` (800px, centered) when the view is things to read or decide: a queue, a feed, a digest. Leave it wide for boards and tables. |
| `.rv-head` | The header: a `div` with `.rv-title` (the job, as a question answered) and `.rv-meta` (counts and freshness). `.rv-eyebrow`, a quiet line above the title, is only for where the work comes from when that is not the space or the tab ("Linear · Bug bash 2.3.0"); leave it out when it would repeat the space's or the tab's name, which the person already sees. Nothing else goes inside the header: numbers get their own block below. |
| `.rv-label` | A quiet section label in sentence case: the name of a board column or a list. Write it as words ("Waiting on others"), never in capitals. A second `<span>` inside it sits on the right (a count). It brings its own space above; do not add margins. |
| `.rv-sec` | A section heading with a dot: `<h2 class="rv-sec"><span class="rv-dot warn"></span>Waiting on you<span class="n">2</span></h2>`, then a `.rv-panel`. Use it when each group has a meaning (who it waits on); use `.rv-label` for plain names. |
| `.rv-foot` | A last line: sources, what was left out, caveats. |
| `.rv-note` | Drawn by `note()`. One per view, at the top. |
| `.rv-step` | Drawn by `card()`: label, title or body, context line (`.rv-step-why`), note field (`.rv-step-note`), buttons (`.rv-step-actions`). Do not build it by hand. |
| `.rv-empty` | Nothing to show: a dashed box with what will appear and when. |

**Containers**

| Class | Use |
|---|---|
| `.rv-panel` | A bordered surface for a list. Put `.rv-rows` or `.rv-group` + `.rv-rows` inside. |
| `.rv-rows` > `.rv-row` | Table-like rows. Set the columns on the row: `style="--row: 90px minmax(0,1fr) auto"`. Stacks under 760px (then place the cells yourself with `grid-template-areas` in your `<style>` if the stack is too tall, see `templates/prs.html`). A `.rv-pill` or `.rv-btn` directly in a row stays its own width. |
| `.rv-row-title`, `.rv-row-meta`, `.rv-id` | Row text: a 13px medium title cut to one line (a link inside stays plain), a quiet 12px line under it (author, size, time), and a mono id that is cut to one line. Put title and meta in a `.rv-stack`. |
| `.rv-group` | A group header inside a panel: label left, count right. |
| `.rv-cols` > `.rv-col` | A board. `style="--cols: 3"` (default 3). Each column a `.rv-label` (name left, count right), then cards, then an optional `.rv-more` line ("+5 more: …", quiet). Columns are at least 250px wide, so a phone scrolls sideways and snaps to a column. |
| `.rv-flow-head`, `.rv-flow` | Two sides of one item, joined by an arrow: `.rv-flow-in` (a `.rv-card-meta` line, then `.rv-flow-text`), the `rv-arrow` svg, `.rv-flow-out` (a `.rv-pill`, a `<span>` with the result, a quiet button). `.rv-flow-head` is the two column labels above the list; put the rows in `.rv-list`. Under 760px the sides stack and the arrow is hidden. See `templates/intake.html`. |
| `.rv-card` | One thing on a board: `.rv-card-meta` (the id as a link, a `tag`, then priority and owner pushed right inside `.rv-end`), `.rv-card-title` (13px, medium), and at most one `.rv-pill` saying what Rig found. Add `.focus` (needs the person), `.live` (being worked on) or `.done`. `.edge-ok`, `.edge-warn`, `.edge-bad`, `.edge-accent`, `.edge-violet` tint the card's whole outline to carry a state or a fit (never a thick bar down one side). An `.rv-av` inside a card is drawn at 18px. |
| `.rv-split` | Two sides, the left a little wider. Stacks under 760px. |
| `.rv-stack` | Lines stacked tightly. |
| `.rv-list` | Separate bordered items (flows, steps) stacked with a gap of 8px. |
| `.rv-line` | Bits in a row that wrap (a name, a pill, a time). |

**Small parts**

| Class | Use |
|---|---|
| `.rv-pill` + `.ok` `.warn` `.bad` `.accent` `.violet` `.quiet` | A state, in words, 11.5px. Plain for neutral, `.quiet` for "skipped" or "dropped". `.violet` is for what Rig grouped (a hypothesis, a theme), not a state. `.rv-dot` inside it for a live dot. Use a `<span>` inside a `.rv-line`: directly in the page column it stretches to full width. |
| `.rv-dot` + `.ok` `.warn` `.bad` `.accent` `.violet` | A 7px dot. Inside a pill it takes the pill's color; on its own (in `.rv-sec`) give it a tone. |
| `.rv-tag` | A label on an item (an environment, a topic), 11px. Plain by default. Tint it only when the value is a state the person must see: `.bad` for prod, `.accent` for staging. |
| `.rv-chips` > `button.rv-chip[aria-pressed]` | Filters. A `<span class="n">` inside a chip is its count, in grey. |
| `.rv-btn` + `.primary` `.quiet` `.sm` | Buttons. One `.primary` per decision at most. `.quiet` for a minor action in a row (no border). `.sm` for a button inside a row or a card. |
| `.rv-actions` | A row of buttons. |
| `.rv-stats` > `.rv-stat` > `b` + `span` | Numbers that are the point. Four at most. Its own block under the header, never inside `.rv-head`. |
| `.rv-bars` > `i` | A small trend: each `i` with `style="height:Npx"` (32 at most), `.hi` on the latest. |
| `.rv-meter` > `i` | Progress: `i` with `style="width:N%;background:var(--accent)"`. |
| `.rv-av`, `.rv-avs` | Drawn by `av()`. |
| `.rv-prio-urgent` `-high` `-medium` `-low` `-none` | Priority as text color. |
| `.rv-small` | Smaller grey text. `.rv-clip` cuts to one line. `.mono` for ids and paths. `.sub`, `.muted` for quieter text. `.rv-end` pushes an item to the right end of a flex line (`margin-left: auto`). |

**Tokens**, for your own layout CSS. Use these and nothing raw (no hex, no font names, no sizes off this scale):

- Surfaces: `--bg-0` (page, input fields), `--bg-1` (cards, panels), `--bg-2` (group headers, hover), `--bg-3` (chips, tags)
- Text: `--fg` (titles), `--fg-1` (body text on cards and rows), `--fg-2` (secondary), `--fg-3` (quiet). Never lighter.
- Lines: `--line`, `--line-strong`
- State: `--accent` / `--accent-wash`, `--ok` / `--ok-wash`, `--warn` / `--warn-wash`, `--bad` / `--bad-wash`, `--vio` / `--vio-wash` (Rig's own groupings)
- Type: `--sans`, `--display` (the page title and big numbers only), `--mono` (ids, paths and code only, never for labels). Sizes in use: 11, 12, 13, 14, 15, 22, 26. Use the classes; do not set a size of your own.
- Space: `--s1` 4px, `--s2` 8px, `--s3` 12px, `--s4` 16px, `--s5` 24px, `--s6` 32px. Every gap, margin and padding you write is one of these.
- Radius: `--r-control` (8px, buttons and fields), `--r-card` and `--r-panel` (12px). Pills are fully round.

Dark and light both work without anything from you, as long as you only use tokens.

## What a page-level `<style>` is for

**Never put a class of your own on an `rv-` element.** A class that sets `display`, `gap` or a width on `.rv-note`, `.rv-label` or `.rv-row` breaks how it lays out (a label's count drops under it, a note's mark sits on its own line). To size or group things, wrap them in your own element, or use `.rv-narrow` on the page. The one exception is a class that only sets `--row` and, under 760px, `grid-template-areas` on a `.rv-row` (the examples call it `.pr`, `.item`): that is how a row gets its columns.

Layout only: grid columns, max widths, gaps, `white-space: pre-wrap` for text that has line breaks. A dozen lines is normal; a hundred means you are restyling Rig. If a component is missing, compose it from the parts above before inventing one.

## The page skeleton

```html
<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Short name</title>
<link rel="stylesheet" href="../_rig/rig.css">
<script src="../_rig/rig-view.js"></script>
<style>/* layout only */</style>
</head>
<body>
<main class="rv-page" id="root"></main>
<script>
const { h, card, note, av, ago, time, state } = rig;
rig.mount((d, ctx) => h`…`);
</script>
</body>
</html>
```

Keep the two `../_rig/` lines exactly like this. Rig swaps in its own copies; there is no such folder to create.

## The manifest: what Rig reads without running the page

Rig draws the tab list (and will draw notifications) from what the view declares about itself, never from the page. Two halves, in two files, because one changes rarely and the other on every refresh.

**`view.json`**, written when you build the view:

```json
{ "kind": "queue", "title": "Drafts to review",
  "made_for": "Dylan: drafts waiting for his call",
  "sources": ["notes/", "#launch"],
  "refresh": "Read FACTORY.md, draft from what changed, rewrite the data.",
  "every": "1h", "runs_as": "usr_…" }
```

- `kind` picks the tab's icon: `queue`, `board`, `intake`, `feed`, `prs`, `tracker`, or `page` for anything else. Use exactly these words, not the template's file name: `review-queue.html` is `queue`, `prs.html` is `prs`, `board.html` is `board`, `intake.html` is `intake`, `feed.html` is `feed`, `tracker.html` is `tracker`. (Rig also accepts `review-queue`, but write `queue`.)
- `title` is the tab's name. Two or three words.
- `every`, `runs_as`, `refresh`: the schedule (SKILL.md, "Keeping it fresh on a schedule"). Write them when the person picks a schedule on the page's schedule card, not before.

**`"tab"` at the top of `data.json`**, rewritten with the data on every refresh:

```json
{ "tab": { "sub": "4 to review", "count": { "usr_…": 3, "usr_…": 1 } }, "read_at": "…", … }
```

- `sub`: where things stand, in a few words ("4 to review", "9 open · 1 ready", "7 since yesterday"). It is the tab's second line.
- `count`: how many items wait on a person, shown as a badge on the tab. A number means the same for everyone; an object gives each member their own, by relay id (leave a member out when nothing waits on them). Count only what needs a person's action, never the size of the list.
- `status`: set `"failed"` when the refresh could not read what it needed, with `"note"` saying what in a few words ("Linear could not be read"). The tab says so in red. Leave both out when all is well.

Rig adds the rest itself: when the data last changed (a tab with no `sub` shows "updated 5 min ago"; a view on a schedule whose data is more than two periods old is marked stale), and who is looking.

## People

- `rig.me`: who is looking, `{ id, name }`.
- `rig.people`: everyone in the space, `[{ id, name }]`, kept current by Rig.
- `rig.who(id)`: a member's name from their relay id, or `null` if they are not in the space. Store ids in the data and let the page name people: `av(rig.who(i.owner_id))`. Keep a name beside the id in the data only as a fallback for people outside the space.
