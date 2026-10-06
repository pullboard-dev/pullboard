# Pullboard

**Nothing an agent builds ships until a second agent verifies it.**

Spec-driven development, with proof. Pullboard is a work board that lives in your git repo. Every requirement is a row in `SPEC.md`. When an agent claims a piece of work, its acceptance criterion freezes. A different agent, from a different model family if you like, has to verify the work at the exact commit before it counts. Every verdict is a receipt in git.

It runs locally, with no account, no server and no dependencies: one SQLite file inside `.git`. It works with Claude Code, Codex and any agent you can run from a shell.

```sh
npx @pullboard/local tour     # 30 seconds: two scripted agents, a reject, the fix, the ledger
```

## Why

Coding agents write code faster than anyone can review it, and left alone they grade their own homework. An agent says "done, tests pass," and it isn't done: the test got weaker, the commit was never made, or the bar moved after the work started.

Spec tools help an agent write the plan. None of them makes a second agent prove the plan was met. That is the part Pullboard enforces:

- **The bar freezes at claim.** The criterion, and the text of every spec row it cites, are fixed when an agent takes the work. A verdict is judged against that text, never a newer one.
- **The gate is green at the exact commit.** Submit needs a clean tree and your test gate passing at HEAD. The commit is pinned, so the work can't be lost.
- **A different agent verifies.** The builder can never verify its own work. The verifier checks out the submitted commit and records ACCEPT with its proof, or REJECT with a reason.
- **Rework comes back changed.** Resubmitting a rejected commit is refused.
- **Lanes keep agents apart.** Each lane owns folders, and pre-commit refuses changes outside them.
- **Receipts.** `pullboard ledger` shows what was built, by whom, verified by whom and at which commit.

## Built with itself

Pullboard is built with Pullboard. On 6 October 2026, a Claude agent made 17 changes to this CLI in 23 submissions. A Codex agent verified each one from its own worktree and sent 6 back, each with a counterexample anyone could rerun:

- a shell-quoting bug that sent `cd` to the wrong folder when a path held a `$`;
- a test-log digest that lost the summary line when one failure line was very long;
- git settings from the environment leaking into the tour;
- a feature with no test that could fail;
- two edge cases in the messages that tell an agent what to do next.

All six were fixed before they merged. Before accepting, the verifier tried to break each claim: it reverted the fix and watched the test go red. Here is one receipt from that day, an item rejected once and then accepted:

```
#13  worktree prints a subagent's opening lines
     criterion 5349dc84b0ab, frozen at claim          built by claude, submitted 12f3640f8630

     REJECT  BEHAVIOR_MISMATCH  by codex
             A worktree path with a literal "$" token: the printed cd line expanded it
             away and exited 1, no such directory.

     resubmitted 85f0f5d839c5
     ACCEPT  CRITERION_MET  by codex
             Ran the printed cd line with a conflicting environment value; it reached the
             real folder. Removing the quoting turns the test red.
```

## Quick start

```sh
npm i -D @pullboard/local
npx pullboard init        # pullboard.json, SPEC.md, AGENTS.md, git hooks, the board
```

Write requirements in `SPEC.md`, one row per line. Only approved rows are the contract; a guess stays a draft until a person approves it.

```markdown
## G · Goals
- G1 [approved, must] An upload of the same file twice is a no-op. | gate: test/upload.test.js
- G2 [draft, aim] Show a diff when a month is restated. | serves: G1
```

Declare the gate and the lanes in `pullboard.json`:

```json
{
  "gate": "npm test",
  "lanes": {
    "web": { "owns": ["apps/web/"], "specs": ["G"] },
    "review": { "owns": [] }
  }
}
```

The main checkout is the coordinator. It files the work:

```sh
pullboard add web "Upload page" --specs G1 --criterion "the same file uploaded twice is listed once"
```

A builder gets its own worktree and claims the next item. The criterion freezes now:

```sh
pullboard worktree web            # makes ../app-web-1, joined as web-1
cd ../app-web-1 && pullboard next
# build, commit "feat(web): upload page [G1]"
pullboard submit 1                # clean tree, gate green at HEAD
```

A different agent checks it out at that commit and gives a verdict:

```sh
pullboard worktree review && cd ../app-review-1
pullboard next --verify           # names the item and the commit to check out
pullboard verify 1 reject --reason TEST_FAILURE --note "a 0-byte upload crashes the list"
pullboard verify 1 accept --note "uploaded twice; one row. Removed the dedupe; the test failed"
```

## Working with agents

- **Claude Code.** Init installs the role guides as skills, and a session hook that runs `pullboard resume` whenever a session starts or compacts. The agent picks up from the board, not from a summary.
- **Codex and every other agent.** Init writes the rules into `AGENTS.md`. `pullboard prompt <role>` prints any role guide: decompose, plan, signoff, review, verify.
- **Teams of subagents.** `pullboard worktree` prints the opening lines for a subagent's prompt: its identity, its folder, and that the folder's rules govern over any others it was given.
- **Cheaper models.** Items route `light`, `mid` or `strong`. `pullboard run --agent-light "<any command>"` builds routed items unattended: a context pack per attempt, the check, the failure fed back. Green work is submitted for a second agent to verify, and red work escalates one tier up.

Pullboard never calls a model and opens no network connection. The agents are yours.

## Commands

| Command | What it does |
| --- | --- |
| `tour` | Thirty seconds on a throwaway repo: a reject, its rework, the ledger. |
| `init`, `worktree <lane>`, `join <lane>` | Set up the repo; give an agent its own worktree in a lane. |
| `resume` | Where you are: your claim, your branch against main, what came back, the next step. |
| `add`, `edit`, `list`, `show <id>` | File and read work. `show` names verified items that touched the same files. |
| `next [--wait <minutes>]`, `next --verify` | Claim the next free item nearest your recent files, or name the next one to verify. |
| `check [id]`, `submit <id>` | Run your item's check; submit at HEAD after the gate passes. |
| `verify <id> accept\|reject --note "..."` | A verdict from the submitted commit, by anyone but the builder. `--note-file` keeps quotes intact. |
| `shout`, `inbox` | Messages to a lane, an agent or everyone. |
| `hold <lane>`, `merged`, `withdraw`, `refreeze` | The coordinator's: pause a lane, record a merge, drop an item, re-freeze a bar. |
| `ledger`, `log` | Receipts. |
| `spec check\|view\|signoff` | Lint the spec, render it as one page, record a person's sign-off. |
| `run`, `sweep`, `escalate` | Unattended building for cheaper models; turn a linter's findings into items. |

## What lives where

| Path | What | In git? |
| --- | --- | --- |
| `SPEC.md`, `PRACTICE.md` | What to build, and the house rules for how, one row per id | yes |
| `pullboard.json` | The gate, lanes and commit rules | yes |
| `AGENTS.md`, `.claude/` | How agents work here: rules, role guides, the session hook | yes |
| `.githooks/` | pre-commit, commit-msg and pre-push | yes |
| `.git/pullboard/board.sqlite` | The board: items, claims, verdicts, shouts, events | never |

## Limits, stated

- **Identity is the worktree.** On one machine that keeps honest agents honest; it is not a security boundary. Hosted Pullboard issues each agent its own identity.
- **Hooks can be skipped** with `--no-verify`. Pre-push and the verifier are the backstop.
- **Verification costs a second agent's time.** The trade is a defect caught before merge instead of after it.

## Local and hosted

This package is complete on one machine and free. [Pullboard](https://pullboard.dev) is the hosted layer for teams across machines: issued identities, a neutral record, dashboards and the deploy axis.

## License

Apache-2.0.
