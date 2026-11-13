# Design: the arbiter

Status: a proposal for the person. Nothing here is built.

The arbiter is a deterministic controller in the board, not an agent. Agents are cars and files, functions and cells are intersections. Today the coordinator stands in every intersection: routing and assignment were 38 percent of all decisions from 12 to 26 October. The arbiter takes the rules that code can decide and leaves the coordinator the rest.

## Part 1: right of way

| Rule | Item |
|---|---|
| Right of way is a lease, granted only by the arbiter | #1413 |
| A colliding claim is refused | #1117 |
| No gridlock: a claim leases everything it needs at once, never piece by piece | #1439 |
| Green waves: hand out the largest set of ready items that touch nothing in common | #1440 |
| Quiet versus busy units: optimistic on quiet files, strict leases on busy ones | #1441 |
| Preemption: main-red fixes and the person's urgent items go first | #1441 |
| Fairness: a waiting item gains priority over time | #1440 |
| Function-level right of way inside hot files | #1202 |
| Seats that leave release their leases within minutes | #1168 |
| Traffic reports: wait time per unit and the busiest cells | #1436 |

## Part 2: rulings without the coordinator

| Rule | Item |
|---|---|
| A rulings ledger: every ruling is a fact with a cause key; precedent is a lookup by key | #1444 |
| The owner of a call is computed from declared effects, and a declaration that names nothing is refused | #1444 |
| Typed requests for coordinator moves, queued and batchable | #1444 |
| Act and record: a proposal that declares no effects proceeds and records its ruling, off by default | #1447 |

## What the coordinator keeps

The coordinator keeps the exceptions: a call no rule covers, and any call whose declared effects name a coordinator-only move. The person keeps the person decisions: approvals, spec rows and anything that changes what the product is for. The arbiter never decides these.
