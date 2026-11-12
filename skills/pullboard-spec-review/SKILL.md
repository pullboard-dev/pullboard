---
name: pullboard-spec-review
description: Review the spec, and the product built from it, against the client's ask, the way the client or an evaluator will see them. Use before a handoff, demo or submission, or when the person asks "what will they think of this".
---

# Spec review

- The spec is SPEC.md: what to build, one requirement per row.
- Only rows the person approved are canon.
- Verification checks the work against the spec.
- This checks the spec, and what was built, against the client.
- Read as the client will, not as the builder did.

## Read

1. The checklist:
   - `pullboard prompt review`
2. The ask: `ask/`, the brief, or any doc the client gave, design docs included.
   - These are the ask, never the spec.
3. SPEC.md, DOCTRINE.md (PRACTICE.md in legacy repos) and the README.
   - All rows: `pullboard spec view`
   - One row: `pullboard spec show <id>`
   - Rows still needing work: `pullboard spec unmet`
4. The product: run it, open it, use it as the client would.

## Look for

1. An ask with no row.
2. A row nobody asked for.
3. A row deleted or renumbered. Every committed id stays; a cut row is `wont`.
   - Fix: restore it, marked `wont` if it was cut.
   - `pullboard spec check` lists any that are gone.
4. A row met to the letter that misses what the client meant.
5. A number the client cares about, blank or zero for a missing input.
   - Fix: show the mechanism with a labeled assumption.
6. Test or demo data borrowing real names from the client's world.
7. People-facing text showing ids, field names, raw values or jargon.
8. An alert with nothing at stake.
9. Rankings that disagree with each other.
10. Docs describing code that doesn't exist.
11. A README that no longer matches the product.
12. Anything that addresses the evaluator instead of the work.

## Report

1. **Person's decisions** at the top.
2. **Rank** findings by what the client would notice first.
3. **Each finding:**
   - what it is;
   - where (file and line, or a screen);
   - why it matters to the client;
   - the fix.
4. **Write it to a file** the person can hand to the build's coordinator.
