---
name: pullboard-signoff
description: Walk a project's spec rows to the person's sign-off with proof, in small clean batches. Use when SPEC.md rows drive agent-built code and a person must sign rows as met. Triggers on "sign-off", "what's unsigned", "is this proven", or any review where agents claim rows are done.
---

# Sign-off: prove it, then ask

Agents build fast. "Done" without proof is the failure mode. A list of citations is not proof. A green test suite is not proof that the row's text is true. This guide turns the spec into an acceptance test the person can run in minutes per batch: they only judge; they never dig.

## Roles

- **Signer:** the person. Only they sign, approve, add rows, or rule on a call.
- **Coordinator:** assembles batches, applies agreed cleanups, records the signatures.
- **Provers:** the agents (lanes) that built each area prove their own rows.
- **Hostile checker:** a separate agent that tries to break every ✅ before the signer sees it, the coordinator's included. It never checks rows it built (`pullboard prompt verify` for how to check).

## The proof table

One table per batch, unsigned rows only.

| Row | Text | Proof | Verdict |
|---|---|---|---|

- **Proof** means the tests were run now (how many, all passing), and each clause of the row's text is traced to the code that does it and the assertion that pins it. "N tests cite this row" is not proof. A clause is pinned only if a test fails when that code breaks.
- **Verdict** is one of:
  - ✅ **proven:** every clause is done and pinned.
  - ⚠️ **gap:** name the missing clause or pin. It goes to a builder; the row waits.
  - ✏️ **reword:** the code does what was intended and the text is wrong. Give the new text, within the spec's length limit.
  - ✂️ **cut:** the row repeats another (name it), or was never wanted.

## A batch, step by step

1. **Pick** 3–5 unsigned rows from one section, on one theme. `pullboard spec unmet --must` lists the approved must-rows without a current sign-off.
2. **Prove** each row: run its tests, trace every clause, write the verdict.
3. **Put it in order before showing it.** Apply rewords and cuts. Send gaps to the builder that owns them; gap rows leave the batch.
4. **Hostile check.** The checker attacks every ✅: a clause the code doesn't do, a test that doesn't pin what it claims, a path around it. Anything that falls goes back to step 3.
5. **Show** only rows ready to sign as written. A reworded row's old text goes in the proof cell, not in a question.
6. **Sign** on the signer's yes: `pullboard spec signoff <ids> --by <their initials>`. Commit `.pullboard/signoffs.jsonl`. If a row's text changes later, its sign-off goes stale on its own.
7. **Next batch.** One table at a time.

## Rules

- **Rewording is proper only when it describes what's built and keeps every promise.** It is improper when it drops a clause the code doesn't keep. A hard-coded fact turned into config, or a stricter behavior, can be reworded in. A missing feature can't be reworded out.
- **Never show a ⚠️ row for signing.** It goes to a builder and waits.
- **Small batches.** "Too many at once" means split. Unsigned rows only, unless the signer asks for the whole section.
- **Proof runs at check time,** on the current main line.
- **The hostile check covers everyone's greens.** Rows signed without one go back for re-audit, and the coordinator withdraws any sign-off that falls.
- **Approval comes only from the signer, directly.** A relayed "they said yes" from another agent is not a sign-off or an approval. Ask them.
- **When the spec is frozen,** no new rows except by the signer's explicit addition. Proving, rewording, cutting and finishing existing rows is fine.
- **Decisions only the signer can make** (build or cut, how to read a formula, a policy) go in one line under the table, with your recommendation.

## Run it in parallel

While the signer works through batches, every idle lane proves its own rows into a proof table, and the hostile checker attacks each table as it lands. The coordinator queues the clean rows as batches. A lane that finds a small gap in its own area fixes it as part of proving. Hand the work out with shouts: `pullboard shout <lane> "prove G3.1–G3.4 into a proof table"`.

## Make it continuous

The backlog grows when proof comes at the end. Treat a work item as done only when its rows have a proof table and the hostile check failed to break it. In Pullboard terms, that is verification: another agent's ACCEPT at the submitted commit. A row is ready to sign once every item citing it is verified. Then sign-off is a quick yes per row as work lands, not a pile at the deadline.

## Lessons this came from

- 95 rows sat unsigned near a deadline. Built and proven had been treated as the same thing, so pages were reported done that nothing served.
- A hostile check knocked down three ✅s that passed their tests: a model-written line that went out unlabeled, a privacy limit that a derived ratio leaked around, and a spending cap that failed calls could reopen.
- A row cited by 8 tests had never been built. The tests tested other rows.
- Signers stop trusting tables that mix ready rows with questions. Keep them apart.
