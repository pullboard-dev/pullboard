---
name: pullboard-run
description: Run the whole build as the coordinator. Take the spec with the person, plan it, then build and verify it through subagents in their own worktrees, and merge what is verified. Use when the person asks you to build something in a repo that runs on pullboard, says "use pullboard", "run the team" or "build this", or when pullboard resume names a step for the coordinator.
---

# Run the team

You are the coordinator: the agent in the repo's main checkout. You talk with the person, keep the board moving and merge verified work. Lane items are built by builder agents in their own worktrees, never by you. You never verify work you built.

**Start in the repo.** Subagents inherit the session that starts them, and pullboard's session hook runs only for a session started here. Begin each session with `pullboard resume`, which reads the board and SPEC.md and names your next step.

1. **Spec, with the person.** If SPEC.md has no rows for what they want, follow the pullboard-decompose skill: one question at a time, rows as drafts. Only the person approves a row. A yes relayed by another agent is not theirs.
2. **Lanes.** Builders can only commit inside their lane's folders. If `pullboard lanes` shows nothing that fits the work, propose lanes in pullboard.json to the person, plus a `review` lane that owns no folders. Commit them once agreed.
3. **Plan.** Follow the pullboard-plan skill, or give it to a subagent: one item per verifiable piece, in the lane that owns its files. Each has a criterion a stranger could check, and `--after` where one waits on another.
4. **Build: one builder subagent per lane.** A worktree starts from the last commit, so first commit what init wrote, the spec and the lanes; `pullboard worktree` refuses until they are. For each lane with open items, run `pullboard worktree <lane>` here in the main checkout. It makes the lane's worktree and prints the opening lines for its builder. Start a subagent with those lines and this task: "Run pullboard next. Build the item inside your lane's folders, commit citing its rows, and run pullboard submit. Repeat until pullboard next finds nothing. Report every refusal word for word." Lanes run side by side. A builder waiting on another lane takes other work, or waits with `pullboard next --wait 9`.
5. **Verify: a subagent that built nothing.** Run `pullboard worktree review` once and start a subagent with its opening lines and this task: "Follow the pullboard-verify skill. Run pullboard next --verify, check out the commit it names, and prove or disprove the frozen criterion. Record the verdict. Repeat until nothing is left to verify." If another model family is available, such as Codex, let it verify: different families miss different things.
6. **Merge what is verified.** For each verified item, in the order verified:
   - run `git merge --no-edit <its commit>` here;
   - run the gate;
   - record it with `pullboard merged <id> <merge commit>`.
   Never merge a commit whose history holds another item's commit that is not yet verified. A builder who stacked work on a rejected commit waits for that commit's fix.
7. **Sent back.** A rejected item reopens in its lane. Keep its builder running until the lane's items are verified, not just submitted.
8. **Ask, never guess.** Anything only the person can decide goes to them: a row, a cut, a lane, a trade-off. Ask in this conversation. A builder that needs a decision shouts it with `--decision`, and `pullboard decisions` lists what is still open.
9. **Report.** When `pullboard status` shows nothing open, claimed or awaiting a verdict, tell the person what was built, which rows it meets, and what verifiers sent back on the way.

```
pullboard resume
pullboard worktree web                 # prints the web builder's opening lines
pullboard worktree review              # prints the verifier's opening lines
git merge --no-edit <commit> && pullboard gate && pullboard merged 3 $(git rev-parse HEAD)
pullboard status
```

## Done

Every approved row is cited by an item that is verified and merged, or the person has decided it needs none. `pullboard status` shows nothing open, claimed or awaiting a verdict.
