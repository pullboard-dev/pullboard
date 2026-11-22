# RFC 0013: The clock

- Status: proposed, 21 November 2026. By Corey Olson.
- Builds on RFC 0008, with DJ ids as proposed there. P7 is `[draft, must]`.
- Amends DJ1 to add `sweeper`.
- Applies once accepted. Until then, early pieces follow PB2 and PB8.
- Ids in brackets (CK1…) become spec rows with new ids on approval.

## Summary

Every unfinished item has an owner, a deadline and a safe default.

1. **Own:** each unfinished case names one owner.
2. **Due:** each has a deadline or a named wait.
3. **Move:** at the deadline, one sweeper applies the default.

Why:
- A case with an exit cannot stall unseen.
- A default keeps evidence and never makes a person's decision.

## Motivation

- Items can stop behind a stuck dependency, a hold or an unsettled gate.
- Work can exist only in a folder or process that dies.
- Uncleaned folders fill disks. Careless cleanup destroys the only copy.

This RFC names an exit for each case, so no item gets stuck unseen.

## Design

### The table [CK1]
- Owner, deadline and default extend the M1 declaration.
- States: open, claimed, submitted, verified, withdrawn.
- Anything else is a named hold (M4).
- **Finished** means withdrawn, or verified with its landing recorded.

### Defaults [CK2]
Deadlines come from board data unless named. Unfinished rows re-arm.

| Case | Owner | Default |
|---|---|---|
| Ready | board | stay offered, shown unclaimed |
| Waiting | blocker's owner | none |
| Claimed, no job | builder | release |
| Job live | job | keep, reclaim lease |
| Gate unsettled | board | settle from results |
| Gate infra failure | board | requeue, keep claim |
| Infra exhausted | infra queue | park (CK3) |
| Submitted | review lane | re-offer review |
| Verified, unlanded | lander | retry or park |
| Coordinator hold | coordinator | re-bar |
| Re-scope | re-bar queue | person's list |
| Waits on person | person | remind |

- **Release:** either timer: 40 minutes with no move or commit, or B4 expiry. Both stay until a dated amendment. Work stays saved (CK7, CK8).
- **Dependencies:** a withdrawn one stays satisfied (B8).
- **Jobs:** lapsed leases are reclaimed (DJ14). Requeues keep candidate and shards (DJ10).
- **Age** never forces a rebuild, verdict or decision.
- **Recheck** owner, head, digest, attempt, leases, B28 and deadline in the board move's transaction. Any change vetoes.
- **Several holds:** each keeps its deadline, any can veto, and a person's hold wins.

### Infrastructure exhaustion [CK3]
- Only a terminal `infra-exhausted` step counts. Age never does.
- Parking does not end custody. The claim ends once bound work settles and CK7 holds its work.
- Ending custody offers no build. A re-offer retries the captured candidate first; a rebuild needs that candidate unusable.
- Late results are collected (DJ32). One clears the park only once the current authoritative proof job accepts it under the exact inputs and attempt and shard rules.

### Unknown evidence [CK4]
- Unknown evidence waits one more deadline, then takes the default.
- A default never creates a verdict or spends an infrastructure attempt.
- A lapsed job lease authorizes a new driver. It never discards a result or frees the item.

### The sweeper [CK5]
- A `sweeper` job row with a lease, run by `drive`, each minute.
- Each board move is a new event naming its rule (R2). Job steps stay DJ2 rows.
- `status` prints the count of unfinished items with no owner, deadline or named wait.

### Ready [CK6]
- `next` offers only Ready items.
- Ready is a cached condition the sweeper sets. Any move acting on it reruns the CK2 guard.

### Snapshots [CK7]
- The board snapshots each claimed folder to `refs/pullboard/wip/<item>`, every minute and on board calls.
- Target: at most a minute since the last complete capture.
- **Release blocker:** each snapshot passes a secret scan before reaching shared objects or a ref.
- A hit or scanner failure marks the capture `blocked`.
- Ignored and blocked content never enters a ref.
- A re-offer starts from the last complete snapshot.
- Every seat that held the claim or contributed a snapshot is a recorded builder.
- Recorded builders cannot verify the item (V1).

### Cleanup [CK8]
A folder is automatically removed or cleared only when it is:
1. **Fenced:** custody ended, no live process, exclusive checkout lease, new writers refused.
2. **Inventoried:** tracked, staged, untracked and ignored files; in-progress operations; local commits; stashes; nested repos; symlinks and modes.
3. **Accounted for:** each entry is on a retained ref, captured and verified by read-back, or on a person-approved rebuildable list, empty by default.
4. **Rechecked:** a final inventory under the fence matches the capture.

Otherwise the folder stays, the clock leaves it alone, and the person gets one notice: item, reason class and counts, with no contents, matched values or paths.

Release requires a test that a writer appearing after capture cannot lose work.

## Limits
- Never a person's move: P6, PB1.
- Never releases a claim with a bound gate or proof run live: B28, DJ12-DJ14.
- Kept folders use disk until the person acts (PB2).

## Open questions
- Per-state deadlines from board data, with a person override.
- Delivery of the person's list: status, the view or a digest.
