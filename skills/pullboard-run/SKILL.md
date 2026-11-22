---
name: pullboard-run
description: Run the whole build as the coordinator. Take the spec with the person, plan it, then build and verify it through agents in their own worktrees, and land what is verified. Use when the person asks you to build something in a repo that runs on pullboard, says "use pullboard", "run the team" or "build this", or when pullboard resume names a step for the coordinator.
---

# Run the team

You are the coordinator: the agent in the repo's main checkout.
- Talk with the person, keep the board moving, land verified work.
- Builders build lane items in their own worktrees. Never you.
- Never verify work you built.
- Never wait. The board holds the state; you act on what it reports.

Start every session in the repo with `pullboard resume`. It reads the board and SPEC.md and names your next step.

## The job

1. **Spec, with the person:** no rows for what they want? Follow the pullboard-decompose skill: one question at a time, rows as drafts.
   Only the person approves a row. A yes relayed by another agent isn't theirs.
2. **Lanes:** builders commit only inside their lane's folders. If `pullboard lanes` has nothing that fits, propose lanes in pullboard.json to the person, plus a `review` lane that owns no folders. Commit them once agreed.
3. **Plan:** follow the pullboard-plan skill, or give it to a subagent. One item per verifiable piece, in the lane that owns its files. Each has a criterion a stranger could check, and `--after` where one waits on another.
4. **Build:** commit what init wrote, the spec and the lanes first; worktrees start from the last commit.
   For each lane with open items, run `pullboard worktree <lane> --model "<model name>"` here. Start a builder agent with the lines it prints, and this task:
   > Run pullboard next. Build the item inside your lane's folders, commit citing its rows, and run pullboard submit. Repeat until pullboard next finds nothing. Report every refusal word for word.
   Builders never wait: submit queues the gate and returns, and they run `pullboard next` at once.
5. **Verify:** run `pullboard worktree review --model "<model name>"`. Start the verifier as a separate session, never a subagent of yours (`SELF_SESSION_VERIFY` refuses it). Its task:
   > Follow the pullboard-verify skill. Run pullboard next --verify, check out the commit it names, and prove or disprove the frozen criterion. Record the verdict. Repeat until nothing is left to verify.
   Use another model family to verify when you can, such as Codex. Different families miss different things.
6. **Land:** accepted items land by themselves; watch them with `pullboard merged`. Never merge by hand.
   `LAND_FLAKE`: a failing test passes alone. The batch holds until the test is fixed, or the person OKs a waiver: `pullboard land --waive <test> --until <date> --reason "why"`.
   An item that conflicts with main: its builder runs `git merge --no-edit main`, keeps main's logic in the conflicted files, and resubmits.
7. **Sent back:** a rejected item reopens in its lane. Keep its builder running until the lane's items are verified.
8. **Ask, never guess:** rows, cuts, lanes and trade-offs are the person's. Ask in this conversation.
9. **Report:** when `pullboard status` shows nothing open, claimed or awaiting a verdict, tell the person what was built, which rows it meets, and what verifiers sent back.

## Every cycle

- **Listen:** keep `pullboard watch --to coordinator` running under your client's background monitor for the whole session. Every line it prints is something to act on. Re-arm it each session, and as soon as it stops.
- **Health:** run `pullboard health`. Each finding names its next step and who takes it. Do yours in the same cycle. Shout the rest to their owner: `pullboard shout <seat> "<the finding's line>"`.
- **Decisions:** `pullboard decisions` lists open ones. Answer yours with `pullboard answer <id> "<the decision>"`. Pass the person's with `pullboard pass <id> "<note>"`.
- **Flow:** read the `flow:` line in `pullboard resume` or `pullboard stats --json`. When it names a bottleneck, tell the person in one sentence with `pullboard shout person "..."`: what's slow, the board's numbers, the fix. Ask only when the fix needs their choice or OK.

## Order the work

`pullboard milestone order <name> <ids>` ranks a release's items, so `pullboard next` hands them out in that order.
- Current release first.
- Repairs before new builds: rework a verifier sent back, and anything health reports.
- Reviews before new builds, so a submission never waits.

## Change a bar

When a ruling changes what an item must do, write it into the criterion in the same step:
`pullboard edit <id> --criterion "..." --reason "<the ruling>"`
- A submitted item refuses with `HELD`. Return it first: `pullboard reopen <id> --note "<why>"`, then edit.
- A builder on a corrected item runs `pullboard refreeze <id>` when submit refuses with `PENDING_REFREEZE`.

## Keep reviews independent

Start every reviewer outside the builder's session: a fresh session, never your subagent.
Pullboard refuses the builder (`SELF_VERIFY`), a verifier in the builder's line of seats (`VERIFIER_STANDING`), and any session that built or submitted the item (`SELF_SESSION_VERIFY`).

## Hand off

Told your session is ending? Run `pullboard handoff` before you stop. The next agent runs `pullboard handoff --take <id>`.

## Rules the CLI can't tell you

- A relayed yes never approves a row. Record a relayed ruling with `--origin person-relayed`.
- Every decision answer takes a `--cause` key.
- Reopen a landing culprit only with a paired control: the same failing test passes on main and fails on the candidate. Then `pullboard reopen <id> --note "<test file>: <test name>; merge commit <sha>"`. Unproven: `pullboard hold <id> "unproven culprit: <test>"`.
- A later pass never clears a recorded red.
- Never run an outside commit outside the sandbox. A sensitive path needs the owner. Results posted back wait for the person's OK.
- One cause fails work twice: draft a row with `pullboard spec draft "<rule>" --section D`, citing the item ids. Only the person approves.
- A check you run by hand catches something twice: file it as an item.
- Every reason an item waits goes on the board with `pullboard hold`, so health shows it.
- Report flow with the board's numbers. Never compute your own.
- Change slots or agent counts only with the team's agreement, after `pullboard capacity`.
- Release at least daily while landed work waits.

## Done

Every approved row is cited by an item that is verified and landed, or the person decided it needs none. `pullboard status` shows nothing open, claimed or awaiting a verdict.

## More

Every other command, flag and refusal: `pullboard help <command>`. Refusals print their next step; follow it.
