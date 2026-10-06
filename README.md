# pullboard

**Nothing ships until a second agent verifies it.**

A work board, lanes, a spec and git hooks that live in your repo, for teams of coding agents. Local-first: no account, no server, no network. One SQLite file inside `.git`, zero dependencies, Node 22.13 or newer.

```sh
npm i -D @pullboard/local
npx pullboard init
```

## Why

Coding agents write code faster than anyone can review it, and left alone they grade their own homework. An agent says "done, tests pass," and it isn't: the test got weaker, the commit was never made, or the bar moved after the work started. Two agents build the same thing; a third edits the files both depend on.

Pullboard makes "done" mean something:

- **The bar is frozen before the work starts.** The first claim freezes the item's criterion and the text of every spec row it cites. A verdict is checked against that text, never a newer one.
- **The gate is green at the exact commit.** Submit needs a clean tree, nothing untracked, and your gate passing at HEAD.
- **A different agent checks it.** The builder can never verify its own work. The verifier must have the submitted commit checked out, and records ACCEPT or REJECT with a reason code.
- **Rejected work comes back changed.** Resubmitting a rejected commit is refused.
- **Agents stay in their lanes.** Pre-commit refuses changes outside a lane's folders, moves and deletes included, and no agent can build another lane's item from the main checkout.
- **Every commit traces to the spec.** `feat` and `fix` commits cite the spec ids they serve, and the ids must exist.
- **Ids are permanent.** A commit that deletes a spec row is refused, and `spec check` finds any id that history or the board cites and the spec has lost. A row the client cuts stays, marked `wont`, so every old reference keeps its meaning.
- **Cheaper models get the work they can do.** Items route by the model they need: `light` (a small or local model), `mid` (Haiku, Sonnet) or `strong`. Below strong, an item must be buildable cold: a brief naming its files and its test, a criterion, and a check command. An agent that joins on a route takes its own tier first, then lighter ones.
- **Routine work runs unattended.** `pullboard run --agent "<command>"` builds routed items with any agent you can call from a shell, such as OpenCode on a local model. Each attempt gets a context pack holding the bar, the brief and the files themselves. A failed check feeds the next attempt. Green work is submitted for a second agent to verify; work still red is pinned and escalated one tier up.
- **No agent spends a turn on what a tool can fix.** Pre-commit runs your fast fixers, such as prettier, on fully staged files and restages them.

## Two specs: what, and how

- **`SPEC.md` says what to build:** the client's requirements as rows. Approved rows are the contract.
- **`PRACTICE.md` says how:** the house rules in the same format. Init writes a standard set to start from: writing rules, code limits, test discipline, the gate, dependencies, security.

  Each project keeps, edits or retires each row and approves what it keeps. A row whose gate names a check (a hook, a linter, a test) fails the build when broken. A row gated by review guides agents and reviewers.

`pullboard spec check` lints both. `pullboard spec view` renders both as one offline page, with the open questions and where each sign-off stands: signed, stale or not yet.

## Agents that walk you through it

The parts of the method that need a person are written as role guides:

| Guide | What it does |
| --- | --- |
| `decompose` | Turns the client's ask into rows with you, one question at a time. It asks only what blocks a must-row and states other guesses as draft rows. |
| `signoff` | Walks you through approved rows in batches: where to see each, the test that proves it, its honest read. You sign; it records your word. |
| `review` | Reads the spec and the running product as the client will, and reports what they would notice first. |
| `verify` | Checks another agent's work at the submitted commit, with the strongest proof available. |

Init installs them as Claude Code skills. Any other agent reads them with `pullboard prompt <role>`. A repo can replace any guide with its own `.pullboard/prompts/<role>.md`.

## The method

1. **Client ask.** Start from what the person paying for it needs.
2. **Spec as lettered points.** Every requirement becomes one row with an id: `G1.2`, `K3`. Approved rows are the contract.
3. **Agents build against the spec,** one item at a time, each item citing its rows.
4. **Split the work into lanes.** Each lane owns folders; agents never collide on files.
5. **A second agent verifies,** against the criterion frozen at claim, at the submitted commit.
6. **A person drives.** They write and approve the spec, settle the open questions, sign off rows, and read the ledger.

The full guide is in [docs/method.md](docs/method.md).

## Quick start

```sh
npx pullboard init            # pullboard.json, SPEC.md, AGENTS.md, git hooks, the board
```

Write requirements in `SPEC.md`, one row per line:

```markdown
## G · Goals
- G1 [approved, must] Same file twice is a no-op. | gate: idempotency test
- G2 [draft, aim] Show a diff when a month is restated. | serves: G1
```

Declare lanes and the gate in `pullboard.json`:

```json
{
  "gate": "npm test",
  "lanes": {
    "web": { "owns": ["apps/web/"], "specs": ["G0"], "starts": "now" },
    "pipeline": { "owns": ["apps/pipeline/", "packages/ingest/"], "specs": ["G1", "G2"] }
  },
  "shared": ["test/attacks/"]
}
```

The main checkout is the coordinator. Every other agent works in its own worktree and joins a lane:

```sh
pullboard add web "Build the upload page" --specs G1 --criterion "drop a file, see it listed"
pullboard worktree web                # makes ../app-web-1, joined as web-1
cd ../app-web-1 && npm install
pullboard claim 1                     # 2-hour lease; criterion frozen
# ... build, commit "feat(web): upload page [G1]" ...
pullboard submit 1                    # clean tree + gate green at HEAD
```

Another agent, from the submitted commit:

```sh
pullboard verify 1 accept --note "emptied the upload dir; the list test failed"
pullboard verify 1 reject --reason TEST_FAILURE --note "upload of a 0-byte file crashes"
```

## Receipts

`pullboard ledger` prints what was built, by whom, verified by whom, at which commit:

```
1 verified by a second agent · 0 awaiting verification · 1 rejections along the way

| # | Lane | Item | Spec | Built by | Verified by | Commit | Merged |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | web | Build the upload page | G1 | web-1 | coordinator | d0cba867b919 | d0cba867b919 |
```

`pullboard log` shows every move in order: claims, submissions, rejections, refreezes, merges. Commit the ledger at the end of a build and the history is the proof.

## Commands

| Command | What it does |
| --- | --- |
| `init` | Sets up config, spec, agent instructions, hooks and the board. Safe to rerun. |
| `worktree <lane>` | From the main checkout: makes a worktree for a new agent, joins it to the lane, prints what to run next. |
| `join <lane>` | Registers the worktree you are in as the next agent in a lane. |
| `add <lane> <title>` | Adds an item. `--specs`, `--criterion`, `--after <ids>` to wait on other items, `--parent` for child items. |
| `list [lane]`, `show <id>` | The board, and one item with its frozen criterion and verdicts. |
| `next [--wait <min>]`, `next --verify` | Claim your lane's next free item, waiting if everything is blocked; or name the next item to verify. |
| `claim <id>`, `release <id>` | Take or renew a lease; hand it back. |
| `submit <id>` | Records the work at HEAD, after the gate passes. Alias: `done`. |
| `verify <id> accept\|reject --note "..."` | A verdict, by anyone but the builder, from the submitted commit. Both need a note: the proof, or what failed. |
| `shout <to> <text>`, `inbox` | Messages to a lane, an agent, or `all`. |
| `merged`, `withdraw`, `refreeze` | The coordinator's: where verified work landed, dropped items, a re-frozen bar. |
| `ledger`, `log [id]`, `status` | Receipts. |
| `spec check\|view\|show\|unmet\|signoff` | Lints SPEC.md and PRACTICE.md; renders them as a page; a person signs off rows with the text they read. |
| `prompt <role>` | Prints a role guide: decompose, signoff, review, verify. |
| `gate`, `hooks` | Runs the gate; reinstalls hooks after a fresh clone. |

Add `"prepare": "pullboard hooks"` to `package.json` so every clone gets the hooks on `npm install`.

## What lives where

| Path | What | In git? |
| --- | --- | --- |
| `pullboard.json` | Gate, lanes, commit rules | yes |
| `SPEC.md` | The requirements, one row per id | yes |
| `PRACTICE.md` | The house rules, in the same format | yes |
| `.claude/skills/pullboard-*` | The role guides, as Claude Code skills | yes |
| `AGENTS.md`, `CLAUDE.md` | How agents work here; init adds its section | yes |
| `.githooks/` | pre-commit, commit-msg, pre-push | yes |
| `.pullboard/signoffs.jsonl` | A person's sign-offs, with the text they approved | yes |
| `.git/pullboard/board.sqlite` | The board: items, claims, verdicts, shouts, events | never |

## Limits, stated

- **Identity is the worktree.** On one machine that keeps honest agents honest; an agent could still edit the SQLite file. Hosted Pullboard issues each agent its own identity.
- **Hooks can be skipped** with `--no-verify`. Pre-push and the verifier are the backstop.
- **Conflicts are avoided, not resolved.** One holder per item and lanes by folder keep agents apart; a rebase that conflicts goes back to its builder.

## Local and hosted

This package is complete on one machine and free. [Pullboard](https://pullboard.dev) is the hosted layer for teams across machines: issued identities, a neutral record, dashboards and the deploy axis. See [ROADMAP.md](ROADMAP.md).

## License

Apache-2.0. See LICENSE and NOTICE.
