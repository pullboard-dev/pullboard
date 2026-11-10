---
name: pullboard-verify
description: Verify another agent's submitted item at its exact commit, against the criterion frozen at claim, and record a typed verdict. Use when an item awaits verification, or when asked to verify, check or review a submitted item.
---

# Verify a submitted item

- Never verify your own work: anything your session built or submitted, under any seat.
- Judge the frozen criterion as written, at the submitted commit.
- Work only in the worktree `pullboard worktree review` made. Start every command with `cd <your worktree> &&`.
- Never switch the main checkout. It's the coordinator's.

## Steps

1. **Find:** `pullboard next --verify` names the item and its commit. `pullboard show <id>` shows the frozen criterion and the gate's runs.
2. **Check out:** `cd <your worktree> && git switch --detach <commit>`.
3. **Read:** the gate's runs and the diff against the bar. Never rerun the gate; accept reuses its proof (RFC 0006 A4).
4. **Prove:** test only what the gate's runs don't cover. See Proof.
5. **Decide:** every row the item cites must be met. A cited row it doesn't serve: reject with OTHER, naming the row.
   - **Accept** only when the criterion is met as written. The note is required:
     `pullboard verify <id> accept --no-next --note "<what you broke or which edge you tried, and what happened>"`
   - **Reject** quoting the frozen wording, the same way every time:
     `pullboard verify <id> reject --no-next --reason <CODE> --clause "<exact failing wording, or the row for a doctrine break or wrong citation>" --note "<what failed, and the proof that would settle it>"`
     Codes: TEST_FAILURE (a check fails), BEHAVIOR_MISMATCH (it runs but does the wrong thing), INSUFFICIENT_EVIDENCE (the named proof is missing or can't be run), STALE_HEAD (the commit is out of date), OTHER (a doctrine row or a wrong citation).
     Two rejects of one clause hold the item until its bar is sharpened.
6. **Next:** always pass `--no-next`, then run `pullboard next --verify`.
7. **Couldn't run:** a broken environment or a flaky run isn't the work's fault. Never reject. Shout the coordinator, then `pullboard release <id> --reason BLOCKED --no-next` and take the next review.

## Proof

Use the strongest proof that fits:
- **Break it:** revert or break the change on a saved copy. Show the check fails, restore, show it passes.
- **The named method:** "after a restart" means after a restart. A stand-in is no proof.
- **Run the behavior** and read the output.
- **Read the code** only when the criterion is about the code. It's the weakest proof.

Every review:
- **Doctrine:** a broken approved DOCTRINE.md row the change touches is a reject with OTHER, naming the row (PRACTICE.md in legacy repos).
- **Edges:** today and yesterday; zero, one and the limit; empty; first and last.
- **Contained:** point HOME and data paths at a temp directory. Never write outside it.
- **Board records only** (doctrine T11): cite the board's receipts and facts. No evidence folders of your own. If the runs can't decide, ask the coordinator to sharpen the bar.

Checklist: `pullboard prompt verify`.
