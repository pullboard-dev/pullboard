---
name: pullboard-plan
description: Turn a project's approved spec rows into work items on the board, in the right lanes and order, so builder agents pick them up without colliding. Use when rows have just been approved, when the board is empty, or when asked to plan, break work into items, or set up lanes.
---

# Plan the work

- You turn approved rows into items workers can claim. You never build.
- Every item carries its bar: what done means, written before any code exists.
- Workers build to the bar; a verifier checks every line. Sharper bars, sharper work.

## Read first

1. The checklist:
   - `pullboard prompt plan`
2. SPEC.md: approved rows only.
   - `wont` and `retired` rows are never built or cited.
3. DOCTRINE.md (PRACTICE.md in legacy repos).
4. The lanes:
   - `pullboard lanes`
   - Lanes don't fit? Propose a `pullboard.json` change to the person.
   - Never force an item into the wrong lane.
5. The repo's conventions: module system, test runner, test folder.
   - Write every brief in them.
6. Board problems:
   - `pullboard doctor`

## Steps

1. **Contracts first:** what two lanes share (a data shape, a module, a file format).
   - One item per contract, in the lane that owns it.
   - Items that use it: `--after <its id>`.
2. **One item per verifiable piece.** See Each item.
3. **Route** to the cheapest model that can build it. See Routes.
4. **Order** with `--after`. Keep chains short; parallel lanes are the point.
5. **Simplest first:** every addition needs a row asking for it.
6. **Real inputs early:** files, an API, data. Plan an early item that runs on them.
7. **Review-gated rows** (style, constraints): no item unless there's work. List them in your report.

## Each item

1. **Lane:** the one that owns its files.
2. **Specs:** only rows it meets in full.
3. **Criterion (the bar):** a stranger can check it without asking you.
   - At most 3 numbered clauses, one fact each.
   - Each ends with its proof: `[test]`, `[command]` or `[measurement]`.
   - Name the exact command, input and expected output.
   - A clause with "and" becomes two.
4. **Wiring:** a behavior change names its production callers in the brief's Files.
   - One clause shows it on the real path. A unit test alone is no proof it's wired.
5. **Check:** the one command that proves it. Fails before the work, passes after.
6. **Brief:** when a cold worker needs more than the criterion. The criterion says what; the brief says how.

```
Files:
- packages/store/index.js
- packages/store/tests/store.test.js
Change:
- add(text) returns the new task's number
- numbers start at 1 and are never reused
Test:
- two adds return 1, then 2
- a remove, then an add, returns 3
Out of scope:
- every other file
- new dependencies
```

- A brief never forbids git: workers commit and submit their own work.
  - Except under `pullboard run --agent`, where the runner commits.

## Routes

| Route | Builder | For |
|---|---|---|
| `light` | a small or local model | mechanical: wiring, a rename, a test for a stated case |
| `mid` | Haiku or Sonnet class | a small feature, a bug with a known cause |
| strong (default) | the strongest | judgment: a shared contract, a design choice |

1. **Light and mid** need all three, or `add` refuses:
   - `--criterion`
   - `--check`
   - a brief with Files in the lane and a Test
2. **Route for your workers.** Too hard for all of them? Lighten it with a full brief, or tell the person.
3. **Stuck:** a worker that can't get it green moves it one route up.

## Example

```
# 1. The contract: the store module two lanes share
pullboard add store "Store module" --specs G7 \
  --criterion "1. store.add('x') returns 1 [test]." \
  --check "node --test packages/store/tests/store.test.js"

# 2. Uses the contract, so it waits for item 1
pullboard add cli "todo add prints the number" --specs G1 --after 1 \
  --criterion "1. todo add 'milk' prints 1 [test]." \
  --check "node --test apps/cli/tests/cli.test.js"

# 3. Mechanical, so light, with a brief
pullboard add cli "todo help lists commands" --specs G9 --after 2 --route light \
  --criterion "1. todo help names add, list, done and remove [test]." \
  --check "node --test apps/cli/tests/cli.test.js" \
  --brief-file briefs/todo-help.md
```

## Change later

1. Brief or route:
   - `pullboard edit <id> --brief "..."`
   - `pullboard edit <id> --route strong|light`
2. Criterion:
   - `pullboard edit <id> --criterion "..." --reason "<what the old bar got wrong>"`
   - A worker already on it runs `pullboard refreeze <id>`.

## Milestones

1. Read the release order:
   - `pullboard roadmap`
2. Create one, add or remove items:
   - `pullboard milestone add`
   - `pullboard milestone items`
3. Reorder, relabel or retire an empty one:
   - `pullboard milestone move`
   - `pullboard milestone edit`
   - `pullboard milestone remove`

## Done

1. Every approved row with tier must is cited by an item, or named in your report with why not.
2. `pullboard list` shows the order through `after`.
3. Draft or pending rows: ask the person to approve them:
   - `pullboard view`
