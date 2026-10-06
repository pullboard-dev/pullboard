---
name: pullboard-spec-review
description: Review the spec, and the product built from it, against the client's ask, the way the client or an evaluator will see them. Use before a handoff, demo or submission, or when the person asks "what will they think of this".
---

# Spec review

Verification checks the work against the spec. This checks the spec, and what was built from it, against the client. Read as the client will, not as the builder did.

## Read

- The ask (`ask/`, or the brief), SPEC.md, PRACTICE.md and the README.
- The product itself: run it, open it, use it as the client would.

## Look for

- Asks with no row, and rows nobody asked for.
- Rows deleted or renumbered. Every id ever committed must still be there (`pullboard spec check` lists any that are gone); a cut row is marked `wont`, never removed.
- Rows met to the letter that miss what the client meant.
- A number the client cares about shown blank or zero because an input is missing. Demonstrate the mechanism with a labelled assumption instead.
- Test or demo data that borrows real names from the client's world.
- Text meant for people that shows ids, field names, raw values or jargon.
- Alerts with nothing at stake, and rankings that disagree with each other.
- Docs that describe code that does not exist, and a README that no longer matches the product.
- Anything that addresses the evaluator instead of the work.

## Report

Rank the findings by what the client would notice first. For each: what it is, where it is (a file and line, or a screen), why it matters to the client, and the fix. Put decisions that belong to the person at the top. Write the report to a file the person can hand to the build's coordinator.
