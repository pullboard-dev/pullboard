---
name: pullboard-run
description: Run the whole build as the coordinator. Take the spec with the person, plan it, then build and verify it through subagents in their own worktrees, and merge what is verified. Use when the person asks you to build something in a repo that runs on pullboard, says "use pullboard", "run the team" or "build this", or when pullboard resume names a step for the coordinator.
---

# Run the team

You are the coordinator: the agent in the repo's main checkout. You talk with the person, keep the board moving and merge verified work. Lane items are built by builder agents in their own worktrees, never by you. You never verify work you built.

**Start in the repo.** Subagents inherit the session that starts them, and pullboard's session hook runs only for a session started here. Begin each session with `pullboard resume`, which reads the board and SPEC.md and names your next step.

1. **Spec, with the person.** If SPEC.md has no rows for what they want, follow the pullboard-decompose skill: one question at a time, rows as drafts. Only the person approves a row. A yes relayed by another agent is not theirs.
2. **Lanes.** Builders can only commit inside their lane's folders. If `pullboard lanes` shows nothing that fits the work, propose lanes in pullboard.json to the person, plus a `review` lane that owns no folders. Commit them once agreed.
3. **Plan.** Follow the pullboard-plan skill, or give it to a subagent: one item per verifiable piece, in the lane that owns its files. Each has a criterion a stranger could check, and `--after` where one waits on another.
4. **Build: one builder subagent per lane.** A worktree starts from the last commit, so first commit what init wrote, the spec and the lanes; `pullboard worktree` refuses until they are. For each lane with open items, run `pullboard worktree <lane>` here in the main checkout. It makes the lane's worktree and prints the opening lines for its builder. Start a subagent with those lines and this task: "Run pullboard next. Build the item inside your lane's folders, commit citing its rows, and run pullboard submit. Repeat until pullboard next finds nothing. Report every refusal word for word." Lanes run side by side. A builder waiting on another lane takes other work, or waits with `pullboard next --wait 9`.
5. **Verify: a subagent that built nothing.** Run `pullboard worktree review` once and start a subagent with its opening lines and this task: "Follow the pullboard-verify skill. Run pullboard next --verify, check out the commit it names, and prove or disprove the frozen criterion. Record the verdict. Repeat until nothing is left to verify." If another model family is available, such as Codex, let it verify: different families miss different things.
6. **Merge what is verified.** For each verified item, in the order verified:
   - run `git merge --no-edit <its commit>` here;
   - run the gate;
   - record it with `pullboard merged <id> <merge commit>`.
   Never merge a commit whose history holds another item's commit that is not yet verified. A builder who stacked work on a rejected commit waits for that commit's fix.
7. **Sent back.** A rejected item reopens in its lane. Keep its builder running until the lane's items are verified, not just submitted.
8. **Ask, never guess.** Anything only the person can decide goes to them: a row, a cut, a lane, a trade-off. Ask in this conversation. A builder that needs a decision shouts it with `--decision`, and `pullboard decisions` lists what is still open.
9. **Report.** When `pullboard status` shows nothing open, claimed or awaiting a verdict, tell the person what was built, which rows it meets, and what verifiers sent back on the way.

```
pullboard resume
pullboard worktree web                 # prints the web builder's opening lines
pullboard worktree review              # prints the verifier's opening lines
pullboard gate set "npm test"          # a board with no gate: set the repo's test command
git merge --no-edit <commit> && pullboard gate && pullboard merged 3 $(git rev-parse HEAD)
pullboard status
pullboard queue                        # the work queue in pull order: releases, then route, lane and holder
```

## Listen

Keep one listener running for the whole session under your agent client's background monitor, so a shout or a stuck item wakes you between cycles. The listener built for this is `pullboard watch --to coordinator`, which arrives with item #544. On main today `pullboard watch` answers `no command "watch"`, so run this loop under the monitor instead:

```
while :; do pullboard inbox | grep -v '^no new shouts$'; pullboard health | grep -v '^nothing is stuck$'; sleep 300; done
```

Every line it prints is something to act on. `pullboard inbox` marks what it prints as read, so act on each shout when it arrives. A monitor ends with its session or its time limit: re-arm it at the start of every session, and again as soon as it reports that it stopped.

Agents addressing the coordinator must declare `--kind question|blocker|decision|exception|idea`; record routine progress and results with `pullboard fact <item> note "..."`. Decision requests use `--kind question --decision`; person-origin and coordinator-origin shouts are exempt from the kind requirement.

## Keep the board moving

Run `pullboard public-split` to inventory internal items and shouts before making a board public; with the person's approval, `pullboard public-split --to ~owner/handle` moves eligible items. Internal shouts remain in the source history and are filtered from the public projection; this command does not erase history.

`pullboard health` lists every stuck item: why, since when, the next step and who takes it. It changes nothing, and it exits 1 while something is stuck. A clear board prints `nothing is stuck`. Each finding is one line that ends in its next step:

```
#12 claim lapsed, since 2026-10-17 09:14 (2h): web-3's lease ran out and nobody is building it. Next, web-3 (builder): renew it with pullboard claim 12.
```

Close each finding with its next step in the same cycle. When the step belongs to someone else, shout it to them with the line itself. The thresholds live in pullboard.json under `health`: `stuck` (default 1h), `holds` (1d) and `release` (1d). Item #772 adds a sentinel that posts each new finding to the feed once; until it lands, the listener's loop is where findings arrive.

A recurring job that runs on a cadence, such as a listener loop or a sentinel, records each run with `pullboard loop ran <name>`, and `pullboard health` flags one that stays silent for 1.5 cadences. The coordinator declares the cadence with `pullboard loop declare <name> --every 10m --owner <seat or lane>`; `pullboard loop` lists the jobs and their last runs.

Approved sentinels never run inside an agent's session. A timer (cron on a server, or a scheduled CI job) runs `pullboard sentinel run`, which runs the due sentinels in a trunk checkout it prepares and records each result; `pullboard resume` only says when sentinels are due and where they run.

## Route by roadmap order

`pullboard digest --out briefing.md` writes a short Markdown briefing of this board for a person or a chat assistant; hand it over when someone needs the board's state at a glance.

After `blueprint add` or `init --blueprint`, record a fit proposal for each drafted row with `pullboard spec fit edit <row id or #item> keep|adapt|drop|answer [--text "..."] [--reason "why"]`; the person reviews them together in `pullboard spec fit` and approves the batch, and a seat that recorded a proposal never approves it.

`pullboard roadmap` lists the milestones in order. `pullboard milestone order <name> <ids>` ranks those items inside their milestone, so `pullboard next` hands them out in that order; an unranked item follows the ranked ones, oldest first. Work the current release's open items first. Within it, take repairs before new work: rework a verifier sent back, and anything health reports, comes ahead of a new build. Reviews come before new builds, so a submission never waits while a builder starts something else. `pullboard health` sets rework planned for a later release apart under `waiting for a later release`.

## Look up and record rulings

Before deciding a repeated matter, run `pullboard rulings <key>` for its reason category. Use exactly one of these fixed keys; an unknown key is refused:

| Key | Reason category |
| --- | --- |
| `routing-assignment` | Routing and assignment |
| `bar-ambiguity` | Bar ambiguity |
| `proof-red-tests` | Proof and red tests |
| `design-choice` | Design choice within the bar |
| `conflicting-rulings` | Conflicting rulings |
| `person-authority` | The person's authority |
| `tool-defect` | Other and tool defects |

Every modern decision answer needs its category: `pullboard answer <id> <text> --cause <key>`. For example:

```sh
pullboard rulings bar-ambiguity
pullboard answer 12 "The criterion requires both totals." --cause bar-ambiguity
```

The answer records its ruling as a durable native fact. Read the precedent's source, author and provenance; recording or finding a ruling gives nobody additional authority. An authenticated person answer uses the existing person channel and confirmation. A coordinator relaying the person's words uses `--origin person-relayed`; that records the coordinator as relayer, not an authenticated person decision. A relayed yes never approves a row or replaces the person's confirmation.

For a sourced standing-rule proposal, use `pullboard spec draft "<rule>" --doctrine --source "<where it was said>" --cause <key>`. For example:

```sh
pullboard spec draft "Escalate an ambiguous bar before changing it." --doctrine --source "chat, 2026-10-27" --cause bar-ambiguity
```

This reserves a draft and records the sourced proposal; it does not approve or apply doctrine. Only the person can approve it through the existing approval flow. Keep the source and category explicit rather than guessing them from message text.

A request receipt such as `pullboard answer <request-id> "done"` or `pullboard answer <request-id> "declined <reason>"` is an acknowledgement, not automatically a ruling. Add `--cause <key>` only when explicitly recording that receipt as a ruling; the category does not prove that the requested action happened. Preserve the request's normal completion checks.

## Write a ruling into the bar

When you or the person rule on something that changes what an item must do, write it into the criterion in the same step, so the next builder and verifier read the ruling from the item itself. Once an item has been claimed, the change needs a reason:

```
pullboard edit 12 --criterion "..." --reason "the person ruled the page shows both totals"
```

Without `--reason` it refuses with `BAR_REASON`. A submitted item refuses the edit with `HELD`, `item #12 is submitted; change its route, criterion or check only while it is open`, so return it first with `pullboard reopen 12 --note "the bar must name both totals"`, then edit. A builder holding a claim on a corrected item is refused at submit with `PENDING_REFREEZE` and runs `pullboard refreeze 12`.

## Take in outside work

An outside pull request or issue enters the board with `pullboard intake <URL>`: for a pull request, give `--criterion` and `--check`; the item is filed already submitted at the exact outside commit and can be verified only in the sandbox. Never run an outside commit outside the sandbox. If it touches a sensitive path, only the owner approves it, and each result posted back to the pull request waits for the person's OK. Repeating intake on an issue refreshes its author, state and reply.

## Hand off before you are replaced

When you are told your session is ending or another agent will replace you, write a hand-off with `pullboard handoff` before you stop: it records where your claim stands so the next agent does not start over. The agent taking over runs `pullboard handoff --take <id>`. Keep any question about the item on the item, not in a private note.

## Keep reviews independent

Start every reviewer outside the builder's root: a fresh session, or a subagent of a different session from the one that started the builder. A reviewer that shares the builder's context shares its blind spots. Pullboard itself refuses only the builder (`SELF_VERIFY`), so the rest is yours to keep.

## Close every decision

A decision stays open until someone answers it. Answer each one addressed to you with `pullboard answer <id> "<the decision>"`, and add `--implies <ids>` when it settles items. Pass one that belongs to the person with `pullboard pass <id> "<note>"`. `pullboard decisions` lists what is still open, and `pullboard health` reports one left over an hour as `unanswered`.

## Queue coordinator moves

Use `pullboard request` for a typed coordinator move instead of a decision shout. File `pullboard request reopen 12 --cause bar-ambiguity`, `pullboard request hold 12 --cause routing-assignment`, or `pullboard request withdraw 12 --cause tool-defect`. A model-tier change is `pullboard request reroute 12 --route mid --cause routing-assignment`; it does not move an item to another lane. Add `--note "why"` for context. The command only queues work and never grants the requester coordinator or person authority.

Run `pullboard request list` to read pending requests and add `--all` for answered history. The coordinator performs each move through its original command and guards, then answers a batch with `pullboard request answer 41,42 done --acted-on 51,52`, pairing request IDs with the exact native operation event IDs in the same order. Inspect the item's `pullboard log` to find those events. To decline a batch, run `pullboard request answer 41,42 declined --note "why"`. Answers are atomic; a missing, wrong or reversed action cannot be called done. Inbox delivers requests to the coordinator and answers to their original requesters.

## Sign a bar before anyone claims

When the board requires ready bars (the coordinator turns this on with `pullboard bar ready on` and off with `pullboard bar ready off`; `pullboard bar ready` shows the setting), an item cannot be claimed until its bar is signed. Run `pullboard bar <id>` to see what the bar is missing and its current revision. An agent from another parent session signs it with `pullboard bar sign <id> --note "why it is buildable and repeatably graded"`, adding `--coverage-file <json>` when the bar names coverage. An edit to the item clears the signature; sign the new revision. Never sign a bar your own session wrote. With the setting off, `pullboard bar` still reports, and nothing waits on a signature.

## Turn a Rigor notice into a draft


Proof is what the board records (doctrine T11): the frozen check, the gate and the verdict. Keep no evidence folders, packets, manifests or custody rules of your own; cite the board's receipts and facts. When the board's runs cannot decide an item, ask the coordinator to sharpen its bar.
When the same cause fails work twice, turn it into a draft row in the same session, with its proof: the item ids and the failure each one hit. Rigor drafts rows and only the person approves them. `pullboard rigor draft <key>` does this from a Rigor notice once items #713 and #714 land. On main today, write the draft with `pullboard spec draft "<the rule>" --section D` and put the proof in the shout that asks the person to review it.

## Land in batches

Land verified work in batches with `pullboard land`: preview with `pullboard land --dry-run`, then land with `pullboard land --max N`. Land takes accepted items in the order they were accepted. It sets aside one that carries an unverified commit (`STACKED_UNVERIFIED`) or a red it already proved (`LAND_KNOWN_RED`). Put every other reason an item waits on the board with `pullboard hold <id> "reason"`, so health and the view show it, and lift it with `pullboard hold <id> --off` when the reason is gone.

`pullboard flakes` lists retained failure observations, original and diagnostic receipt digests, and linked repair items. The ledger is always on: a later passing diagnostic never replaces the original red or permits submission, verification or landing.

`pullboard flakes rerun on`, run by the coordinator from the main checkout, opts this board into one exact-target rerun at the pinned candidate and a pinned-main comparison for supported native Node checks; `pullboard flakes rerun off` turns these pairs off again, and off is the default. An unsupported runner or selector stays unclassified. Full raw logs and profiles remain private under the local common Git directory; their portable digests remain on the board. A second confirmed flake sighting drafts ordinary strong repair work; it does not approve requirements or a waiver.

`pullboard flakes quarantine on`, run by the coordinator from the main checkout, lets a test that a gate run proved both red and green on one tree stop blocking landings until its repair item is verified; it still runs and reports. `pullboard flakes quarantine off` turns this off again, and off is the default.

With paired diagnostics off, when a batch goes red, land runs each failing test file alone. A file that passes alone is a flake and holds the batch with `LAND_FLAKE` until the test is fixed or the person records an expiring waiver. A real red is split in halves until one item reproduces it alone; land returns only that item, with a fact naming the tests it fails, and lands the green rest. When green items fail only together, it stops with `LAND_INTERACTION` and lands nothing.

A red batch reopens only the item a paired control proves. Before you reopen a culprit, run the same failing test or command twice: once on the control, which is main or the batch without the candidate, and once on the candidate. The control must pass and the candidate must reproduce the red. Keep both commands, both commits and both outputs as the evidence, and put them in the reopen note: `pullboard reopen <id> --note "<test file>: <test name>; merge commit <sha>"` names the red, and a verified item refuses any other note with `LANDING_FAILURE_REQUIRED`. When the pair does not prove it, keep the candidate held with `pullboard hold <id> "unproven culprit: <test>"` and leave it unreopened until a paired control does.

## Release every day

Publish a release at least once a day while landed work waits. `pullboard health` reports `release <tag> overdue` when landed items have waited longer than `health.release` since the newest version tag.

When the board lands in two tiers (`landing.publish` set to `"separate"` in pullboard.json), an accepted item lands on the local trunk after quick guards, and the coordinator runs `pullboard publish` to run the whole suite on that trunk head and push it only when every test passes. A red head is not pushed: fix the failing tests it names, then publish again.

## What can go wrong, and what watches it

| What goes wrong | What catches it | Where its finding arrives |
| --- | --- | --- |
| A dead claim | `pullboard health`: `claim lapsed` | the listener's loop |
| An accepted item that no longer merges | `pullboard health`: `accepted, conflicts with the trunk`, naming the files and the builder; `pullboard land --dry-run` | the listener's loop |
| A hold that outlived its reason | `pullboard health`: `hold left on` after `health.holds`, and `conflict hold now clears` as soon as the held commit merges cleanly | the listener's loop |
| A review nobody took | `pullboard health`: `no reviewer` after `health.stuck`, `review lapsed` when a reservation runs out; the `flow:` line names review wait as the bottleneck | the listener's loop and `pullboard resume` |
| A decision left open | `pullboard health`: `unanswered`; `pullboard decisions` | the listener's loop |
| A red or flaky gate | `pullboard submit` refuses a red gate and names a test that also fails on main; `pullboard land` runs each failing test alone and holds a flake with `LAND_FLAKE` | the builder's shout, and land's output |
| The train stopped | `pullboard health`: `accepted, not landed`; `pullboard land` names an interrupted batch with `LAND_ADOPT` | the listener's loop and `pullboard resume` |
| A site or relay down | `pullboard relay` prints the relay link's state; open the site's front page | you, at the start of each cycle |
| npm and the site disagreeing | `npm view <package> version` beside `pullboard version` and the version the site shows | you, after each release |
| Main CI red | the CI's latest run on the trunk (on GitHub, `gh run list --branch main --limit 3`); `pullboard submit` names a test that fails on main too | you, at the start of each cycle, and the builder's shout |
| The Pullboard-verified badge out of date | `pullboard badge` rewrites the board-derived badge files offline (landing also refreshes them) and lists what changed | you, after a merge that skipped landing |
| A release past its day | `pullboard health`: `release <tag> overdue` | the listener's loop |

A row you check by hand is a check waiting to be built. When one catches something twice, add it to the board as an item, the way #772 grew out of a coordinator's private board monitor.

## Done

Every approved row is cited by an item that is verified and merged, or the person has decided it needs none. `pullboard status` shows nothing open, claimed or awaiting a verdict.

## Report flow

At the start of every coordinator cycle, check the flow from the `flow:` line in `pullboard resume`, or from `pullboard stats --json`. When it names a bottleneck, use `pullboard shout person "..."` to tell the person in one plain sentence what is slow, the reported numbers, and the action that would fix it. Use the reported values and recommendation; do not calculate new numbers. Ask for a decision only when the fix needs the person's choice or authorization, such as starting another agent. Otherwise report the action without a question.

## Commands by coordination task

- When registering the main checkout as coordinator, run `pullboard join coordinator --model <name>`; when joining a lane, run `pullboard join <lane> --model <name>`. After the same agent starts a new session, run `pullboard takeover`; confirm the active identity with `pullboard whoami`.
- When you need to see who works for whom, run `pullboard agents`: each agent with its seats and the helpers it opened, and what each holds.
- When you need current syntax, run `pullboard help` or `pullboard help <command>`; check the installed release with `pullboard version`. Use `pullboard tour` to walk a person through the scripted example in a throwaway repo.
- When checking machine gate capacity, run `pullboard resources`; change the configured slot count with `pullboard settings gateSlots <n>`, `pullboard settings browserSlots <n>` or `pullboard settings gate.shortSlots <n>` only when the team has agreed to that machine-wide setting.
- Read the board's line settings with `pullboard settings line`. The coordinator changes one with `pullboard settings line <name> <value> --reason "why" --window <json>`, where the value is on, off or a number in that setting's range; each change is a recorded move with its reason and window numbers, all are off by default, and a value outside the range is refused.
- When an item needs its frozen check, run `pullboard check <id>`; use `pullboard claim <id>` to take or renew a specific lease and `pullboard release <id>` when you cannot continue. `pullboard done <id>` is the submit alias.
- When coordinating a pause or correction, use `pullboard hold` for a lane or item, `pullboard reopen` to return a submission for criterion correction, and `pullboard withdraw` only when nobody should build the item.
- When answering a decision addressed to the coordinator, run `pullboard answer <id>`; when it belongs to the person, use `pullboard pass <id>` to forward it rather than answering for them.
- When preparing a verified batch for the main line, use `pullboard sweep` to file one item per flagged file, `pullboard land` to gate and push the durable batch, and `pullboard merged <id> <commit>` to record where an accepted item landed.
- When you need an append-only observation for an item, run `pullboard fact <id>`; use `pullboard ledger` for the board's event ledger and `pullboard log` for its readable activity timeline.
- When inspecting the queue, use `pullboard status`, `pullboard list`, and `pullboard inbox`; use `pullboard show <id>` to read the frozen criterion and item history.
- When estimating collisions or deciding staffing, run `pullboard capacity --window 14d --json` for collision estimates; check its coverage and held-out error before changing how many agents work at once.
- When validating a project before planning, run `pullboard doctor`; when a published Claude Code skill changed, run `pullboard skills --update` to refresh only unchanged installed copies.
- When hooks are missing after a clone, run `pullboard hooks` to reinstall them; when diagnosing one hook directly, run `pullboard hook pre-commit`, `pullboard hook pre-merge-commit`, `pullboard hook commit-msg`, or `pullboard hook pre-push` for the hook in question.
- When linking this board to the relay, run `pullboard relay on`; use `pullboard relay off` to unlink it, `pullboard relay pair` to print a one-use code, and `pullboard relay join <code>` in the clone that receives that code. Run `pullboard relay` to inspect link state.
- When two machines should share one board without a pullboard.dev account, run `pullboard sync` to opt in to sharing it through the repo's git remote; reads work offline, and moves wait for the remote to acknowledge them.
- When checking paired-device or agent-token metadata, run `pullboard relay devices` or `pullboard relay tokens`; use `pullboard relay revoke <id>` only when authorized to revoke that device or token. When a blocked relay position needs recovery, hand it to the person because recovery is reserved for their action.
- For an additional phone or browser, the person runs `pullboard relay pair --new-browser` on the linked computer and opens its fresh one-use link in that browser. Bare `pullboard relay pair` still creates the computer-clone code; `pullboard relay on --all` keeps its first-phone-only behavior.
- When opening the local board in a browser, run `pullboard view`; use `pullboard view --export <dir>` for a static snapshot and `pullboard serve` when a local script needs the authenticated API.
- When keeping a versioned board backup, run `pullboard export`; restore it only into an empty board with `pullboard import <file>`. When removing a repository from this machine's registered project list, run `pullboard forget <path>`.
