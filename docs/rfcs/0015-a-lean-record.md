# RFC 0015: A lean record

- Status: proposed, 21 November 2026. By Corey Olson.
- Builds on RFC 0007, RFC 0008 and RFC 0011. Applies DJ4.
- DJ ids are as proposed in 0008. P7 is `[draft, must]`.
- Ids in brackets (LR1…) become spec rows with new ids on approval.

## Summary

The board holds facts and hashes, and large finished bodies can live in files.

1. **Hash:** a proof plan is stored once, named by its hash.
2. **Archive:** a terminal, fenced job's bodies are copied to verified files.
3. **Keep:** every row, hash and outcome stays. The chain and replay do not change.

Why:
- A payload names inputs by id (DJ4).
- An archive reference never changes a job's current step.
- A body can still be re-checked against its hash.

## Motivation

- A long-running board accumulates job payloads and result bodies.
- Reads that load bodies they do not need can slow every seat.
- Unbounded growth can fill a host disk.

This RFC claims no read or disk improvement until a migration is measured.

## Design

### Payload classes [LR1]
In priority order:

1. **`record` payloads** are canonical. They stay inline at any size and are never archived.
2. **Proof plans** go once in the existing job blob store, by hash, at any size.
3. **Other step payloads** follow the store's existing size threshold.

An offer names a proof plan by its hash.

### Small payloads [LR2]
- A step payload is small JSON that names inputs by id (DJ4).
- A non-`record` body over the limit goes to the blob store automatically.
- So a finished result is never lost at write (DJ5).
- Refuse only a caller that embeds a body in a named-input field.

### Archive finished jobs [LR3]
- Eligible only when the job itself is at a terminal step and fenced.
- Fenced: no live lease, no driver, no result still to collect (DJ10, DJ32).
- An item landing or being withdrawn does not establish this.

Order of work:
1. Write the body to a durable archive object, with a stable id from its digest.
2. Read it back and verify the digest.
3. Publish the reference idempotently.

Then:
- The reference is a side index keyed by job, step name, step seq and digest.
- It is not a job step, so current step (DJ2) and duplicate-step replay (DJ3) hold.
- Receipt key, verdict, section outcomes, signature and result ids stay on the board (SC1, SC21).
- A body stays in its durable original store until custody and late results are settled.
- A failed archive write changes nothing.
- Archiving alone reclaims no inline storage.

### Physical reclaim [LR3a]
- Removing inline bytes is a separate migration that needs its own approval.
- It must preserve canonical signed facts and pass LR7.
- Each reclaimed body has defined canonical bytes and an archive lookup.
- Duplicate-step replay, signed verification and the second checker use them.
- A digest authenticates retrieved bytes. It does not replace a signature's preimage.

### Re-check [LR4]
- `pullboard show <id> --receipt` fetches an archived body and checks its hash.
- **Archive unavailable:** reads as infra, never pass.
- **Digest mismatch:** reports an integrity failure.
- Neither rewrites the original receipt or verdict. A re-check is a new record.

### Where archives live [LR5]
- A configured archive location, rolled with the board's backups.
- Retention is scoped per board.
- A hosted operator may use per-account object storage behind the same interface (DJ36).

### Hot reads stay small [LR6]
- Reads in claim, next, verify and the sweeper touch rows, never bodies.
- No hot path loads a whole table under the write lock.

### Proof before moving [LR7]
Before any body moves, tests show, after copy and again after reclaim:
- The chain verifies from rows and hashes.
- A checker that needs signed bodies retrieves and verifies them, and agrees.
- Archive loss and digest mismatch report as separate outcomes.
- Crash, restart and replay at each archive step leave one reference.
- They leave job state unchanged, across both the board and runs files (B2).
- Terminal state and duplicate-step replay are identical before and after.

## Limits
- Re-checking an old receipt needs its archive reachable.
- A reclaim migration must run without stopping the board.

## Open questions
- Archive format: one file per job, or packed per day.
- How long bodies stay on the host before only the archive holds them.
- Which tables and files hold today's bodies. B2 gives runner work a separate runs file.
