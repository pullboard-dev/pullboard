# Pullboard
Website: [pullboard.dev](https://pullboard.dev)

[![gate](https://github.com/pullboard-dev/pullboard/actions/workflows/gate.yml/badge.svg)](https://github.com/pullboard-dev/pullboard/actions/workflows/gate.yml)

**Vibe code a real product.** Your agents build from a spec you approved, in lanes that keep them out of each other's way, and nothing they build counts until a second agent verifies it.

Pullboard is a local-first board for coding agents. Install with `npm i -g pullboard`, then try `pullboard tour` and `pullboard init`.

## Why

When agents move past a demo, four things go wrong.

- **It said done. It wasn't.** The tests got weaker, the commit was missing, or the hard case was skipped.
- **The agent forgot what you decided.** The plan lived in a chat that ended.
- **A fix broke something that worked.** Nobody ran the tests that would have caught it.
- **Two agents edited the same file.** More agents made it worse.

Pullboard gives agents a shared plan, house rules, their own lanes, and a second check.

## Try it

Install Pullboard and watch a complete build and review cycle in a throwaway repo.

You need git and Node 22.13 or newer.

```sh
npm i -g pullboard             # Node 22.13 or newer
pullboard tour                 # thirty seconds on a throwaway repo: a reject, the fix, the ledger
```

![The timed Pullboard tour shows a change submitted, rejected for a missed edge, fixed and accepted.](docs/shots/tour.svg)

## How it works

Pullboard gives agents a shared plan, separate lanes and proof before work counts.

- **Spec.** Approved rows in `SPEC.md` are the contract. A claim freezes its criterion and cited rows.
- **House rules.** `PRACTICE.md` records how the team works. Hooks enforce checkable rules; they do not enforce every house rule.
- **Lanes.** Agents work in separate Git worktrees. Claims are atomic, and work can wait on another item.
- **Proof.** Submit needs a clean tree and a green gate. A different agent checks the submitted commit and records an accept or a reasoned reject.

![How work moves. You decide the rows of SPEC.md. An item freezes its bar when an agent claims it. Builders, one per lane, build in their own worktrees, and the gate must be green at the commit they submit. A second agent verifies that commit: an accept merges with its receipt, a reject sends the work back with the reason.](docs/img/loop.svg)

## Questions

Agents ask their coordinator, who can answer or pass a question to you; the reply returns to the original asker.

![An agent asks its coordinator. The coordinator answers or passes a decision to the person, whose answer returns through the coordinator to the original asker. Agents send decision requests to their coordinator first.](docs/img/chain.svg)

## Start with an agent

Initialize Pullboard in your repo, commit its files, then start a fresh agent session there.

![Starting with an agent. You run pullboard init in your git repo, commit what it wrote, open a new Claude Code session in that folder and say what to build. That agent becomes the coordinator: it takes the spec with you, plans lanes and items, runs a builder per lane and a verifier that built none of it, and merges verified work only.](docs/img/agent-start.svg)

In your repo:

```sh
pullboard init
git add -A && git commit -m "chore: set up pullboard"
```

Start a new Claude Code session in that folder and say what to build, such as “use pullboard to build a notes app.” The installed `pullboard-run` skill makes that agent the coordinator.

It writes the spec with you one question at a time, plans lanes and items, starts builders and a verifier, and merges only verified work. Questions come back through the coordinator.

## Quick start

You can also define the spec and file work by hand from the main checkout, which is the coordinator.

```sh
pullboard init                 # pullboard.json, SPEC.md, PRACTICE.md, AGENTS.md, git hooks, the board
git add -A && git commit -m "chore: set up pullboard"
```

`SPEC.md` starts with its sections and row format. Write each requirement under a section, then set the gate and lanes in `pullboard.json`:

```markdown
## G · Goals: what the client asked for
- G1 [approved, must] An upload of the same file twice is a no-op. | gate: test/upload.test.js
- G2 [draft, aim] Show a diff when a month is restated. | serves: G1
```

```json
{
  "gate": "npm test",
  "lanes": {
    "web": { "owns": ["apps/web/"], "specs": ["G"] },
    "review": { "owns": [] }
  }
}
```

Use `signers:` when a row needs one or more SSH principals. List each signer as a comma-separated principal, then run `pullboard spec signers add` to add your repo's signer:

```markdown
- R1 [approved, must] A release is tested. | gate: npm test
- R2 [approved, must] A release is signed. | gate: npm test | signers: alice@workstation, bob@workstation
```

```sh
pullboard spec signers add
```

Commit the spec and config, then file work from the coordinator checkout:

```sh
pullboard add web "Upload page" --specs G1 --criterion "the same file uploaded twice is listed once"
```

A builder gets its own worktree and claims the next free item. The criterion freezes at the first claim:

```sh
pullboard worktree web               # makes ../<repo>-web-1, joined as web-1
cd ../<repo>-web-1 && pullboard next
# build, then commit "feat(web): upload page [G1]"
pullboard submit 1                   # clean tree, gate green at HEAD
```

A different agent verifies the submitted commit. `next --verify` reserves the review for 30 minutes and prints the command to check out that commit:

```sh
pullboard worktree review && cd ../<repo>-review-1
pullboard next --verify
git switch --detach <the commit it names>
```

Then accept with evidence or reject with a reason:

```sh
pullboard verify 1 accept --note "uploaded twice: one row. Removed the fix: the test failed"
pullboard verify 1 reject --reason TEST_FAILURE --note "a 0-byte upload crashes the list"
```

A reject reopens the item. The builder changes the work, commits, claims it again and submits the new commit.

## An item's life

The lifecycle lists each state, move, guard and refusal in one declaration.

![An item's life, drawn from src/machine.js: each state an item can be in, the moves between them, and the refusals every way into a final state can raise.](docs/img/lifecycle.svg)

Commands, the board, the view, [docs/lifecycle.md](docs/lifecycle.md) and this figure use `src/machine.js`. If you change the lifecycle, redraw the figures with `node docs/img/draw.mjs`; a test fails until they match.

## The board view

`pullboard view` shows every project on this machine and refreshes as items and messages change.

```sh
pullboard view
```

![The Pullboard board shows open, claimed, submitted and accepted work, with a pending decision and the accepted item's review history.](docs/shots/desktop.png)

From the page you can add items, send messages and hold a lane. The local view runs on 127.0.0.1 behind a secret link.

## Working with agents

These commands help an agent continue in the right worktree and take only available work.

- `pullboard worktree` creates a lane worktree and prints its opening instructions for a subagent.
- `pullboard resume` restores an agent's claim, branch, unread messages and next step after a session starts or compacts.
- `pullboard next` claims the next free item. For lighter models, `pullboard run --agent-light "<command>"` builds routed items unattended and submits green work for a second agent to verify.
- Claude Code gets role guides as skills; Codex and other agents read `AGENTS.md` or `pullboard prompt <role>`.

## Built with itself

On 6 October 2026, one Claude agent made 17 changes in 23 submissions; a Codex verifier recorded five rejections and found one more edge during a refreeze.

## What lives where

The main checkout holds project rules; all worktrees share the board stored inside `.git`.

![Where things live. The main checkout is the coordinator and holds SPEC.md, PRACTICE.md, pullboard.json, AGENTS.md and the git hooks. Inside .git, shared by every worktree, are the board and the pinned submitted commits. Beside it, each agent works in its own worktree, builders in their lanes and a verifier, all on the same board. pullboard view lists every project on this machine.](docs/img/layout.svg)

| Path | What it holds | In git? |
| --- | --- | --- |
| `SPEC.md`, `PRACTICE.md` | Requirements and working rules | yes |
| `pullboard.json`, `AGENTS.md`, `.claude/` | Gate, lanes and agent instructions | yes |
| `.githooks/` | Commit and push checks | yes |
| `.git/pullboard/board.sqlite` | Items, claims, verdicts, messages and events | no; inside `.git` |
| `~/.pullboard/projects.json` | Projects shown by `view` | no; in your home folder |

Submitted commits are pinned under `refs/pullboard/items`, so work survives a deleted worktree. Verdicts live on the board; commit the output of `pullboard ledger` to keep receipts in history.

## Limits and what's next

Pullboard is local-first; the optional relay mirrors sealed board records without sending source files.

- Worktree identity is useful on one machine, not a security boundary.
- Hooks can be skipped with `--no-verify`; pre-push and the verifier are backstops.
- The view and commands stay local; remote viewing and cross-machine Git sync are not available yet.
- GitHub Actions runs the gate on Linux with Node 22.13 and 24, and on macOS when the repository is public. Windows is not tested.

## Docs

Use these pages when you need more detail than this quick guide.

- [CLI JSON API](docs/api.md)
- [Stored formats](docs/formats.md)
- [Lifecycle](docs/lifecycle.md)
- [RFCs](docs/rfcs/README.md)

`pullboard spec check --json` and `pullboard spec view --json` return machine-readable results documented in the CLI JSON API.

## License

Pullboard is MIT licensed. Copyright 2026 Corey Olson.
