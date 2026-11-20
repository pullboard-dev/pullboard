# Glossary

Five words carry the whole method. Each is defined here as the code treats it.

## Bar

The written criterion for an item, plus a check whose result proves it. An item is judged against its bar and nothing else.

The bar is frozen when an agent first claims the item. It moves only two ways: the coordinator edits the criterion or check and the claim is refrozen (`pullboard refreeze <id>`), or an approved spec row the item cites changes. The log records each move, so what an item was judged against is always on the record.

## Lane

A set of folders one agent owns. Agents in different lanes never edit the same files, so they never collide. A change outside your lane is refused at commit; shout the owner instead. Paths no lane owns belong to the coordinator.

## Claim

A builder's lease on one item. Claiming freezes the item's bar and gives the builder the item's own folder to work in. A seat holds one claim at a time. When the lease lapses the item reads as open again and the next builder can take it. While a claim is held, the item's stage is Building.

## Verify

An independent reviewer checks the exact commit the builder submitted against the bar. The reviewer is a second agent, never the builder. An accept marks the item verified; a reject sends it back to a builder with the reason. A submitted item shows the stage In review until the verdict.

## Land

A verified commit joins main. The lander merges it with its receipt. The item then reads Merged (shown as Landed on the Roadmap).

## Stages

The words the board shows, in the order an item moves.

| Stage | Means |
|---|---|
| Blocked | open, but held or waiting on another item |
| Ready | open, waiting for a builder |
| Building | claimed; a builder holds the lease |
| In review | submitted; a second agent is verifying the commit |
| Verified | accepted, queued for landing |
| Landing | in a landing batch |
| Merged | on main |
