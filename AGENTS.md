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
- **Lanes:** join one with `pullboard join <lane>`.

## Roles

Agents think; Pullboard does everything deterministic.

| Role | Does |
|---|---|
| Coordinator | One per board. Files, routes, unblocks; never builds. Reads `COORDINATOR.md`. |
| Worker | Builds and verifies whatever `next` hands it. |
| Sub-agent | Any agent may launch one. Runs the worker loop as written, on its own seat. |
| Pullboard | Runs gates, routes verifies, lands accepted work. |

## Worker loop

Never wait: submit and move on.

1. `pullboard next`: a build or a verify.
2. `pullboard show <id>`: your bar, frozen at claim.
3. **Build** in your lane's folders; pre-commit refuses others.
4. **Commit**, then `pullboard submit <id>`; it returns at once.
5. **Repeat.** `next` returns reds and rejects; fix and resubmit.

### Building

- **Gate:** Pullboard runs it; never run whole suites.
- **Long commands:** background anything over 1 min.
- **Other folders:** shout their owner.
- **Can't build:** `pullboard release <id> --reason <CODE>`, then `next`.
- **Shouts:** arrive only while a command runs.
- **Stop:** after 4 empty `next` answers in a row.

### Verifying

- **Judge:** the diff against the bar and the gate's receipts.
- **Rerun:** only if no recorded run covers a clause, or you doubt the gate.
- **Accept:** `pullboard verify <id> accept`.
- **Reject:** `pullboard verify <id> reject --reason <CODE> --clause "<clause>" --note "..."`.

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
