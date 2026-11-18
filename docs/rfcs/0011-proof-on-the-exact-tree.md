# RFC 0011: Proof on the exact tree

- Status: approved (narrowed), 17 November 2026. By Corey Olson.
- Builds on RFC 0006, RFC 0007 and RFC 0008. Amends RFC 0007 SC11.
- Ids in brackets (ET1…) become spec rows with new ids on approval.

## Summary

Main moves only to a tree that is proven as it lands.

1. **Stage:** the lander builds the tree main will point to.
2. **Prove:** every cell of that tree is sealed at its own hash.
3. **Move:** main moves to that tree id, or not at all.

Why it holds:
- A seal names a cell's content, so reuse stays exact.
- A gate that proved a nearby tree proves nothing about this one.
- Every path that moves main passes the same check.

## Motivation

This repository, 9–16 November 2026:
- 3,541 landings on main.
- 194 "main red" items filed; 183 closed without a fix of their own.
- On 16 November, two items each passed their gate alone. Landed together, they put main over a static ratchet.
- Most landings that day went through a hand path that ran no proof on the merged tree.

SC11 lets a receipt stand for a base it never ran on. When that guess is wrong, main goes red and an agent pays to find out. This RFC proves the tree itself.

## Design

### The exact tree [ET1]
- A landing's proof is keyed by the tree id main will point to after it lands.
- An item's tip and a past main are only inputs.

### Proof by seal [ET2]
- The exact tree is proven when every cell in it is sealed at its content hash (SC13).
- A seal from any earlier tree counts if the cell's hash matches.
- Cells without a seal run fresh on the exact tree.
- This replaces SC11's base-move rule. Reuse stays; guessing goes.

### Stage, prove, move [ET3]
1. The lander merges the item onto main's tip and records the tree id.
2. It proves the unsealed cells of that tree.
3. It moves main by compare-and-set from the tip it staged on.
4. If main moved first, it restages. Only cells the new main touched unseal.

### Batches [ET4]
- A batch stages one tree and proves it once.
- A red batch splits in halves until the red item is alone.
- Green halves land; the red item goes back with its failing cells named.

### Every path [ET5]
- Hand landers, pull-out reverts and coordinator commits move main through the same check.
- The trunk refuses a ref update to a tree without a green exact-tree record.
- Behind its own setting, default off, until the product lander carries every landing.

### Pace sets the depth [ET6]
The tree is always exact. Pace sets how much of it is proven before it lands:

| Pace | Proven before main moves |
|---|---|
| Sprint | static checks and the change's own cells; the rest follows, and a red pulls it out |
| Steady | every unsealed cell |
| Strict | the group's full suite on the exact tree |

### Push [ET7]
- A push proves the exact pushed tree.
- Up to eight partitions, sized from board data.
- Every red file is named in one pass.

### The record [ET8]
The exact-tree record holds:
- the tree id;
- the tooling pin;
- the seals reused and the cells run;
- the result.

`pullboard show <id>` prints it beside the landing.

## Open questions
- Restage limit: how many retries before an item yields its turn.
- Whether the trunk check runs as a hook or inside the store's compare-and-set.
- Sprint's follow-up proof: per landing, or batched after several.

## Narrowed (approved 17 Nov 2026)

Corey Olson approved a narrowed RFC on 17 November 2026. Every landing records and proves the exact tree main will point to, at Sprint depth, and every path to main goes through the same check. The full per-landing proof waits until the census is fast enough to pay for it.

| Row | What | Now / deferred | Spec row |
|---|---|---|---|
| ET1 | The proof is keyed by the tree id main will point to | Approved now | V34 |
| ET8 | The record holds the tree id, the tooling pin, cells run and the result; `pullboard show` prints it | Approved now | V38 |
| ET6 at Sprint | Static checks plus the change's own cells, run on the exact tree before main moves | Approved now | V37 |
| ET5 | Every path to main (hand lander, reverts, coordinator commits) passes the same check; behind a setting, default off until the product lander carries every landing | Approved now (setting off) | V36 |
| ET3 | Stage, prove, then move main by compare-and-set; restage if main moved | Approved now | V35 |
| ET2 seals, ET4 batch bisect, ET6 Steady and Strict, ET7 push partitions | Full cell-seal proofs | Deferred until a full census runs in 5-10 minutes | none yet |

Why narrowed:
- A full Steady proof per landing reruns 70-94% of the suite (295-394 test-minutes), against about 1.4 minutes for the hand lander of 16 November.
- The fleet runs about 3 full proofs an hour; the repo lands 33-68 items an hour.
- The static stage on the exact tree costs about a minute and catches the combination reds of 16 November outright.

The build answers the open questions this way:
- Restage limit: 3 tries, then the item yields its turn.
- Trunk check: inside the store's compare-and-set, not a git hook.
- Flakes on a whole-tree proof: a red file reruns once against main's own receipt for that file before the landing is refused.
