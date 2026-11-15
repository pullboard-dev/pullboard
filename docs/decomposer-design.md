# Design: the decomposer

Status: a proposal for the person. Nothing here is built.

A feature that spans several cells today arrives as one wide item, and wide items collide. The decomposer cuts a feature into a parent and a set of children that each touch one cell, so work runs in parallel and the contracts between cells are agreed before anyone builds on them.

## Inputs

- **The code map.** It says which cell owns each path and which cells import which.
- **Contracts.** The checked shape of each cell's exports, read from the contracts tool.
- **The feature.** The person's request, written as a bar.

## The cut

1. **Parent.** One item that holds the feature's bar and the person's wording. It lands last and builds no code of its own.
2. **Contract child first.** One child that states the contracts the feature needs between cells, as new or changed contract files. Every other child waits for it.
3. **One child per cell, in parallel.** Each child touches exactly one cell and builds against the contracts. No child edits another cell.
4. **Integration child last.** One child that waits for every cell child and proves the feature end to end through a journey test.

## Outputs

Board items: the parent, the contract child, one child per cell and the integration child. Each child carries a bar with one checkable clause and an `--after` link to the items it waits for.

## The person approves the cut

The decomposer only proposes. It prints the parent, the children, the order and the contracts. Nothing is filed until the person approves. The person may change the cut, and a changed cut is checked again against the code map.

## What stays out of scope

The decomposer is not built by this item. This page is the proposal; building it is a later item the person files after approval.
