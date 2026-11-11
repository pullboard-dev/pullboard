---
name: pullboard-verify
description: Verify another agent's submitted item at its exact commit, against the criterion frozen when it was claimed, and record a typed verdict. Use when an item awaits verification, or when asked to verify, check or review a submitted item.
---

# Verify a submitted item

You never verify your own work. You judge the frozen criterion as written, at the commit that was submitted.

Work only in your own worktree, the one `pullboard worktree review` made. Your shell may start each command in the main checkout, which is the coordinator's, so begin every command with `cd <your worktree> &&`. Never switch the main checkout to another commit.

1. `pullboard next --verify` names the next submitted item you did not build, and its commit. `pullboard show <id>` gives the criterion as frozen at claim.
2. Check out exactly that commit, in your worktree: `cd <your worktree> && git switch --detach <commit>`.
3. Run the gate. Then test the criterion itself, with the strongest proof you can get:
   - **Break it and watch it fail.** Revert or break the change, show the check fails, restore it, show it passes.
   - **Use the method the criterion names.** If it says "two real processes" or "after a restart", use exactly that; a weaker stand-in is not proof.
   - **Run the behavior** and read the output.
   - **Read the code** only when the criterion is about the code itself. It is the weakest proof.
   - **Check the house rules too.** Read the approved rows of DOCTRINE.md (or PRACTICE.md when it is the only legacy file) that the change touches. A broken one is a reject with reason OTHER, naming the row.
   - **Try the edges.** Today and yesterday for dates; zero, one and the limit for numbers; empty for lists; the first and the last. Most bugs live at an edge the builder's tests skipped.
   - **Keep checks contained.** Run them with HOME and any data paths pointed at a temporary directory; a check must never write outside it.
4. Decide:
   - Every row the item cites must be met. If it cites a row it does not serve, reject with OTHER and name the row, so the coordinator fixes the citation; never accept around it.
   - `pullboard verify <id> accept --note "<what you broke or which edge you tried, and what happened>"`, only when the criterion is met as written. The note is required: passing tests alone are not proof.
   - `pullboard verify <id> reject --reason <CODE> --note "<what failed, and the proof that would settle it>"`. The codes are TEST_FAILURE, BEHAVIOR_MISMATCH, INSUFFICIENT_EVIDENCE, STALE_HEAD and OTHER.
5. If the check could not run for reasons that are not the work's fault, such as a broken environment or a flaky run under load, do not reject. Shout the coordinator what happened.
