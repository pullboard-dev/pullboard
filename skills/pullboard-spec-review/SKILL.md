---
name: pullboard-spec-review
description: Review the spec, and the product built from it, against the client's ask, the way the client or an evaluator will see them. Use before a handoff, demo or submission, or when the person asks "what will they think of this".
---

# Spec review

- Verification checks the work against the spec. This checks the spec, and what was built, against the client.
- Read as the client will, not as the builder did.

## Read

1. The checklist:
   - `pullboard prompt review`
2. The ask (`ask/`, or the brief).
3. SPEC.md, DOCTRINE.md (PRACTICE.md in legacy repos) and the README.
   - All rows: `pullboard spec view`
   - One row: `pullboard spec show <id>`
   - Rows still needing work: `pullboard spec unmet`
4. The product: run it, open it, use it as the client would.

## Look for

1. Asks with no row, and rows nobody asked for.
2. Rows deleted or renumbered. Every committed id stays; a cut row is `wont`, never removed.
   - `pullboard spec check` lists any that are gone.
3. Rows met to the letter that miss what the client meant.
4. A number the client cares about shown blank or zero for a missing input. Show the mechanism with a labeled assumption instead.
5. Test or demo data that borrows real names from the client's world.
6. People-facing text showing ids, field names, raw values or jargon.
7. Alerts with nothing at stake, and rankings that disagree.
8. Docs describing code that doesn't exist, or a README that no longer matches the product.
9. Anything that addresses the evaluator instead of the work.

## Report

1. **Person's decisions** at the top.
2. **Rank** findings by what the client would notice first.
3. **Each finding:** what it is, where (file and line, or a screen), why it matters to the client, the fix.
4. **Write it to a file** the person can hand to the build's coordinator.
