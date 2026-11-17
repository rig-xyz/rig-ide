---
name: rig-artifact-import
description: Turn a Claude artifact (or any single-page tool a person already runs their work from) into a Rig space that looks and works like it, as far as Rig allows. Use when someone posts an artifact link, pastes or attaches an artifact's code, or says "bring my artifact in", "make this space like this artifact", "I run this from an artifact today", "import this dashboard".
---

# Bringing an artifact into a space

Someone already runs a piece of work from an artifact: a page they built with Claude that lists things, shows where they stand and has buttons. They want that work to live here instead, where it can run without them, stay fresh, and be shared. Your job is to make the space feel like the page they know, on the first try, and to be plain about what changed.

An artifact is a picture of a factory with no engine. It shows the work and offers buttons, but nothing fills it between visits and its buttons reach no one. A Rig space supplies the engine: files that hold the data, sessions that refresh it on a schedule, buttons that reach the person's own agent. So an import is two things at once: keep the look and the words, and give each part something real behind it.

Read the rig-views skill (and its `design.md` and `components.md`) before you write a page, and the rig-factory skill before you put anything on a schedule. This skill only says how to carry an artifact over; those say how views and standing work are built.

## 1. Get the artifact itself

You need its source, not a description of it.

- **Code pasted or attached:** use it as given.
- **A link:** try to read it with the tools you have (a browser tool, a fetch). A published artifact's link opens for anyone. A private one will not open for you: say so in one line and ask the person to paste the code or attach the file (in Claude, the artifact's menu has Copy and Download).
- **Only a screenshot or a description:** you can still build from it, but say that you are working from a picture, so labels and data are your reading of it.

Keep what you were given, unchanged, in `imports/<name>/original.html` (or `.jsx`, `.md`), so the person and later sessions can compare against it. Never run it, and never load anything it points to on the network.

## 2. Read it as a factory, before you build anything

Go through the source and write down, for yourself:

- **The jobs.** What does a person come to this page to do or see? Each tab, section or screen that answers its own question is one job. A page with a queue, a board and a log is three.
- **The things.** What items does it list (drafts, bugs, deals, invoices)? What fields does each carry, and which of them does the page actually show?
- **The words.** Its title, section names, column names, status names, button labels, empty-state lines. These are the person's vocabulary. Keep them exactly.
- **The order and grouping.** What comes first, how items are grouped and sorted, what is folded away.
- **The actions.** Every button and control: what it claims to do, and what it really does in the artifact (usually: changes the page's own memory, or nothing).
- **Where the data comes from.** Hard-coded sample rows, something the person pastes in, the page's own storage, a call to Claude from inside the page. Sample rows are examples, not facts: do not carry them over as if they were real work.
- **What it implies about the process.** Stages an item moves through, who acts at each, what "done" means, how often it should be fresh.

If any of these is unclear and would change what you build, ask one question. Otherwise decide, and note the assumption.

### A large artifact: tabs, screens, shared data

Many artifacts people run real work from are several pages in one: a row of tabs, a sidebar of screens, a detail panel that opens over a list. Treat each as its own job.

- **List every tab and screen first,** by the name on it, with one line on what it is for. Read the whole source for this; tabs are often built from one array or a `switch`, and some only appear in certain states.
- **Each tab becomes a view,** with the tab's own name as its title and the artifact's left-to-right order as its `order`. Do not merge two tabs into one view to save work, and do not split one tab into several unless it plainly holds two jobs.
- **A screen inside a tab** (a detail panel, a drill-down) stays inside that view: an item that opens, or a section lower on the page. It is not a tab of its own.
- **Data several tabs share** (one list shown as a queue in one tab and as counts in another) is read once by the pass and written into each view's `data.json` in the shape that view needs. Views do not read each other's data.
- **Numbers on a tab's label** (a count badge) become that view's `count` in its `tab` block, so the badge shows on the tab in Rig too.
- **Controls that span tabs** (a global filter, a date range) are repeated on each view that needs them. Say that they no longer carry across tabs.
- **Build in the artifact's order of use,** the tab the person lives in first, and show it before building the rest. Tell them the full list of tabs you found and the order you will build them in, so they can correct it before you spend the effort.
- **Say which tabs you left out and why** (a settings screen with nothing to set here, a debug tab), instead of dropping them silently.

## 3. Map it onto the space

| In the artifact | In the space |
|---|---|
| One job (a tab, a section, a screen) | One view under `views/`, named in the person's words, with an `icon` and an `order` that follow the artifact's own order |
| Its items and their fields | That view's `data.json`. Real items only; empty if you have none yet |
| A button | An action on a decision card or row that reaches the person's agent, with the same words on it |
| Its filters and groupings | The same filters and groups, built from the view bricks |
| Its statuses and their colours | The same status names. Colour only where it says state, using Rig's state colours |
| Its hard-coded rules, limits and stages | The space's contract (`FACTORY.md`), written with the rig-factory skill |
| "Refresh" by hand, or data pasted in | A source the agent reads, and a schedule |
| The page's own memory of what was clicked | The space's files: a choice is recorded, and it changes the data on the next pass |

Pick the nearest view template for each job (a queue of decisions, a board by status, an intake list, a feed, a tracker) and arrange it to match the artifact's layout: same columns in the same order, same grouping, same first screen.

## 4. Keep the look and feel, within Rig's own

The person should recognise their page. What carries the recognition is structure and language, so hold those exactly:

- the title and every label, in their words;
- what is on the first screen, and in what order;
- how dense it is: if their page is a tight table, do not hand back roomy cards, and the reverse;
- the columns, groups and counts they are used to reading.

What does not carry over is the artifact's own styling. Views use Rig's stylesheet, its spacing and its colours, so the page sits right in the app and in both light and dark. Do not copy the artifact's fonts, hex colours, gradients, shadows or custom CSS. Where the artifact used colour to tell categories apart, use plain tags; where it used colour for state, use Rig's state colours. A chart or custom graphic the bricks cannot draw becomes the nearest honest thing (a few numbers, bars, a meter), and you say so.

## 5. Give it an engine

Do not stop at a page that looks right and does nothing. For each view:

- **Fill it with real work.** Ask where the real items live today (a tool, a folder, their head) and read them from there. If there is nowhere yet, start empty with a clear empty state, not with the artifact's sample rows.
- **Make each button real.** Decide what the agent does when it is pressed, and whether that step leaves the space (posting, sending, merging). A step that leaves the space waits for the person's yes.
- **Decide how it stays fresh,** with the rig-factory skill: what a pass does, how often, and what it never does without asking.

One pass should run before you say it is done, so the person sees their page with real data in it.

## 6. Look, then tell them

Look at each view with `rig_view_look` and compare it with the original: same words, same order, same first screen. Fix what drifted.

Then say, briefly:

- which tabs now exist, and which part of their artifact each one is;
- what works now that did not before (it refreshes, the buttons reach you, others can see it);
- what changed in the look, and why (Rig's styling, a chart turned into numbers);
- what you could not carry over, plainly, with what you did instead;
- what you assumed, and the one thing you most want them to check.

Ask them to open the first tab and say what feels wrong. The first version is a draft they correct, not a finished copy.

## What never comes over

- Network calls from the page, scripts loaded from elsewhere, and anything that phones home. A view cannot reach the network, by design.
- Calls to Claude from inside the page. In a space the agent does that work between visits and writes the result into the data.
- Secrets, tokens or keys found in the source. Do not copy them anywhere; tell the person they were there.
- Other people's personal data in sample rows. Leave it in the kept original and out of the views.
