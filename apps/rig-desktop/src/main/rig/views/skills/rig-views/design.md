# Designing a view that is worth opening

Read this before you write a view's first line. A view is not a report with a stylesheet. It is the place a person comes back to, several times a day, to see where some work stands and to make the few calls only they can make. Judge every choice by one question: when this person opens the tab cold, do they know in five seconds what changed, what needs them, and what to press?

## Start from the person, not the data

Before any markup, write three sentences for yourself:

1. **Who opens this, and when?** "Dylan, between meetings, to clear what waits on him." "The whole team, during the bug bash, to see what is unowned."
2. **What do they decide or do here?** Approve, pick, assign, read and move on. If the answer is "nothing, they just look", the view is a digest: make it short and make the top line carry the news.
3. **What would make them stop opening it?** Stale data, the same items every time, too much to scan, buttons that do nothing visible. Design against that from the start.

Put the answer to the second question at the top of the page. A view whose first screen is a header, four statistics and a filter bar has spent the person's attention before giving them anything.

## One job per view

Each view answers one question, and its title says which: "Drafts waiting on you", "What came in today", "Where the release stands". When you notice a second question creeping in (a review queue that also wants to be an archive, a feed that also holds settings), make a second view. Several small views that each read at a glance beat one page with sections.

A factory usually wants three, built one at a time as the need shows:

- **What came in**: the raw material the work is made from, with where each piece came from and a link to it.
- **What waits on you**: the calls only the person can make, as cards.
- **What went out**: what was done, by whom, with what result. This is where trust comes from.

## Order by what the person needs, not by how the data arrived

- **First: what needs them.** Cards for their decisions, at the top, with no scrolling.
- **Then: what changed since they last looked.** New, moved, finished.
- **Then: the rest**, compact, for reference.
- **Last: what was left out and why**, and where the data came from.

Inside a list, sort by what makes someone act: closest to an irreversible or outward step first (an approved PR, something about to ship or send), then urgent or money, security and other people's data, then oldest waiting. Never alphabetical, never the order of the source.

## Say the news in words

Open with one short note in plain words that a person could read aloud: what happened since the last refresh and the single thing most worth their attention. That is `rig.summary` in the data, shown in `.rv-note`. Write it fresh on every refresh. "Two new drafts from yesterday's launch notes. The pricing one makes a claim the site does not, so it waits for you." Not "5 items, 2 new, 3 pending".

Numbers support the note; they do not replace it. Use `.rv-stats` only when a number is itself the point (a count that should reach zero, a total against a limit), and at most four.

## Each item earns its lines

For every card or row, decide what the person needs to act on it without opening anything else:

- **The thing itself**, in full when it is short (a draft post, a one-line bug title), cut with care when it is long. Text meant to be read goes in the card's `body` at normal weight; bold is for a short title, never for a paragraph.
- **Why it is here**, in one line: where it came from, what it would change, why it waits.
- **What to check**, if there is something a careful person would verify first. Say it plainly on the item, not in a footnote.
- **The choice**, as a card: the action you propose first, then real alternatives.

Cut everything else. **Never show your own ids to the reader** ("p1", "p5", a row number, a record key): they mean nothing to them. Refer to an item by its title or its first words, as a link to its card where it has one. Internal ids nobody types, timestamps to the second, fields that are the same on every item, your own process notes. If you want to keep a detail, put it behind a disclosure (`rig.state` and a toggle), not on the surface.

## Pick the shape from the work

- **Where each thing stands, by status**: a board (`.rv-cols`), one column per status, cards ordered by urgency, each column cut to its top four with "+N more". `templates/board.html`.
- **Where each thing stands, by who acts next**: grouped rows, the group that needs the viewer first. `templates/prs.html`, `templates/tracker.html`.
- **What came in and what was done with it**: two-sided rows with an arrow. `templates/intake.html`. People's own words, in order: `templates/feed.html`.
- **A call to make**: decision cards. `templates/review-queue.html`.

## An item reads in three sizes

Dense is fine when the hierarchy is clear. On a card or row there are only three levels, and the eye should find the middle one first:

1. **A mono line** (11px, grey): the id as a link, a tag, priority, owner. It is for finding and sorting, not reading.
2. **The title** (12.5 to 13px, medium weight, near-white): what the thing is, in a sentence, cut to two lines at most.
3. **One quiet line or one pill** (11 to 12px): what Rig found or did ("#371 approved · ready", "Linked to APP-570"). Never both a pill and a line saying the same.

A card that needs a fourth line has too much on it: link to the source instead. A page needs a fourth size only for its title (26px) and, when a number is the point, a stat (22px).

## Cards are for decisions, rows are for facts

- Something the person must choose about: `rig.card` (the action, a line of context, alternatives, a place to type one line). One card per decision. Never a bare yes or no, never a checkbox.
- Something that is not actionable yet ("next pass", "waiting on a reply"): a compact row that opens on demand, never a full card. The cards on the page are the things to press now. See `templates/review-queue.html`.
- Something they only need to see: a row in `.rv-panel > .rv-rows`, or a small `.rv-card` in columns. No buttons unless pressing one does something real.
- Something that is finished: quieter still (`.done`, or a plain line in a list below).

The decision card reads top to bottom as: what kind of step it is (a small label), the thing to decide (the draft, or a one-line title), one quiet line of why and where from, a one-line field for changes, then the proposal as the one blue button with alternatives beside it. If the person has to read the quiet line to understand the title, rewrite the title.

A view with a primary button on every row has no primary action. If everything is offered equally, lead with the one you would take.

A state is a pill; a decision is a card. In every template, whatever waits on the viewer is a card at the top, under the note; state pills are for items that only inform (not looked at yet, nothing to decide, someone else's turn). If the person could do something about it (post this review, ask the author, skip it), do not show it as a pill like "Your call" or "Fix before merge": show a card with the proposed step first and real alternatives. This holds when the factory is show-only or read-only: choosing the card is how the person lifts the limit for that one step.

When a factory is ready to run on its own, ask on the page as a card above the queue ("Run this every hour while Rig is open": "Yes, every hour" / "Daily" / "Only when I ask"), not in chat. See `ask` in `templates/review-queue.json`.

## Links and sources

Every item that came from somewhere links to it: the issue, the thread, the file, the document. Links open in the person's own browser. Use the real name as the link text ("APP-490", "#371", "manifesto-v3.md"), not "link" or the bare address. A view that only restates things, with no way to the source, makes the person take your word for it.

A file inside the space is not a web address: name it by its path, in mono (`<span class="mono">notes/plan.md</span>`).

## Density and rhythm

- Lines of text: 60 to 90 characters. A view made of things to read or decide (a queue, a feed, a digest) uses the narrow page (`rv-page rv-narrow`), which centers one readable column. Boards and tables keep the full width.
- Group with space first, then a quiet label (`.rv-label`), then a panel. Avoid boxes inside boxes.
- Three to five groups. If you have twelve, most are noise: fold the small ones into "other".
- One screen should hold the part that matters. The rest scrolls or opens on demand.
- Color only says state: something needs attention (`warn`), is wrong (`bad`), is done (`ok`), is live or yours (`accent`). Never to decorate, never to tell categories apart. Categories get a plain `.rv-tag`; tint one only when its value is a state the person must see (`prod` in red, `stg` in blue). The violet pill is the one exception to "state only": it marks what Rig grouped (a hypothesis, a theme), so that grouping is visible across a board.

## Look and feel: the stylesheet decides, you arrange

The bricks already carry Rig's spacing, type and colour. A view looks off when its page fights them. Hold to these:

- **Use the bricks before writing CSS.** If you need a `<style>` block, keep it to layout (a grid's columns, a width). No font sizes, no colours, no borders, no shadows of your own.
- **Spacing comes from the scale** (`--s1` to `--s6`). Never a one-off number like 7px or 18px. Related things sit close (`--s1`, `--s2`); separate groups get `--s4` or `--s5`. A section's label has more room above it than under it; `.rv-label` does this itself.
- **Colour comes from the tokens,** and only to say state. No raw hex, no gradients, no new tints. One primary button per card; the rest are plain.
- **Labels are words in sentence case.** No capitals, no letter-spacing, no monospace for a label. Monospace is for ids, paths and code.
- **No line above the title that repeats the tab.** The person already sees the space and the tab's name; an eyebrow saying them again is noise.
- **A row of choices tops out at five.** Twelve chips under every card is a wall: show the three to five people use, and put the rest behind "More".
- **Text keeps a readable width.** A paragraph does not run the width of a wide page.
- **Then look.** Call `rig_view_look` and check the picture against this list before you say it is done.

## Every state is designed

- **Nothing to show yet**: still build the page, so the tab exists and the person sees the factory is in place and idle. A bold line saying what is missing and a line saying when it fills (`empty(title, text)`). Say what will appear and when ("No drafts waiting. The next pass adds some if the week had something worth posting."). Never an empty page.
- **Nothing for this person**: say so, and show what the others have if that helps them.
- **A source failed**: name it and when it last worked. Keep showing what you have.
- **Stale**: always show when the data was read (`ago(d.read_at)`). People forgive old data they can see is old.
- **A lot**: show the top few and a count of the rest, with a way to see them.
- **Sent, waiting**: after a click the card says "Sent to your session" by itself. Your job is the next state: rewrite the data so the item leaves or shows what came of it.

## The same view for different people

Everyone in the space sees the same tab, each as themselves (`ctx.me`). Decide what that means here:

- A queue of decisions: show mine first as cards; show others' as quiet lines ("Waiting on Lena: 2").
- A shared board: the same for everyone, with "mine" as a filter chip that is on by default when there is something of mine.
- A digest: the same for everyone.

Write people into the data by relay id, with their name beside it for display. Never hide something from a person by not rendering it: everything in `data.json` is readable by everyone in the space.

## Words

Write the way the team talks. The person's own names for things, not yours. Sentence case. No jargon, no cheerleading, no filler ("Here is an overview of"). Buttons are verbs that say what happens ("Approve", "Send to Sam", "Drop"). A label on a page is a word the person would use to a colleague. A code, a tier or an internal step name ("T2", "Fix session") appears only if their own contract or tracker uses it, and then with its meaning the first time. A label is two or three words. If a line needs a second sentence to be understood, the first one was wrong.

Never claim what the data does not say. No reviewer field: "Needs a review", not "Waiting on you". A link you inferred: "probably fixes APP-570".

## Build it with the person

1. Before building, say in one or two lines what the view will show and what it will let them do, and build it. Do not ask for a specification.
2. Build the smallest version that is already useful, with real data, and tell them it is in the tab.
3. Ask what they see and what is missing: "Is this the right five things to show on a draft?" Their first reaction is worth more than your second guess.
4. Change the layout when they ask, and say in one line what you changed. Small refinements are normal for the first few days.
5. When they say it is right, leave the layout alone and only refresh the data.

## Before you say it is done

- Does the first screen show what needs them, with the news in one sentence?
- Could they act on each item without leaving the view?
- Does every item say where it came from, with a link?
- Is the freshness visible? Is the empty state written?
- Is there exactly one obvious thing to press on each decision?
- Did you read every string as the person would, cold?
- Does the page still hold together with one item, with thirty, and at 400px wide?
- Is `data.json` only facts and your judgement, with everything countable or sortable worked out in the page?
