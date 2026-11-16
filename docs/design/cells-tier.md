# Design: the cells tier as a skill and an opt-in blueprint

Status: a proposal for the person. Nothing here is built.

We restructured this repo into cells with a process that works. This page proposes shipping that process to users: a skill plus an opt-in blueprint that runs it on any repo. It is opt-in, like every behavior change.

## The five steps

1. **Measure.** The import graph, its cycles and the cell-lint counts, printed as numbers.
2. **Plan.** `packages/codemap/src/io/cells/scripts/plan.js`, generalized beyond this repo: it reads the repo's own folders and proposes the cells and the moves.
3. **Itemize.** File independent cut and move items, one change each, as #1593 did. A restructure is one scripted change in a freeze, not many parallel moves.
4. **Ratchet.** Counts only fall. A shim ages out and is deleted, as #1670 does.
5. **Prove.** Print the same numbers as step 1, after. The restructure worked when they fell.

## The name

Proposed: **cells**. Alternatives for the person to choose: **tidy**, **modules**, **untangle**.

## When it ships

It ships only once our own restructure shows its numbers moving. The numbers we watch:

- import cuts, started at 338 (#1473);
- cut items filed and landed, 34 (#1608 to #1641);
- moves and shim removals, 43 and 43;
- cycle count and cell-lint count, which must fall and never rise.

Until those move, this stays a design.

## The skill and the blueprint

- The skill teaches an agent the five steps and the order to take them.
- The blueprint is opt-in: `pullboard init --blueprint cells` adds the measure step and the ratchet to a repo's gate. Nothing changes for a repo that does not ask for it.

## Items building it would need

- Item: a measure command that prints the import graph, cycles and cell-lint counts for any repo.
- Item: the plan script generalized, with no path from this repo built in.
- Item: an itemize step that files the cut and move items from a plan.
- Item: the ratchet as a blueprint gate check, with shim aging.
- Item: the prove report that compares the numbers before and after.
- Item: the skill text.

## Open decisions for the person

- Which of the four names do we use?
- Which numbers must move, and by how much, before it ships?
- Is the restructure run by an agent unattended, or does the person approve the plan first?
- Does the blueprint ship with `pullboard init`, or only by name?
