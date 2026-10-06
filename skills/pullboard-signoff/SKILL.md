---
name: pullboard-signoff
description: Walk the person through approved spec rows so they can sign off what is met, one batch at a time. Use when the person asks to sign off, to review what is done, or to prepare a handoff or demo, or before telling anyone the build matches the spec.
---

# Sign-off walkthrough

Only a person signs. You show the evidence, row by row, and record their word. A sign-off keeps the row text the person read; if the row changes later, the sign-off goes stale on its own.

## Prepare

1. Run `pullboard spec unmet --must` to list the approved must-rows without a current sign-off.
2. For each row, find:
   - **Where to see it:** a command, a URL, a screen.
   - **The proof:** its gate, and the test that cites its id.
   - **Your read:** met, partly met, or not built.
3. Group the rows into batches of five to ten, by section.

## Walk

For each batch, show one table: id · what it says · where to see it · the proof · your read.

- Say "not built" plainly. Never present a partial as met.
- Offer to run the proof in front of the person.
- Ask which rows they sign, and record only those: `pullboard spec signoff <ids> --by <their initials>`.
- If they disagree with what a row says, that is a spec change, not a sign-off. Draft the new text; once they approve it, the row is ready to be signed again.

## Done

- Every approved must-row is signed, or has a stated reason it is not yet met.
- `.pullboard/signoffs.jsonl` is committed with a `docs(spec): sign-off ...` message.
