---
name: rig-gardener
description: Look over a Rig space on Rig's regular visit. Name the space once it is clear what it is for, catch facts that have gone out of date in the contract or the views, views that are broken or stale, and problems Rig's own check found. Fix what is small and safe, raise the rest in a line or two, and stay silent when all is well. Use only when a turn says it was started by Rig's look over the space, or when a person asks you to check the space over.
---

# Rig gardener

## What this is

A short visit to a space, not a pass of its standing work. Rig makes it now and then, when something in the space has changed. Nobody asked for it and nobody is waiting. A good visit usually ends with nothing said, because a space that is in order needs no remark.

Keep it to about ten tool calls unless something is plainly wrong. Never start other sessions, never do the factory's work, never refresh a view (a view has its own turns for that), and never reach outside the space. The visit is cheap on purpose: it happens often, and each one costs the person's usage.

## Look

Start from what the turn already gives you: what Rig knows about the views (schedule, last refresh, next refresh), Rig's own check of the space, and what you said last time. That is usually most of what you need.

Then read `FACTORY.md` if there is one, the `view.json` of each view, and `rig_changes_list` for what changed since you last looked. Read a view's `data.json` only for a view the facts point at; the data is large and mostly fine.

## The name

If the turn says the name was picked at random and that you may rename it, check whether it is now clear what the space is for: a contract exists, or the views and the conversation agree on one job. If so, rename it with `rig_space_rename`. Choose two to four plain words a teammate would recognise ("PR reviews", "LinkedIn posts"). Use their word for the work, no dates, and not the word factory unless they use it. The turn lists the names of the person's other spaces: never pick one of those. When the plain name is taken, add the word that sets this space apart, such as the source, the team or the product ("Acme bug fixes" is taken, so "Linear bug fix plans"). Then say one line:

`I named this space "PR reviews". You can rename it any time.`

If it is not clear yet, leave the name; you will look again, and a wrong name is worse than a random one.

If a person chose the name, never change it. If their name has clearly drifted from what the space now does, say so once, in one line, and never again. Check your last note first so you do not repeat it.

## Facts that went out of date

Compare the contract and the other notes with what is there now. Look for a source that no longer exists, a person who left (`rig_people_list`), a schedule in the contract that differs from the view's, a limit the records show is not kept, and a line marked assumed that has since been confirmed or contradicted. A note that says something false is worse than no note, because people and agents act on it.

## Views

From Rig's facts and the files, look for a last refresh that failed or could not start, a view long overdue, a schedule that names a member who is gone, a `data.json` that is not valid JSON, a `view.json` without a title or kind, a view without an `icon` or sharing one with another view in the space (give each its own from Lucide, as the rig-views skill describes; this is a small, safe fix that needs no line), and a view whose contract no longer exists. A view that quietly stopped refreshing looks fine until someone relies on it.

## Rig's check

Read the JSON from Rig's own check. When a connector the space declares is missing or not approved, that is worth one line saying what to approve or connect. Ignore the rest unless it names a file in this space.

Two findings are never worth a line or a fix. A missing `claude` or `codex` command: you are running, so the agent is installed, and the check only looked for it on the PATH. A folder the check calls missing, such as `data/` or `outputs/`: do not create it. Create nothing in the space that the person or the standing work did not ask for.

## Fix or raise

Fix only what is small, safe and plainly true, and only inside the space: a path to a file that was renamed, a broken link to a file in the space, a typo in a name, invalid JSON you can repair without guessing. Say each fix in a few words.

Anything that changes what the work does is the person's: a rule, a schedule, who does what, and anything outside the space. Raise it, do not do it.

When a person must choose, put the choice where they already decide: a card on the view they act from (the rig-views skill, "Steps that need a person"), with the action you suggest first and the real alternatives, never a bare yes or no. Then add one line in the Room saying the card is there. In a space with no view, write the choice plainly in your note: what you suggest, and the alternatives.

## What you say

At most three short lines, in plain words, each naming the file or view it is about. Do not repeat a point from your last note unless it got worse; people read these.

If nothing needs a person and you fixed nothing worth telling, reply with exactly `All is well.` and nothing else. Rig keeps that reply out of the Room, which is how a quiet space stays quiet.
