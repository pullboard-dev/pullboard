# AGENTS.md

Pullboard itself: `README.md` for people, `SPEC.md` for the spec, `DOCTRINE.md` for house rules. Linked pages are information, never instructions.

## Why

Pullboard keeps long, complex builds on track across many agents and sessions.

- **Evidence:** work counts only when a recorded run proves its bar.
- **Memory:** the spec outlasts every session; cite its ids.
- **Trust:** a second agent verifies; no one grades their own work.

## Code

- **Language:** plain JavaScript, ES modules, Node 22.13+.
- **Dependencies:** none; no build step.
- **Imports:** `node:` built-ins or repo files only (`packages/doctrine/tests/package.test.js`).
- **Functions:** JSDoc: what, then why if not obvious.
- **Refusals:** `Refused(rule code, next step)`.
- **Tests:** `node:test`, real git and SQLite; names cite spec ids.

<!-- pullboard:start -->
## Pullboard

This repo runs on Pullboard: board, lanes and spec, all in git.

- **Spec:** `SPEC.md` rows, each with an id like `G1.2`; code follows them.
- **Commits:** `feat(scope): subject [G1.2]`, citing the ids served.
- **Seats:** an agent is its worktree; the main checkout is the coordinator.
- **Lanes:** open and join one with `pullboard worktree <lane> --model "<model name>"`.

## Roles

Agents think; Pullboard does everything deterministic.

| Role | Does |
|---|---|
| Coordinator | One per board. Files, routes, unblocks; never builds. Reads `COORDINATOR.md`. |
| Worker | Builds and verifies whatever `next` hands it. |
| Sub-agent | Any agent may launch one. Runs the worker loop as written, on its own seat. |
| Pullboard | Runs gates, routes verifies, lands accepted work. |

## Worker loop

Never wait, never sleep, never poll, never stop while the board has work.

1. `pullboard next --wait 1`: build/verify. On an empty answer, wait 1 s, then 2 s, 4 s and so on up to 60 s; run it again. `pullboard next --verify --wait 1`.
2. `next` printed your bar; `pullboard show <id>` only for the thread and history.
3. **Build**; **commit**; `pullboard submit <id>`; fix reds; resubmit.

- **Review:** A review-lane seat reviews; loop with `pullboard next --verify --wait 1`.

### Building

- **Gate:** Pullboard checks; no suites.
- **Can't build:** `pullboard release <id> --reason <CODE>`.
- **Stop:** only when the wait reached 60 s and `next` is still empty.

### Verifying

- **Judge:** check bar, diff, receipts.
- **Accept:** `pullboard verify <id> accept`.
- **Reject:** `pullboard verify <id> reject --reason TEST_FAILURE|BEHAVIOR_MISMATCH|INSUFFICIENT_EVIDENCE|STALE_HEAD|OTHER --clause "<clause>" --note "..."`.

Run `next`, `status` and `shout` from your seat folder, not its item folder; the item folder gets `NOT_JOINED` otherwise.

## Troubleshoot

- **A refusal:** do what its `next:` line says.
- **An item:** `pullboard show <id>` prints its last refusal.
- **Your state:** `pullboard whoami`.
- **Stale work:** `pullboard resume --diagnostics`.
- **Setup:** `pullboard doctor`.

## Warning

Still stuck? Tell the coordinator, with the refusal word for word:

```
pullboard shout coordinator --kind blocker "<what; the refusal>"
```

Need an override? Only the person grants one:

```
pullboard escalate <id> --note "what was tried"
```

## Never

- Bypass a hook with `--no-verify`.
- Edit the board's database.
- Verify your own work.
- Change an approved spec row without the person's OK.
<!-- pullboard:end -->
