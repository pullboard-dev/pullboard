# RFC 0010: Releases: Cut. Clear. Ship.

- Status: proposed, 12 November 2026. By Corey Olson.
- Builds on RFC 0001 and RFC 0008.
- Ids in brackets (CS1…) become spec rows with new ids on approval.

## Summary

A release ends in three moves:
1. **Cut:** the person closes the scope.
2. **Clear:** agents make every Clear check pass on one commit.
3. **Ship:** the person publishes that commit.

Why it ends:
- New work goes to the next release by default.
- After the cut, the work is a fixed set of checks.
- No landing may add a red, so the countdown only falls.

## Motivation

This repository, 5–12 November 2026:
- 3,336 items filed; 2,446 landed.
- Open items in the release, at each day's end: 354, 249, 233, 152, 366, 302, 324, 334.
- The release goal, "restructure for speed and cost", had no last item.
- About 4,600 automatic placements put new items into the current release.
- One failing test was filed once per failing commit: about 870 "main red" items.
- 615 filings (18%) closed without landing: stale, already fixed, or duplicates.

An item has a frozen bar. A release has none. This RFC gives the release one.

## Design

### Release bar [CS1]
- A release's scope is clauses the person approves.
- Each clause has a check or a person sign-off.
- Improvements enter only as thresholds ("gate under 2 minutes").

### Placement [CS2]
- A new item joins the current release only if it names a failing scope clause or Clear check.
- Otherwise it joins the next release.
- Lane and spec-row rules place into the next release.

### One item per cause [CS3]
- A detector files one open item per cause.
- A repeat attaches to that item as evidence.
- A new ratchet files one item listing what's left.

### Cut [CS4]
A person move:

    pullboard release cut

1. Freezes the scope and Clear set.
2. Moves unfinished items to the next release, except Clear fixes.
3. Prints what moved and which checks are still red.

After the cut, only a recorded person decision changes the scope or Clear set.

### Clear [CS5]
Clear: every check passes on one commit, confirmed by a fresh re-run.

A check:
- is pass or fail;
- is run by the board, or signed off by the person;
- is frozen at the cut.

At a glance:

| Layer | What | Change |
|---|---|---|
| Always | Pullboard's promises | fixed |
| Standard | the default release bar | on by default; off is recorded |
| Yours | the project's own checks | added before the cut |

**Always** (fixed):
- no secret lands
- nothing ships unproven
- independent review
- no data loss

**Standard** (on by default; turning one off is recorded):
- suite green
- flakes quarantined with proof
- smoke command runs
- upgrade works
- scope proven
- nothing half-done

**Yours** (added before the cut):
- what the project adds: speed thresholds, a browser pass, a sign-off

### No new reds while clearing [CS6]
- From cut to ship, a landing runs the whole suite on the merged tree.
- It may not add a failure main didn't have.
- Other work keeps landing on the same main, under the same rule.

### Countdown [CS7]

    pullboard release

Prints `0.9.4 clearing: 3 checks red`, with the items on each check.

### Ship [CS8]
1. When every check is green on one commit, the board proposes it.
2. The person publishes it:

       pullboard release publish

3. Publish refuses any other commit, then tags the release.

### Teams on main [CS9]
A goal uses the same bar, placement, one item per cause and countdown.

## Open questions
- Command names.
- The smoke command: a new config key, or `gate`.
- How a Yours sign-off is recorded: spec row, decision, or both.
