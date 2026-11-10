---
name: pullboard-plan
description: Turn a project's approved spec rows into work items on the board, in the right lanes and order, so builder agents pick them up without colliding. Use when rows have just been approved, when the board is empty, or when asked to plan, break work into items, or set up lanes.
---

# Plan the work

You turn approved rows into items builders can claim. You never build.

## Read first

- SPEC.md: approved rows only. `wont` and `retired` rows are never built or cited.
- DOCTRINE.md (PRACTICE.md in legacy repos), and `pullboard lanes`.
- The repo's conventions: the module system (`"type"` in package.json), the test runner, where tests live. Write every brief in them.
- Lanes don't fit the work? Propose a `pullboard.json` change to the person. Never force items into the wrong lane.
- Checklist: `pullboard prompt plan`. Board problems: `pullboard doctor`.

## Steps

1. **Contracts first:** find what two lanes share: a data shape, a module's functions, a file format. One item per contract, in the lane that owns it. Items that use it get `--after <its id>`. A builder waiting on a contract claims something else; nobody copies another lane's code.
2. **One item per verifiable piece.** Each item:
   - sits in the lane that owns its files;
   - cites with `--specs` only rows it meets in full. A verifier rejects a row it doesn't meet;
   - has a `--criterion` a stranger can check without asking you: the exact command, input and expected output. At most 3 numbered clauses, one requirement each. A clause with "and" becomes two clauses, or two items;
   - for a behavior change: names its production callers in the brief's Files, and has a clause that the real path shows it. A unit test alone is no proof it's wired;
   - has a `--check` whenever it can: the one command that proves it, such as `node --test packages/store/tests/store.test.js`. It fails before the work and passes after;
   - has a `--brief` (or `--brief-file`) when a cold builder needs more than the criterion. The criterion says what; the brief says how. Four parts:
     ```
     Files:
     - packages/store/index.js
     - packages/store/tests/store.test.js
     Change:
     - add(text) returns the new task's number; numbers start at 1 and are never reused
     Test:
     - in packages/store/tests/store.test.js, two adds return 1 and 2, and a remove then an add returns 3
     Out of scope: every other file; no new dependencies
     ```
     A brief never forbids git: builders commit and submit their own work. Only packs `pullboard run` writes say so.
3. **Route to the cheapest model that can build it.** An expensive model building a cheap item is waste.
   - `--route light`: a small or local model, from the brief alone. Mechanical: wiring, a field through three files, a test for a stated case, a rename.
   - `--route mid`: Haiku or Sonnet class. A small feature, a bug with a known cause.
   - Default strong: judgment. A shared contract, a design choice, an edge the brief can't settle.
   - Light and mid: `add` refuses an item without `--criterion`, `--check`, and a brief whose Files sit in the item's lane and whose Test says what it asserts.
   - Route for the builders who will join. An item above every builder's tier is never built: lighten it with a full brief, or tell the person the fleet needs a stronger builder.
   - Agents take their own tier first, then lighter ones. A builder that can't get an item green escalates it one tier up.
4. **Order with `--after`:** an item that needs another's result waits for it. Keep chains short; parallel lanes are the point.
5. **Simplest version first:** the smallest thing that meets the rows. Every addition needs a row asking for it.
6. **Real inputs early:** if the project has real inputs (files, an API, data), plan an early item that runs on them, so surprises surface first.
7. **Review-gated rows** (style, constraints) need no item unless there's work. List them in your report.

```
pullboard add store "Task file format and store module" --specs G7,D3 --criterion "1. store.add('x') returns 1. 2. It writes the file in TODO_FILE." --check "node --test packages/store/tests/store.test.js"
pullboard add cli "todo add prints the new number" --specs G1 --after 1 --criterion "1. todo add 'buy milk' exits 0. 2. It prints 1." --check "node --test apps/cli/tests/cli.test.js"
pullboard add cli "todo help lists every command" --specs G9 --after 2 --route light \
  --criterion "1. todo help exits 0. 2. It names add, list, done and remove." --check "node --test apps/cli/tests/cli.test.js" \
  --brief "Add a help case to the command switch in apps/cli/index.js, next to add. Copy how add prints. Test it in apps/cli/tests/cli.test.js the way the add test runs the CLI."
```

## Change later

- Brief or route: `pullboard edit <id> --brief "..."` or `--route strong|light`.
- Criterion: `pullboard edit <id> --criterion "..." --reason "<what the old bar got wrong>"`. A builder already on it runs `pullboard refreeze <id>`.

## Milestones

- Read the release order first: `pullboard roadmap`.
- Create: `pullboard milestone add`. Add or remove items: `pullboard milestone items`.
- Reorder or relabel: `pullboard milestone move`, `pullboard milestone edit`. Retire an empty one: `pullboard milestone remove`.

## Done

Every approved row with tier must is cited by an item, or named in your report with why it needs none. `pullboard list` shows the order through `after`.
