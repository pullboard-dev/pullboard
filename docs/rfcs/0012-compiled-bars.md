# RFC 0012: Compiled bars

- Status: proposed, 21 November 2026. By Corey Olson. Not for approval until generated checks pass CB6 and a replay on real items reports.
- Builds on RFC 0006, 0007 and 0011. Uses RFC 0009 CR3 and RFC 0010 CS3 as proposed. On acceptance, amends V2, V3, V8, SC7, SC9 and SC10 for generated checks.
- Ids in brackets (CB1…) become spec rows with new ids on approval.

## Summary

The compiler reads pinned code and puts approved rules in scope for identified paths into the bar.

1. **Find** the paths the item touches.
2. **Apply** the standing rules in scope.
3. **Freeze** them into the bar at claim. Generated checks prove them.

Why:
- A later path cannot silently omit a rule its generated check covers.
- Compiling is bookkeeping. The bar stays the person's.

## Motivation

Agents building in parallel miss each other's rules. One adds a rule, and another adds a path without it. Each passes its own bar. In one test, four agents built a 12-feature booking app.

Frozen hidden tests passed, out of 89 (higher is better):

| Model | Plain task | Compiled task |
|---|---|---|
| Sonnet | 71 | 86 |
| Haiku | 67 | 87 and 80 |

A fuzzer's reported rule gaps fell from 23 to 3 for Sonnet, and from 19 to 3 and 13 for Haiku. Two later phases adding new paths pointed the same way. The benefit looks real but is not proven: it is one app, this compiled the task only, no generated check ran, and we make no cost claim.

## Design

### Paths [CB1]
- A path is a function that changes shared state, or offers a choice built on it.
- Found from static callers of what a rule guards, and from paths the batch declares.
- Only identified paths are claimed.

### Declared paths [CB2]
- A new path is declared in the item's first clause as `name(`.
- `add` and `edit` lint it. Submit refuses undeclared exported writers.
- Review checks new choice paths.
- A discovery failure is recorded and claims no coverage.

### Standing rules [CB3]
- An approved spec row marked `standing`, with a scope and named exemptions.
- No scope, no compile. The board asks the person.

### Compile at claim [CB4]
- At claim, atomically append the paths and each rule in scope.
- The bar says: "Apply a new rule on every listed path within this item's authority."
- And: "Make a new path enforce every rule."
- A path in another cell becomes a child item (CD55-CD57).
- An integration child proves them together (CD58). A wide change uses CD59's slot.
- The section has its own digest. Changing it changes the bar.

### Landing recheck [CB5]
- Recompute paths on each exact staged tree (RFC 0011), before compare-and-set.
- A new applicable path blocks landing until the person re-freezes or signs off.
- A sign-off names the omitted obligation and its tree or immutable inputs.
- The receipt shows the gap, and a follow-up is filed.
- A re-freeze voids earlier verdicts and needs a new review.
- No sign-off waives Sprint's static and changed-cell proof (V37).

### Generated checks [CB6]
One frozen test per standing rule, per path in scope.

The same frozen inputs run before (base) and after (candidate):

| Behaviour | Before | After |
|---|---|---|
| Kept | passes | passes |
| Changed | fails | passes |
| New path, with stub or absence assertion | fails | passes |
| Unrelated debt, independently confirmed | fails | signed off |

- Its own clause kind, not CR3 `[test, kept]`.
- "Fails" means a real assertion failure.
- Load errors, missing tests, bad fixtures, skips and zero tests prove nothing.
- Infrastructure outcomes prove nothing and retry (SC6).
- A kept check must first fail on a known-broken fixture (PB4).
- That fixture, or a real failure before the change, is the negative control.
- Unrelated debt blocks until the person signs off, one item per cause (CS3).
- The receipt records the omission.

### Check identity [CB7]
- Checks live in their own tree at a board ref, outside any cell (CD17).
- It pins manifest, helpers, fixtures, runner config and rule-path list.
- Anything unpinned fails closed.
- A compiled receipt's key is SC7's three trees plus this one.
- The frozen digest, verdict (V8), runner job and exact-tree coverage name it.
- SC9 reads the command from it. SC10 reuse needs all four trees.
- Cached results carry forward only within their scope.
- Landing coverage names the exact staged tree and inputs.
- A changed-base or three-tree receipt never substitutes (SC11).
- The ref stays while any receipt or record names it.

### Only approved rows [CB8]
- A draft compiles into nothing (PB1, P6).
- Marking a row standing or changing its scope is a person move.

### Routing [CB9]
After the replay: mostly compiled bars route light. New cells, contracts and rules route strong.

## Evidence owed
- Generated checks, built and run through CB6.
- A replay on real items, reporting precision and recall.
- An independent benchmark.

## Limits
- Static analysis misses dynamic paths.
- A rule without its exemptions makes a false obligation.
- A caller list can be too long to use.

## Open questions
- Path discovery beyond JavaScript.
- How a scope names exemptions: path, tag or cell.
- Generated checks per item, or per landing batch.
