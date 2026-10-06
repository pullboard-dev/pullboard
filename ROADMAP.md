# Roadmap

What exists, what comes next, and why. Each step keeps the core rule: nothing ships until a second agent verifies it.

## Now: 0.5, the local core

A board in `.git`, lanes, a spec, hooks and a gate, with Pullboard's protocol rules: criterion frozen at claim, builder never verifies, typed verdicts bound to the submitted commit, rejected work back only at a new head. One machine, no account, no dependencies.

## Done in 0.5: two specs and the guides

- **`PRACTICE.md`:** the house rules as rows, shipped as a standard each project edits. Linted alongside the spec.
- **`pullboard spec view`:** the spec, the open questions, sign-offs and the practice as one offline page.
- **Role guides for decompose, plan, sign-off, review and verify.** Installed as Claude Code skills; printed for any agent by `pullboard prompt <role>`.

## Done in 0.5: what the first Haiku micro-build taught

- **Items can wait on each other** (`add --after`), so a lane waits for a shared module instead of copying it.
- **Submit pins the commit** under `refs/pullboard/items`, so work survives an agent deleting its worktree.
- **`pullboard worktree <lane>`** replaces three commands with placeholders that agents copied literally.
- **Refusals say what to do and show what they saw.** A builder had read "the subject starts lowercase" as a contradiction and gamed it.
- **A `review` lane by default,** for verifiers.
- **Two new standard practice rows:** one implementation per concern; tests never write outside a temporary directory.

## Done in 0.5: what the second micro-build taught

- **An ACCEPT carries its proof.** A Haiku verifier accepted a test that could not fail, on "the tests pass"; now accept needs a note saying what was broken or which edge was tried.
- **`pullboard next`.** Builders blocked on other work were hand-writing polling loops; `next --wait` waits, and `next --verify` finds work to check.
- **A must-row has to be testable without a guess.** A vague row ("overdue tasks are flagged") let a time-zone bug through; the decompose guide now asks for the exact comparison, word or format.
- **Verifiers try the edges:** today, zero, empty, the limit.

## Done in 0.5: offloading routine work to cheaper models

Nine Opus lanes spent two days mostly re-reading context (13.2B cache-read tokens against 21.5M written), and half or more of three lanes' work was mechanical. So:

- **Tiers.** Items and agents route `light`, `mid` or `strong`; an agent takes its own tier first, then lighter work.
- **Briefs that work cold.** Below strong, an item needs its files (inside its lane), its test, a criterion and a check command, or `add` refuses it.
- **`pullboard run`.** It drives any agent command over routed items: a context pack per attempt, the check, the failure fed back, then submit or escalate. Pullboard still calls no model; the command is yours.
- **`pullboard escalate`.** It hands an item one tier up, the attempt pinned under `refs/pullboard/attempts`.
- **Fixers at commit.** Formatting is a deterministic tool's job, not a model turn.
- **`pullboard sweep`.** A checker's report becomes light items, one per file, each checked by that checker. Fixing violations is the archetype of work a small model can do: the tool that found the problem proves the fix.
- **One runner, every tier.** `--agent-light`, `--agent-mid` and `--agent-strong`: escalations climb within one run, and an item's verified dependencies merge in before it is built.

## Done in 0.5: what the third micro-build taught

The hidden suite passed 10 of 10, and the verifier caught a real bug by trying calendar edges. The process failed in new ways:

- **Identity cannot leak through the main checkout.** A Haiku verifier's shell started each command in the main checkout, and when it dropped its `cd`, seven verdicts were filed as the coordinator's. A blocked builder then claimed another lane's rejected item from there and rebuilt it. Now the coordinator builds only its own lane's items, verifying in the main checkout needs `--as coordinator`, and every command pullboard suggests starts with `cd <worktree> &&`.
- **A lane is done when its items are verified.** The store builder quit at "submitted", so when its item was rejected nobody was left to rework it. `next` now names the items still awaiting a verdict.
- **Every cited row must be met.** A verifier accepted an item while calling one of its cited rows "not applicable". That is now a reject naming the row, and the planner cites only rows an item meets in full.

## Done in 0.5: from a real coordinator's week

- **Ids are permanent.** A cut row had been deleted, and every commit that cited it lost its meaning. Now the commit refuses a deleted row, `spec check` finds ids once committed or cited and now gone, and a cut row is marked `wont` (won't build): kept, out of the counts, never cited again.
- **A brief on every item, and a route.** A coordinator wanted local and cheaper models to take mechanical items cold. Items carry a brief (the files, the contract, the pattern, the proof), and `--route light` sends one to agents that joined on the light route; they cannot claim or verify anything else.

## Done in 0.5.x: what the first bake-off day taught (6 Oct)

Codex and Claude fleets built the same to-do job on this CLI while Codex verified every CLI change. Its rejects and its builders' friction made most of this list.

- **`pullboard resume`.** A session after a compaction rebuilt its context from a summary. Now one card from the board says where the agent is, and init has Claude Code run it at every session start.
- **Work near warm files.** In one real build an item shared a source file with one of the three before it in its lane 56% of the time, so `next` now takes the item nearest the agent's recent files, and `show` and the run pack name verified items that touched them.
- **`pullboard hold <lane>`.** A pause lived in messages that agents missed. Now it lives on the board, and claims there are refused with who held it and why.
- **The gate as a digest.** Every submit printed the whole test log into the agent's context. Now green is one line, red is the failures, and the log stays in `.git`.
- **`pullboard check`.** Two builders tried a `check` command that did not exist. Now it runs the item's check.
- **Hooks in a fresh worktree.** A new worktree could not commit until its own `npm install`. The hooks now fall back to the main checkout's install.
- **A moved bar is refused at submit.** A verifier ran the whole gate before verify said the cited rows had changed. Submit now says so first.
- **Old commits stay verifiable.** Spec check faulted ids that later items cite, so the gate failed at earlier commits. It now counts an id any ref committed.
- **Files from a dependency are not the item's.** A fast-forwarded dependency's files were recorded as the item's own; commits another item submitted are left out.
- **`pullboard tour`.** Launch needs a thirty-second demo: a reject and its rework, with scripted agents. Its verifier found inherited `GIT_` variables reaching it; the tour now drops them.

## Soon: 0.5.x, hardening from real builds

Lessons from an eight-lane build and from running hosted Pullboard, each small on its own:

- **Hooks rerun over history.** The gate re-checks every commit's message and added lines, cached per commit, so `--no-verify` hides nothing.
- **Lanes enforced in the agent too.** Join writes the agent's own permission rules (for example Claude Code's local settings), so a lane holds before anything reaches a commit.
- **Each worktree runs its own install,** or its tests quietly run another checkout's code.
- **A quick gate** that runs only the checks a change can reach; merges still run the full gate.
- **A fresh-clone check** before handoff: it installs, starts and passes from nothing.
- **A sensitive-data pack:** data files, file-share links and salted identifier tripwires blocked at commit.
- **Spec coverage at the end of the gate:** every approved row with the checks that cite it, pass or fail. Plus lint for glossary synonyms, near-duplicate rows and one track per prefix, and a one-page view of the spec for people.
- **Unverifiable is not rejected.** A verifier can say the check could not run (a flake, a broken environment) without blaming the work.
- **A pending row blocks the items that cite it** until the person settles it.
- **Stranded work flagged:** committed but unsubmitted work is called out before its lease lapses.
- **`pullboard worktrees`** lists and prunes agent worktrees without losing unmerged work.
- **Gate canaries:** every gate proves it can fail before anyone trusts it passing.
- **Held-out checks:** acceptance checks the builders never see, hashed before the work starts.
- **Blueprints:** `pullboard blueprint apply saas` drafts the rows a kind of product needs, for the person to approve.

## Next: 0.6, sync over git

Today the board lives in one clone's `.git`. Teams on several machines need it to travel, and git already moves data between machines.

- **Board events on a ref.** Every move becomes an empty commit on `refs/pullboard/events`, synced with plain `git push` and `git fetch`. Git is the source of truth; the SQLite file becomes a cache rebuilt from the ref, with a test that a full rebuild equals the incremental one.
- **Claims as compare-and-swap.** One ref per claim (`refs/pullboard/claims/<id>`), pushed with `--force-with-lease=<ref>:<expected>`, so the remote decides who holds an item atomically, like the local transaction does today.
- **Signed verdicts.** Each agent signs its verdict commits with its own key, so "the builder never verifies" holds across machines, not only by worktree path.
- **No clocks in the rules.** Order comes from the ref, never from a timestamp a writer controls.

## Then: 0.7, pushes drive the board

Agents stop calling submit by hand: the board moves when the code moves.

- **The change as a first-class object.** Item, branch, base and head commits, preview, verdicts, promoted or not: one record, the unit a reviewer looks for.
- **Push triggers submit and verification.** A push to an item's branch submits it (gate green) and queues it for a verifier. Locally a hook; hosted, a webhook.
- **Re-verify when the main line moves, instead of racing.** If trunk moved after a verdict, the change is rebased and verified again before it lands (STALE_HEAD). A rebase that conflicts goes back to its builder with the reason.
- **Code by pointer.** Shouts and verdicts reference `{repo, branch, sha, path, lines}`; the snippet is rendered where the code lives, and a reference to a commit that does not exist is refused.
- **Notes ship with the code.** The agent's notes for a change live on its branch, so the why stays in the repo, next to what it explains.

## Then: 0.8, verify before deploy

- **Every branch gets a preview,** and the submission records its URL (Cloudflare Workers Previews, Vercel, Netlify, or a local server). The verifier checks the running app, not only the tests.
- **ACCEPT promotes.** The verified commit merges to the production branch and the host deploys it: Built, Verified, Deployed, in that order.
- **Deploy receipts.** A criterion can name a target, and the receipt binds commit, host, service and boot time, so "merged" is never mistaken for "running".

## Hosted Pullboard (pullboard.dev)

The paid layer, for teams across machines and organizations:

- `pullboard sync` mirrors a local board, both ways.
- **Issued identities per agent:** a verdict binds who gave it, not a path. Independent verification is only as good as the identity behind it.
- The spec register in a UI, dashboards, and a neutral record a third party can trust.
- Free for three boards; unlimited on paid plans.

## A Cloudflare track

Cloudflare's agent-era Git platform (Artifacts, Workers, Previews) supplies the Git side; Pullboard stays the coordinator and never holds source.

- Artifacts is the Git host; a push event runs a Worker that submits the change to the board.
- Each branch's Workers Preview is the verification target; ACCEPT promotes and Workers Builds deploys.
- Diffs render on demand in the Worker; none are stored by the board.

## Also planned

- **Item kinds.** `work | mutex | condition`, declared and immutable, so a lock or a monitor's signal is never held to work's obligations.
- **Context pack.** `pullboard context <id>`: one deterministic view of an item (frozen criterion, submitted head, verdict trail, binding rules, and the named gates still blocking it), so no agent rebuilds it from chat.
- **Rules that fail builds.** A spec or doctrine row names the check that enforces it, and the gate asserts that check exists.

## Not planned

- **Several agents racing the same task.** Exclusive claims are the point: at many agents, wasted work is the main cost. Spend a second attempt only where the first was rejected.
- **A diff or merge UI.** Git and the host already do that well.
