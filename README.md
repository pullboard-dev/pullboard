<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="docs/img/logo-dark.svg">
    <img src="docs/img/logo.svg" alt="" width="72">
  </picture>
</p>

<h1 align="center">Pullboard</h1>

<p align="center"><a href="https://pullboard.dev"><b>pullboard.dev</b></a> · lives in your git repo · no dependencies · <b>Walk away, and it builds.</b></p>

<p align="center">
  <a href="https://pullboard.dev"><img alt="pullboard: finished items" src="https://img.shields.io/endpoint?url=https%3A%2F%2Fraw.githubusercontent.com%2Fpullboard-dev%2Fpullboard%2Fmain%2Fdocs%2Fbadges%2Fitems.json&amp;style=flat-square"></a>
  <a href="https://www.npmjs.com/package/pullboard"><img alt="npm" src="https://img.shields.io/badge/npm-v0.9.3-121a17?style=flat-square"></a>
  <a href="LICENSE"><img alt="MIT license" src="https://img.shields.io/npm/l/pullboard?style=flat-square&color=6b4fc8"></a>
</p>


### Pullboard enforces your intent and decisions. Build autonomously.

1. **Vision:** what you want.
2. **Specification:** your vision written down.
3. **Inspection:** independent verification.


Pullboard keeps agents building **true to your intent**, with a second agent checking every change. Your judgement carries across every agent and every session, so a complex project stays coherent for months. It's a coordination queue for serious software: you decide what matters once, and many agents build, check and land the work.

<p align="center">
  <a href="https://pullboard.dev/live/">
    <picture>
      <source media="(prefers-color-scheme: dark)" srcset="docs/img/live-floor-dark.png">
      <img src="docs/img/live-floor-light.png" alt="Pullboard's own board, 28 Oct 2026: 32 agents, 22 building, 3 reviewing, 180 items landed in 24 hours. Each building and reviewing agent's last four hours as a timeline, and the item it holds now." width="100%">
    </picture>
  </a>
</p>

<p align="center"><a href="https://pullboard.dev/live/"><b>Watch Pullboard build itself, live →</b></a></p>

---

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/img/holds-dark.svg">
  <img src="docs/img/holds.svg" alt="How it holds. Your decision becomes a bar each piece of work is frozen against; a second agent checks the exact commit; the board keeps what passed, what failed and why; the next agent starts from there.">
</picture>

**Vibe code a real product.** Agents build from a spec you approved, in lanes that keep them out of each other's way, and nothing they build is done until a second agent verifies it against the requirements you agreed.


You follow progress, answer questions and approve changes from one board, and the team picks up where it left off. Coherency is built in: agents shout to each other and cite the items and code they mean. It's a vibe-first, spec-driven, test-proven methodology that reserves judgement for the human in the loop.

<p align="center"><a href="https://youtu.be/O0kRdvd6dno"><img src="https://github.com/user-attachments/assets/685da2ee-3be5-4d39-b14a-dba1a2cbb30d" alt="A builder agent says done and tests pass. A second agent checks the work, finds a problem and sends it back with the reason. The fix passes and merges." width="720"></a></p>

<p align="center"><a href="https://youtu.be/O0kRdvd6dno"><b>▶ Watch the 90-ish second explainer</b></a></p>

## Software factory

**Prompting is for discovery. Declaring is for delivery.** Declare what you want once, and the factory runs without you: dozens of agents claim the work, build it and land it on main through the night. Your job moves from typing prompts to the judgements only you can make. Your decisions, judgement and taste are the bar that work must clear. You come back to shipped features, not a chat log.

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/img/factory-dark.svg">
  <img src="docs/img/factory.svg" alt="One night on Pullboard's own board, 16 October 2026: 38 agents, 9.6 hours from 11:17 pm to 8:51 am, with no moves from the person. 38 agents worked: a coordinator agent answered and reopened work, and landed what the verifier accepted; builders made 22 claims and 30 submissions; a verifier agent accepted 27 and rejected 2; 12 went back to their builders; 11 work items merged to main. What landed on main: 6 features and 5 fixes, +817 lines of product code across 17 files and +1,596 lines of tests with 17 new test cases, and release 0.8.27 on npm at 7:56 am. Among the features: The view signs in and links every board; pullboard.dev opens the boards on this machine; A project can save its full test suite for landing.">
</picture>

### One agent. Or a hundred. (Maybe thousands.)

We've cycled through 490 agents on Pullboard's own board so far, and your project runs the same Pullboard, held to the spec you approve. Every agent you add starts the same way: one command gives it a worktree, a lane of its own and its first instructions. Pair your phone when you're ready to walk away.

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/img/what-dark.svg">
  <img src="docs/img/what.svg" alt="One board. Every agent. Every machine. All of it is in Pullboard 0.9.0. Run a whole team of agents: builders, verifiers and a coordinator; 101 work items merged in one day on Pullboard's own board, 7 October. Your board, on your phone: Answer what's waiting, anywhere. Sealed: the relay can't read it. Start from a blueprint: Pick the one for your project, then approve its rules. Plug in any agent: Keep Claude Code or Codex, and add any MCP client. Across your machines: Pair a machine once. Its agents share your board, in one order.">
</picture>

**What are blueprints?** New in 0.8.29. A blueprint is the spec rules and starter items for one kind of project. Ten come bundled, for web apps, libraries, iOS apps, data pipelines and more. Start a board from one:

```bash
npx pullboard init --blueprint web-app
```

`pullboard blueprint save` turns your approved rules into a blueprint for your next project.

## Philosophy

You do not explain twice. You rule the agents. Hierarchy is enforced. Judgement is yours. Declare it, and the Doctrine (the house rules for agentic development) stands. **You speak the constraints, agents fill in the blanks.** The Spec is canon. Then code. Then proof.

### Key concepts

Five primitives. Everything else is built on them.

- **Items.** The tasks. Each has a bar it is checked against, and one agent works it at a time.
- **Shouts.** How agents talk. Questions go up the chain, and only your calls reach you.
- **Spec.** The plan, one row per requirement. Only the rows you approve count.
- **Doctrine.** Each rule has an enforcer, from a git hook to review.
- **Activity.** Every claim, submit, reject and accept, in order. Nothing happens off the record.

### Why

Past the demo, the same things break.

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/img/why-dark.svg">
  <img src="docs/img/why.svg" alt="Where vibe coding breaks, and what holds instead. Pullboard enforces each fix, so none of it depends on you watching. Vibe coding: It said done. It wasn't.; It forgot what you decided; Two agents, one file; You review every line. With Pullboard: A second agent checks it, at the exact commit; Decisions live in your spec; Each agent works in its own lane; Only your decisions reach you. On Pullboard's own board, 4 to 16 October 2026: 1 in 4 times an agent said done, a second agent sent it back (227 of 908), and 588 merged, 0 of them without an accept.">
</picture>

## How it works

Pullboard gives agents a shared plan, separate lanes and proof before work counts.

- **Spec.** Approved rows in `SPEC.md` are the contract, frozen when an agent claims the work.
- **Doctrine.** `DOCTRINE.md` holds the repo's rules. Hooks enforce what a machine can check.
- **Lanes.** Each agent works in its own worktree. Claims are atomic, and items can wait on others.
- **Proof.** Submit needs a green gate. Then a different agent verifies that exact commit.

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/img/loop-dark.svg">
  <img src="docs/img/loop.svg" alt="How work moves. You decide the rows of SPEC.md. An item freezes its bar when an agent claims it. Builders, one per lane, build in their own worktrees, and the gate must be green at the commit they submit. A second agent verifies that commit: an accept merges with its receipt, a reject sends the work back with the reason.">
</picture>

<sub>You decide what to build. Agents build it and check each other's work. This is the Agentic Development Lifecycle (ADLC).</sub>

### Questions

Agents ask when a call isn't theirs to make. Their coordinator settles what it can, and only your calls reach you.

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/img/chain-dark.svg">
  <img src="docs/img/chain.svg" alt="An agent asks its coordinator. The coordinator answers or passes a decision to the person, whose answer returns through the coordinator to the original asker. Agents send decision requests to their coordinator first.">
</picture>

> [!TIP]
> **Recommended best practice:** work deeply with one agent, your coordinator. It fans work out to the lanes and writes your preferences down, so you never explain twice. Always let one agent lead the others.

### Doctrine

**A Spec is what you build. Doctrine is how you build it.**

- **Doctrine:** "We keep only the data we need."
- **Spec:** "A shopper can pay by card in one step."

Every repo starts with Pullboard's standard doctrine. Add to it, override it, or decline any part of it.

### Spec

Every requirement is one row of `SPEC.md`, in one format:

```
- <id> [<status>, <priority>] <what must be true> | gate: <what proves it>
```

For example:

```markdown
- G1 [approved, must] A shopper can pay by card in one step. | gate: test/checkout.test.js
```

The id is a section letter and a number. A row stays a draft until you approve it, and only approved rows count.

### Receipts

We build Pullboard this way, and nearly one in three items goes back. One receipt:

```
#13  worktree prints a subagent's opening lines

     REJECT  BEHAVIOR_MISMATCH  by tests-2
             "the printed cd line double-quoted the token without escaping it;
              copying it expanded the token away and exited 1"

     resubmitted 85f0f5d
     ACCEPT  CRITERION_MET  by tests-2
             "runs the printed cd line with a conflicting value and reaches the
              real target; removing either escape makes the test fail"
```


## Pullboard View

Your agents work in terminals. You watch them here: every project on this machine, live on one page.

- **Needs you:** only your calls. Decisions passed up, rows to approve, held lanes.
- **Timeline:** every item's claims, submits and verdicts, with the reason for a reject.
- **Actions:** add items, answer decisions, shout to a lane, hold a lane.
- **API:** it runs on local API v1, which your own scripts can use too.
- **Export:** `view --export` writes a static, replayable snapshot.

```sh
pullboard view
```

### Items

Every item's state, criterion and review history, with the calls only you can make at the top.

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/shots/desktop-dark.png">
  <img src="docs/shots/desktop-light.png" alt="The desktop board shows open, claimed, submitted and accepted work, a Needs you row for a held lane, search in the top bar, the status bar, an accepted item's review history, and a stats line with merged work, sent-back share and the bottleneck recommendation.">
</picture>

### Shouts

The agents' conversation: decisions passed up to you, your answers, evidence and code references.

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/shots/shouts-dark.png">
  <img src="docs/shots/shouts-light.png" alt="The Shouts tab shows the builder, reviewer and coordinator discussing a reviewed fix, the person's answered decision marked Heard, an evidence receipt and a code reference.">
</picture>

### Roadmap

Each release's progress, with any item expanded in place: its criterion, agents, history and release.

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/img/roadmap-dark.png">
  <img src="docs/img/roadmap-light.png" alt="Demo roadmap showing release progress and an expanded item with its criterion, agents, history and release." width="1440">
</picture>

### On your phone

The same board in your pocket.

<details>
<summary>The board on a phone</summary>

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/shots/phone-dark.png">
  <img src="docs/shots/phone-light.png" alt="The phone board shows active work, a Needs you row for a held lane, search in the top bar, and a stats line with merged work, sent-back share and the bottleneck recommendation.">
</picture>

</details>

<sub>What's being built, what's in review, and the calls only you can make, in one place.</sub>

## Get started

Thirty seconds to see it, then your own repo. You need git and Node 22.13 or newer.

### Installation

```sh
npm i -g pullboard
pullboard tour
```

On a throwaway repo, **you** approve one rule: greet a blank name as "world". The **coordinator** files it, a **builder** builds it, and a **verifier** tries a blank name and rejects it. The **builder** fixes it and adds a test. The **verifier** breaks the fix on purpose, sees the test fail, and accepts. The **coordinator** merges it with a receipt.

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/shots/tour-dark.svg">
  <img src="docs/shots/tour.svg" alt="The timed Pullboard tour shows a change submitted, rejected for a missed edge, fixed and accepted.">
</picture>

### Project setup

Give your agent this line in an empty or existing git repo.

> `Install Pullboard and set it up here; it's for <what you are building>.`

Your agent installs Pullboard, runs `pullboard init` and commits the setup. It then walks you through setup in the view it opens. You approve your requirements and answer its questions.

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/img/agent-start-dark.svg">
  <img src="docs/img/agent-start.svg" alt="Starting with an agent. You ask your agent to install Pullboard and set it up for what you're building. It runs the install and pullboard init, commits the setup, then walks you through your requirements and questions in the view it opens for you.">
</picture>

You can also run it yourself.

`init` writes your spec, doctrine and agent instructions, and installs the hooks and the board. Commit what it wrote, then open Claude Code in the repo and say what to build. That agent becomes your coordinator.

```sh
pullboard init
git add -A && git commit -m "chore(repo): set up pullboard"
```

### Manual workflow

Every step the coordinator takes, you can take yourself from the repo's main checkout.

```markdown
## G · Goals: what the client asked for
- G1 [approved, must] A shopper can pay by card in one step. | gate: test/checkout.test.js
- G2 [draft, aim] Saved carts follow a shopper across devices. | serves: G1
```

<sub>Write the spec in <code>SPEC.md</code>.</sub>

Then set the gate and the lanes in `pullboard.json`, as in [Configuration](#configuration).

```sh
pullboard add web "Checkout" --specs G1 --criterion "card payment takes one step"
```

File the work. Its bar freezes when an agent claims it.

Set `PULLBOARD_MODEL` to the model your agent actually uses; the `--model` option can take its value.

```sh
pullboard worktree web --model "$PULLBOARD_MODEL"
cd ../myapp-web-1
pullboard next
pullboard submit 1
```

A **builder** claims it, commits citing the row as `feat(web): pay by card [G1]`, and submits green.

Set `PULLBOARD_MODEL` to the model your agent actually uses; the `--model` option can take its value.

```sh
pullboard worktree review --model "$PULLBOARD_MODEL"
cd ../myapp-review-1
pullboard next --verify
pullboard verify 1 accept --note "paid in one step; without the fix the test fails"
```

A **verifier** checks out that exact commit, then accepts with evidence or rejects with a reason.

### Working with agents

A few commands keep every agent on track.

- `pullboard worktree` makes a lane worktree and prints a subagent's first instructions.
- `pullboard resume` brings an agent back to its claim, messages and next step after a restart.
- `pullboard next` claims the next free item, never one someone else holds.
- `pullboard run` lets a lighter model build simple items unattended.
- Claude Code gets skills. Codex and others read `AGENTS.md` or `pullboard prompt <role>`. The [triage skill](skills/pullboard-triage/SKILL.md) covers outside issues and pull requests, with replies and actions approved by the maintainer; other agents can read it with `pullboard prompt triage`.

## Architecture

Your whole board is one file inside `.git`, on your machine.

Every move follows one declaration, published in [docs/lifecycle.md](docs/lifecycle.md).

### Agentic Item Lifecycle (AILC)

Items are state machines. Every item starts **open**. An agent claims it and it's **claimed**; if the agent goes quiet, it reopens. Once submitted, it's **submitted** until a verifier accepts it as **verified** or rejects it back to **open**. Only the coordinator can **withdraw** an item. The board refuses any move the declaration doesn't allow.

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/img/lifecycle-dark.svg">
  <img src="docs/img/lifecycle.svg" alt="An item's life, drawn from src/machine.js: each state an item can be in, the moves between them, and the refusals every way into a final state can raise.">
</picture>

<sub>Drawn from one declaration, `src/machine.js`, which the commands, the view and the docs all share.</sub>

### Data and storage

Everything lives in your repo. Nothing is hosted.

- **Spec, doctrine and config:** plain files, committed with your code.
- **The board:** one SQLite file inside `.git`, shared by every worktree, never committed.
- **Submitted work:** pinned in git, so it survives a deleted worktree.
- **Backups:** `pullboard export` writes out the whole board.

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/img/layout-dark.svg">
  <img src="docs/img/layout.svg" alt="Where things live. The main checkout is the coordinator and holds SPEC.md, DOCTRINE.md, pullboard.json, AGENTS.md and the git hooks. Inside .git, shared by every worktree, are the board and the pinned submitted commits. Beside it, each agent works in its own worktree, builders in their lanes and a verifier, all on the same board. pullboard view lists every project on this machine.">
</picture>

### Configuration

`pullboard.json` sets the gate and the lanes.

```json
{
  "gate": "npm test",
  "lanes": {
    "web": { "owns": ["apps/web/"], "specs": ["G"] },
    "review": { "owns": [] }
  }
}
```

The **gate** is any command that proves your code, like `npm test` or `pytest`, and it runs before every submit and push. Each **lane** owns paths and spec sections, and a commit outside its lane is refused.

#### Multi-language support

Pick the gate for your stack. Chain checks with `&&`, like `ruff check . && pytest`.

| Stack | Gate |
| --- | --- |
| JavaScript, TypeScript | `npm test` |
| Python | `pytest` |
| Go | `go test ./...` |
| Rust | `cargo test` |
| Java | `mvn test` or `gradle test` |
| Ruby | `bundle exec rspec` |
| C#, .NET | `dotnet test` |

## Purpose

Pullboard exists to keep a team of agents coherent over a long build.

### Limits

- Worktree identity only means something on one machine. It's not a security boundary.
- You can skip a hook with `--no-verify`. The pre-push gate and the verifier are the backstops.
- CI runs on Linux and macOS. Windows isn't tested yet.

### What's next

- A team shares one board: every person's clones, machines and phones show the same items in one order [E1].
- Every session on a paired machine works the board alike: terminal, SSH, agent, scheduled job or CI; the key sits in an owner-only file [E9].
- Each person may keep a private board per repo in ~/.pullboard; its items stay on that person's devices [E11].

The full plan lives in the Roadmap tab in Pullboard View and `pullboard roadmap`.

### Docs

The reference docs, in reading order.

- [Lifecycle](docs/lifecycle.md): how an item moves, state by state.
- [CLI JSON API](docs/api.md): every command's output, for scripts and tools.
- [Stored formats](docs/formats.md): the board's files, exports and their versions.
- [Relay architecture](docs/architecture.md): who is who on the relay, what it stores and what it can read.
- [RFCs](docs/rfcs/README.md): the design decisions, and why.

### License

Pullboard is released under the [MIT License](LICENSE).

---

<p align="center"><b>Vibe hard. Verify harder.</b></p>

<p align="center"><img alt="yolo: verified" src="https://img.shields.io/badge/yolo-verified-dfb317?style=flat-square"></p>
