---
name: rig-views
description: Build a live view in a Rig space (a board, a feed, drafts waiting for review, PRs in flight, a tracker) as a page that Rig shows as a tab, keeps fresh from data, and that sends the person's choices back to you. Use when work in a space would be clearer seen than told, when the person asks to see, review or track something, when a step needs their decision, or when you will keep updating the same picture on a schedule.
---

# Rig views

A view is a tab in a Rig space that shows the state of some work at a glance, stays live, and lets the person make their calls from it. You build it once and then mostly refresh its data.

**Read these before you build, every time. They are short and they are the difference between a page and a useful one:**

- `design.md`, next to this file: how to decide what a view shows and in what order. Read it first.
- `components.md`: every class and runtime function the page can use, exactly.
- `templates/`: six finished view types with sample data (`board`, `intake`, `prs`, `tracker`, `feed`, `review-queue`). **Start every view from the closest template**: copy it, point it at your data, and change what the work needs. Build from nothing only when no template fits, and say so.

```
views/<name>/index.html   the page: layout + a render(data) function
views/<name>/data.json    the state: you rewrite this on every refresh
views/<name>/view.json    what it is, who it is for, and how it stays fresh
```

`<name>` is lowercase letters, digits and dashes. There is nothing to open and no tool to call: as soon as `views/<name>/index.html` exists in the space, Rig shows it as a tab for everyone there, and the open tab updates within a second of any change to `data.json`.

## Where the page runs

Rig runs your page in a sealed frame. Knowing its walls saves you from building something that silently does nothing:

- **No network.** No `fetch`, no API calls, no CDN scripts, fonts or stylesheets, no remote images. Everything the page shows comes from `data.json`. If the view needs something from outside (a feed, an inbox, a tracker), you fetch it in your turn with your tools and connectors and write the result into `data.json`.
- **Images only as `data:` addresses** inside the data or the page. Prefer `av(name)` for people and text for the rest.
- **Links open in the person's browser.** A plain `<a href="https://…">` works: Rig hands the click to their own browser. Link every item to where it came from (the issue, the thread, the document). Only web addresses open; a file in the space is named by its path, not linked.
- **No storage, cookies or access to the app.** Page state lives in `rig.state` and lasts while the tab is open.
- **You cannot preview it yourself.** Opened any other way (the browser tools, a file link) the page has no runtime and comes up blank; that is expected and says nothing about the tab. Check your work by reading the page and the data, keep the render function simple, and ask the person what they see.
- **Rig supplies the stylesheet and the runtime.** Keep the two `../_rig/` tags from the skeleton exactly as written; Rig replaces them with its own copies. Never create a `views/_rig/` folder and never paste the runtime or the stylesheet into the page.

## When to make one

- The answer is a picture of many things (20 issues, 9 PRs, 14 Slack threads), not a sentence.
- You'll come back to it: a watch, a loop, a release. A one-off answer stays in chat.
- The person needs to act from it: decide, merge, collapse, assign. Then it carries actions.

Say in the Room what you made, in one line, with the tab. Don't make a view nobody asked for unless the work clearly needs one; offer it instead. (A factory's first page is the exception: `rig-factory` says to build it unasked.)

## Build it

0. **Pick the template.** Rig views are made of the same bricks so they look and behave alike: the header, Rig's note, cards, rows, pills, tags and the action card, each already wired to what Rig can do (a button reaches the person's session, a link opens in their browser, a person shows as themselves, a changed item flashes). A template is those bricks arranged for one kind of work. Choose by the work, not by the look: see "Templates" below.
1. **Decide the one job.** "Where does the bug bash stand?", "What's waiting on me?". The header says it; everything else serves it.
2. **Shape `data.json` first.** It holds two kinds of things, and nothing the page can work out itself:
   - **Facts from the sources:** ids, titles, status, people, times (ISO with a zone, e.g. `2026-10-31T11:30:00Z`), links.
   - **Your judgement:** what only you know or decided — inferred links ("#371 fixes APP-570, best match"), the one-paragraph summary, notes on an item, what failed to load. Put these under `rig` keys (`"rig": {"summary": …, "notes": {"APP-570": …}}`).
   Also the `"tab"` block Rig reads for the tab list: `{"sub": "4 to review", "count": {"usr_…": 4}}` (see "The manifest" in `components.md`).
   Groups, counts, sorting and "what needs you" are **derived in the page** from the facts, so a refresh is just new facts plus a new summary. Include `"read_at"` and, if a source failed, `"sources": [{"name", "ok", "last_ok"}]`.
3. **Write `index.html`** from the skeleton below. Use `rig.css` classes first. A page-level `<style>` or inline `style` is fine for layout (grid columns, widths, gaps) and must use only the tokens (`var(--fg-2)`, `var(--line)`…), never raw colors, fonts or sizes outside the scale.
4. **Write `view.json`** (example below). The tab appears by itself.
5. **Refresh by rewriting `data.json` only.** The page re-renders within seconds. Rewrite `index.html` only when the layout itself should change, and say so in the Room ("grouped it by area, columns are one click back").

```html
<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Bug bash 2.3.0</title>
<link rel="stylesheet" href="../_rig/rig.css">
<script src="../_rig/rig-view.js"></script>
</head>
<body>
<main class="rv-page" id="root"></main>
<script>
const { h, tag, prio, av, ago, time, state } = rig;
state.filter ??= 'all';

const card = (i) => h`
  <article class="rv-card" data-key="${i.id}">
    <div class="rv-card-meta"><span>${i.id}</span>${i.env ? tag(i.env, i.env === 'prod' ? 'bad' : 'accent') : ''}
      <span class="rv-end">${prio(i.priority)}${av(i.owner)}</span></div>
    <div class="rv-card-title">${i.title}</div>
  </article>`;

rig.mount((d) => {
  const shown = d.issues.filter((i) => state.filter === 'all' || i.env === state.filter);
  return h`
    <header class="rv-head"><div>
      <span class="rv-eyebrow">Linear · Bug bash 2.3.0</span>
      <h1 class="rv-title">Where the bug bash stands</h1>
      <span class="rv-meta">${d.issues.length} issues · read at ${time(d.read_at)} (${ago(d.read_at)})</span>
    </div></header>
    <div class="rv-chips">${['all', 'prod', 'stg'].map((f) =>
      h`<button class="rv-chip" data-filter="${f}" aria-pressed="${state.filter === f}">${f}</button>`)}</div>
    <div class="rv-cols" style="--cols:3">${shown.map(card)}</div>`;
});

document.addEventListener('click', (e) => {
  const f = e.target.closest('[data-filter]');
  if (f) { state.filter = f.dataset.filter; rig.rerender(); }
});
</script>
</body>
</html>
```

- `h` escapes every value and nests freely (an inner ``h`…` `` stays markup). Wrap other markup you built yourself in `raw()`.
- `render` returns the page's markup; `rig.mount` puts it in `#root`.
- **`data-key` on every item** (issue id, PR `repo#n`, thread id). After a refresh, only items whose key is new or whose markup changed flash, so the person sees exactly what moved. Give numbers a key too (`data-key="stat-open"`).
- **Page state** (filters, open groups) lives in `rig.state`; change it and call `rig.rerender()`. It survives refreshes.
- `av(name)` draws a person. `time(iso)` shows a time in the viewer's clock; `ago(iso)` shows how long ago. Never print raw UTC, and never write clock times into your summary text (say "since the last read", or put the time in data and let the page format it).

`view.json`:

```json
{ "kind": "board", "icon": "bug", "order": 1, "title": "Bug bash 2.3.0", "made_for": "Dylan: where the bash stands and what needs him",
  "sources": ["linear:project/Bug bash 2.3.0", "github:acme (open PRs)"],
  "refresh": "Re-read the project and the open PRs. Keep my notes on items that are still open.",
  "every": "30m", "runs_as": "usr_…" }
```

`icon` is the view's icon in the tab list and in the pill: the name of any [Lucide](https://lucide.dev/icons) icon, in kebab-case. Pick the one that says what the view holds, not what kind of page it is, and give each view in the space a different one so they can be told apart at a glance: `inbox` for what came in, `pen-line` for drafts, `send` for what went out, `bug`, `git-pull-request`, `receipt`, `calendar-clock`, `megaphone`, `flask-conical`, `banknote`, `users`, `shield-check`. A name Lucide does not have falls back to the icon of the view's `kind`.

The tabs, and what you may change about them:

- **Name:** the tab shows `title`. To rename a tab, change `title`. Never rename the view's folder to rename or reorder a tab: the folder name is the view's identity, and renaming it makes a new view (its tab shows as new, people's own tab order and hidden tabs forget it, and anything that points at the old path breaks).
- **Order:** set `"order"` to a number in each `view.json`, lowest first (1, 2, 3 in the order the work flows: what comes in, what waits for a decision, what went out, the numbers). That is the default for everyone. A person can drag the tabs into their own order and hide tabs they do not want; their arrangement is theirs, wins over `order`, and you cannot see or change it.
- **Removing a view:** delete its folder only when the view is truly finished or was an experiment the person agrees to drop. Say what you removed and where a copy is if you kept one.

## Keeping it fresh on a schedule

A view refreshes itself when its `view.json` says when and in whose session:

- When, one of:
  - `"every"`: how old the data may get, as `"30m"`, `"2h"` or `"1d"` (5 minutes at least). Use it for "keep this fresh".
  - `"at"`: a set time, for "every Friday at 3pm" or "each morning at 9". Write the days, then the time on a 24-hour clock: `"fri 15:00"`, `"mon,wed,fri 09:00"`, `"weekdays 09:00"`, or `"09:00"` alone for every day. Add `"tz"` with the zone the person meant (`"America/New_York"` for "3pm EST"); without it, the time is read on the clock of the Mac that runs it. Add `"from": "2026-11-27"` when it should not start before a day ("starting next week"). With `"at"`, leave `"every"` out.
- `"runs_as"`: the relay id (`usr_…`) of the member whose session does the refresh. That is your owner: the rules of this session give their id. It runs only in their Rig app, while it is open; a set time that passed while the app was closed runs when it opens.

When the data is older than `every`, or the time in `at` has come, Rig starts a turn in that member's session with `"refresh"` as the request, so write `"refresh"` as a full instruction to your future self: what to read, what to keep, what never to do. Leave the schedule out and the view is refreshed only when someone asks.

This is the only place a schedule lives. Rig shows it on the view's tab (how often or at what time, and when it is next) and everyone in the space can see it and stop it. Never set up a schedule outside Rig (launchd, cron, a calendar event, a reminder), even when the person asks for a day and time: write `"at"`. If what they ask for cannot be written here (say, the last day of each month), tell them what can, and do not go around Rig.

A view that carries standing work starts on a schedule (the `rig-factory` skill, "Before you finish the first session", says when that is safe to do unasked and which cadence). Any other view goes on a schedule only on the person's call. Either way the choice lives on the page, not in chat: a card above the rest with the current or suggested cadence first and the real alternatives ("Keep every 2 hours" / "Every hour" / "Daily" / "Only when I ask"; see `ask` in `templates/review-queue.json`). When the person chooses, write `every` (or `at`) and `runs_as` into `view.json` (nothing for "Only when I ask"), remove the card from the data, and say what you set in one line.

## Who is looking

`rig.me` (also `ctx.me`, the second argument of your render function) is the person looking at the tab: `{ id, name }`. `id` is their relay id (`usr_…`), `name` is only a label. The same view is open for every member, each seeing it as themselves.

- Anything meant for one person carries their id in the data (`"for_id": "usr_…"`), never their name: names are not unique and people change them. Keep the name beside it for display.
- Find ids with `rig_people_list`. Your owner's id is in this session's rules.
- In the page, `rig.who(id)` gives a member's name and `rig.people` the whole space, so the data only needs ids.
- Filter in the page: `d.steps.filter((s) => !ctx.me || s.for_id === ctx.me.id)`.

## Steps that need a person

When something waits on a person's decision (approve a draft, pick between options, allow something outward), show it as a card with `rig.card`:

```js
const { h, card } = rig;
rig.mount((d, ctx) => h`
  <div class="rv-stack">${d.steps.map((s) => card({
    id: s.id,                       // goes back to you with the choice
    title: s.title,                 // the proposed action, in plain words
    why: s.why,                     // one line of context: what it changes, why it waits
    label: 'Draft · #bug-bash',    // optional: a small line for the kind of step
    note: 'Change something first (optional)',   // placeholder of the line they can type; false for none
    actions: [                      // the proposal first, then real alternatives. Never a bare yes / no.
      { act: 'approve', label: 'Approve', primary: true },
      { act: 'rewrite', label: 'Rewrite' },
      { act: 'drop', label: 'Drop' },
    ],
  }))}</div>`);
```

When the person clicks, the card says "Sent to your session" and a turn starts in **their** session (each member's click goes to their own agent) with a request like:

```
From the "drafts" view, Dylan chose "approve" with:
- id: d1
- note: shorter, and say "the space"
```

In that turn: do what was chosen under the space's rules, then **rewrite `data.json` so the view shows where things stand**. A step that was taken leaves the list or says what came of it. If you leave the data unchanged, the card is offered again as if nothing happened. That one write, to the view's own `data.json` with your file tool, needs no approval; every other change still asks as usual.

Any button anywhere can do the same with `data-act="intent"` plus `data-…` fields, which arrive as the lines of the request.

## The look

Rig is quiet: cool slate neutrals, one blue accent, color only for state. Dark and light both follow the person. The classes and tokens are in `components.md`; how to use them well is in `design.md`.

## Rules

- **Actions go through Rig.** A button sets `data-act` (and data fields); the choice reaches the session of whoever clicked. That session acts under the space's permissions: posting, sending, merging or anything else outward still asks the person. The page itself can call nothing.
- **Outward steps are cards.** Something that would leave the space (publish a post, send a mail, post a review comment) is shown as a step for a person to choose, with the proposed step first and real alternatives ("Post this review as a comment" / "Ask the author" / "Skip"). This holds when the factory is show-only or read-only: a pill is a state, a decision is a card, and choosing the card is how the person lifts the limit for that one step. Nothing outward happens without their choice, and never in a scheduled refresh.
- **Plain words.** Name things the way the team does ("Waiting on you", "Fixed by #371"). No jargon, no invented numbers. Mark examples as examples.
- **Don't claim what the data doesn't say.** If there's no reviewer field, say "Needs a review", not "Waiting on you". Links you inferred are labelled as your best match.
- **Fresh and honest.** Show when the data was read. If a source failed, say which and when it last worked.
- **Small.** One screen of the important part, details on demand. Prefer 3–5 groups over 12.
- **Accessible.** Real buttons, text 4.5:1 (use `--fg-2`/`--fg-3`, never lighter), works at 400 px wide.
- **No secrets in data.json.** It syncs to everyone in the space.
- **Write `data.json` whole, as valid JSON, with your file tool.** A half-written file is ignored and the view keeps the last good data.

## Templates

| The work | Template | What it gives you |
|---|---|---|
| Calls for a person to make (drafts to approve, steps held for a yes) | `templates/review-queue.html`, `kind`: `queue` | Decision cards for the viewer, quiet rows for what waits on others and what is done |
| Things on a board by status (issues, tasks, deals) | `templates/board.html`, `kind`: `board` | Columns of compact cards with filters and "+N more" |
| What came in and what Rig did with each (threads, reports, mentions) | `templates/intake.html`, `kind`: `intake` | Two-sided rows: the item, an arrow, the outcome, with Undo |
| A stream to read (messages, notes, activity) in people's own words | `templates/feed.html`, `kind`: `feed` | A narrow feed with who, where, when, and a link to each source |
| Work grouped by who acts next (PRs, reviews) | `templates/prs.html`, `kind`: `prs` | Decision cards for the viewer's calls, then sections of five-cell rows for the rest |
| Where a piece of work stands (a release, a project) | `templates/tracker.html`, `kind`: `tracker` | Decision cards for what waits on the viewer, a few numbers, a progress meter, grouped rows |

In every template, whatever waits on the viewer is a card at the top, under the note; state pills are for items that only inform. When the page has more than a few items, order them: closest to an irreversible or outward step first, then urgent or money, security and other people's data, then what waits on the person, then oldest. The `kind` goes in `view.json` exactly as written here, not as the file name. Each template has a `.json` beside it showing the data shape. Copy the template's page, keep its structure and bricks, rename the fields to your data, and delete what the work does not need. Two templates can be combined on one page when the job needs both (a few numbers above a queue), but one job per view still holds.

When the work fits none of them, compose a new page from the bricks in `components.md`, and keep it as close to a template's structure as you can. If you find yourself writing a lot of your own CSS, you have left the system: step back and reuse a brick.

**Look at the page before you say it is done.** After you make or change a view, call `rig_view_look` with the view's folder name: Rig draws the tab the way the person sees it and gives you the picture, plus any error the page wrote. Check that the data shows, nothing is cut off, overlapping or empty that should not be, and the first screen holds what matters. Fix what is wrong and look again. Raise `height` for a long page. Only if the tool is not there do you say you could not see the page and ask the person what they see.

After a page exists, your reply in the Room is short: what you did, what waits on the person, the one thing to look at, and the tab's name. Do not list items that are on the page.
