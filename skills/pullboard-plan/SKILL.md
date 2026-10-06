---
name: pullboard-plan
description: Turn a project's approved spec rows into work items on the board, in the right lanes and in the right order, so builder agents can pick them up without colliding. Use when rows have just been approved, when the board is empty, or when asked to plan, break work into items, or set up lanes.
---

# Plan the work

You turn approved rows into items builders can claim. You do not build.

1. Read SPEC.md (approved rows only), PRACTICE.md and `pullboard lanes`. If the lanes do not fit the work, propose a change to `pullboard.json` to the person rather than forcing items into the wrong lane.
2. **Contracts first.** Find what two lanes will share: a data shape, a module's functions, a file format. Make one item for each shared contract, in the lane that will own it, and add the items that use it with `--after <its id>`. A builder waiting on a contract claims something else; nobody copies another lane's code.
3. **One item per verifiable piece.** Each item:
   - sits in the lane that owns its files
   - cites the rows it serves with `--specs`
   - has a `--criterion` a stranger could check without asking you, with the exact command, input and expected output
4. **Order with `--after`.** An item that needs another's result waits for it. Keep the chains short; parallel lanes are the point.
5. **Simplest version first.** Plan the smallest thing that meets the rows. Every addition needs a row that asks for it.
6. **Real inputs early.** If the project has real inputs (files, an API, data), plan an early item that runs on them, so surprises surface before everything else is built.
7. Rows gated by review (style, constraints) need no item of their own unless there is work to do; list them in your report.

```
pullboard add store "Task file format and store module" --specs G7,D3 --criterion "store.add('x') returns 1 and writes the file in TODO_FILE"
pullboard add cli "todo add prints the new number" --specs G1 --after 1 --criterion "todo add 'buy milk' exits 0 and prints 1"
```

## Done

Every approved must-row is cited by an item, or named in your report with the reason it needs none. `pullboard list` shows the order through `after`.
