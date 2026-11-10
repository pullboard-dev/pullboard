---
name: pullboard-signoff
description: Walk a project's spec rows to the person's sign-off with proof, in small clean batches. Use when SPEC.md rows drive agent-built code and a person must sign rows as met. Triggers on "sign-off", "what's unsigned", "is this proven", or any review where agents claim rows are done.
---

# Sign-off: prove it, then ask

- Only the person signs, approves, adds rows or rules on a call.
- A relayed yes (e.g., from another agent) is no approval. Ask them.
- Citations are no proof. A green suite is no proof the row's text is true.
- The person only judges, never digs. A batch takes minutes.
- Instructions for a batch:
  - `pullboard prompt signoff`

## Roles

- **Person:** signs rows.
- **Coordinator:** builds batches, applies cleanups, commits signatures.
- **Workers:** builders and verifiers. They prove the rows of what they built.

## Steps

1. **Pick** 3–5 unsigned rows, one section, one theme:
   - `pullboard spec unmet --must`
2. **Prove** each row. See Proof.
3. **Check:** another worker tries to break each proven row, never its own.
4. **Clean up:** gaps go back to their worker. Apply the person's rewords and cuts:
   - `pullboard spec apply`
5. **Show** one table: only rows that passed the check, ready to sign as written.
6. **Sign:** the person runs, with their principal from `pullboard spec signers`:
   - `pullboard spec signoff <ids> --by <principal> --note "<what they checked>"`
7. **Commit** `.pullboard/signoffs.jsonl`.

## Proof

| Row | Text | Proof | Verdict |
|---|---|---|---|

1. **Run** the row's tests now, on current main.
2. **Trace** each clause to its code and an assertion that fails when that code breaks.
3. **Give a verdict:**
   - **proven:** every clause done and pinned.
   - **gap:** name the missing clause. The row waits.
   - **reword:** the code is right; the text is wrong.
     - Old text goes in the proof cell.
   - **cut:** repeats another row (name it), or was never wanted.

## Rules

1. **Unsigned rows only,** unless the person asks for a whole section.
2. **Frozen spec:** new rows only from the person.
3. **Reword** to match what's built. Keep every promise.
   - Never reword a missing feature out.
4. **Never show a gap** for signing.
5. **Person-only calls** (build or cut, a formula, a policy) go under the table.
   - One line each, with your recommendation.
6. **Changed text** makes a sign-off stale. Prove the row again in a new batch.
7. **A sign-off that falls** later is withdrawn.

## In parallel

1. A row is ready for a batch once every item citing it is verified.
2. While the person reviews, idle workers prove their own rows:
   - `pullboard shout <lane> "prove G3.1–G3.4 into a proof table"`
3. Sign-off becomes a quick yes as work lands.

## Signers

1. Who may sign:
   - `pullboard spec signers`
2. Add a signer, with the exact verified principal:
   - `pullboard spec signers add`
