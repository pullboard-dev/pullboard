# Why landing plateaus as builder seats are added

**Status: this is a draft awaiting the person's approval. It is not published and nothing links to it.**

## The question

Add builder seats to a board and landings per hour rise, then stop rising. This study asks where they stop, how many seats it takes to get there, and why splitting the code into cells raises the ceiling.

## How the numbers are made

Every number below comes from one read-only command over the board's event table. It counts `merged` events per hour as landings and counts the distinct non-system seats that acted in the hour as active seats. An hour is on the plateau when it lands at least nine tenths of the best hour. The command prints the line that reproduces it, so a reader can rerun it against any board and window.

## The series on the fixture board

The block below is the command's output on the fixture board used by its test. The fixture is small and made up to exercise the command; it is not a measurement of a real fleet.

```
max-agents series 2026-11-01T00:00:00.000Z to 2026-11-01T04:00:00.000Z
2026-11-01T00:00:00.000Z  landings 1  active seats 1
2026-11-01T01:00:00.000Z  landings 4  active seats 3
2026-11-01T02:00:00.000Z  landings 4  active seats 5
2026-11-01T03:00:00.000Z  landings 1  active seats 0
plateau 4 landings per hour, reached with 3 active seats, 2 hours at the plateau
reproduce: pullboard stats max-agents --since 2026-11-01T00:00:00.000Z --until 2026-11-01T04:00:00.000Z
```

## Reading it

Landings climb with seats until the plateau hour, then extra seats add nothing: the last busy hour had more active seats than the plateau hour and landed the same. The plateau is reached with the fewest seats among the hours on it, which is the seat count past which more builders did not help.

## Where the time goes at the plateau

To be filled from the same command family on the real board, once the person approves the method: time in gate slots, merge conflicts, review and reworks. No figure is claimed here.

## Why cells raise the ceiling

A cell keeps the proof for a change small and keeps changes from overlapping files. Less proof per change shortens each gate run, and fewer overlapping files means fewer merge conflicts, so the same gate slots land more work. The real-board series, run before and after the cells, is what will show whether the plateau moved.

## Before publishing

The person reviews this draft, then the real-board series replaces the fixture block. Until then it stays out of the README and every index.
