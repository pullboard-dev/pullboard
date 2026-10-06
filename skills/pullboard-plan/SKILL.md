---
name: pullboard-plan
description: Turn a project's approved spec rows into work items on the board, in the right lanes and in the right order, so builder agents can pick them up without colliding. Use when rows have just been approved, when the board is empty, or when asked to plan, break work into items, or set up lanes.
---

# Plan the work

You turn approved rows into items builders can claim. You do not build.

1. Read SPEC.md (approved rows only; rows marked `wont` or `retired` are never built or cited), PRACTICE.md and `pullboard lanes`. If the lanes do not fit the work, propose a change to `pullboard.json` to the person rather than forcing items into the wrong lane. Read the repo's conventions too, and write every brief in them: the module system (`"type"` in package.json), the test runner, where tests live.
2. **Contracts first.** Find what two lanes will share: a data shape, a module's functions, a file format. Make one item for each shared contract, in the lane that will own it, and add the items that use it with `--after <its id>`. A builder waiting on a contract claims something else; nobody copies another lane's code.
3. **One item per verifiable piece.** Each item:
   - sits in the lane that owns its files
   - cites with `--specs` only the rows it meets in full; a verifier rejects an item that cites a row it does not meet
   - has a `--criterion` a stranger could check without asking you, with the exact command, input and expected output
   - has a `--brief` (or `--brief-file`) when a builder starting cold would need more than the criterion. The criterion says what; the brief says how. Write it in four labelled parts:

     ```
     Files:
     - src/store.js
     - test/store.test.js
     Change:
     - add(text) returns the new task's number; numbers start at 1 and are never reused
     Test:
     - in test/store.test.js, two adds return 1 and 2, and a remove then an add returns 3
     Out of scope: every other file; no new dependencies
     ```

     Builders commit and submit their own work, so a brief never forbids git. Only the packs `pullboard run` writes say so, because there the runner commits.
   - has a `--check` when it can: the one command that proves it, such as `node --test test/store.test.js`.
4. **Route each item to the cheapest model that can build it.** Every item an expensive model builds that a cheaper one could have is waste.
   - `--route light`: a small or local model can build it from the brief alone. Mechanical work: wiring, a field through three files, a test for a stated case, a rename.
   - `--route mid`: a capable model such as Haiku or Sonnet: a small feature, a bug with a known cause.
   - Leave on the default strong route what needs judgment: a shared contract, a design choice, an edge the brief cannot settle.
   - Route for the builders who will join. An item routed above every builder's tier is never built: make it lighter with a full brief, or tell the person the fleet needs a stronger builder.
   - Below strong, an item needs `--criterion`, `--check`, and a brief whose Files sit in the item's lane and whose Test says what it asserts; `add` refuses it otherwise. Agents take their own tier first, then lighter ones; a builder that cannot get an item green escalates it one tier up.
5. **Order with `--after`.** An item that needs another's result waits for it. Keep the chains short; parallel lanes are the point.
6. **Simplest version first.** Plan the smallest thing that meets the rows. Every addition needs a row that asks for it.
7. **Real inputs early.** If the project has real inputs (files, an API, data), plan an early item that runs on them, so surprises surface before everything else is built.
8. Rows gated by review (style, constraints) need no item of their own unless there is work to do; list them in your report.

```
pullboard add store "Task file format and store module" --specs G7,D3 --criterion "store.add('x') returns 1 and writes the file in TODO_FILE"
pullboard add cli "todo add prints the new number" --specs G1 --after 1 --criterion "todo add 'buy milk' exits 0 and prints 1"
pullboard add cli "todo help lists every command" --specs G9 --after 2 --route light \
  --criterion "todo help exits 0 and names add, list, done and remove" \
  --brief "Add a help case to the command switch in src/cli.js, next to add. Copy how add prints. Test it in test/cli.test.js the way the add test runs the CLI."
```

To change a brief or a route later: `pullboard edit <id> --brief "..."` or `--route strong|light`. The criterion changes only by `pullboard refreeze`.

## Done

Every approved must-row is cited by an item, or named in your report with the reason it needs none. `pullboard list` shows the order through `after`.
