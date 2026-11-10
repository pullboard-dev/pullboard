---
name: pullboard-decompose
description: Turn a client's ask into SPEC.md rows together with the person, one question at a time. Use when a project starts, when a brief or new requirements arrive, or when the person says "break this down" or "spec this out".
---

# Decompose an ask into the spec

You turn what the client asked for into SPEC.md rows. You draft; the person decides.

## Before you start

- Read every document in `ask/`, or the brief the person points to.
- Read SPEC.md and DOCTRINE.md (PRACTICE.md in legacy repos) if they exist.
- Run `pullboard spec check`, so you start clean.
- States or transitions involved? Run `pullboard lifecycle` first.
- Checklist: `pullboard prompt decompose`.

## The row

```
- G1.2 [draft, must] Same file twice is a no-op. | gate: idempotency test | serves: G1
```

- **id:** a track letter and a number. Permanent once committed: never deleted, renumbered or reused.
- **status:**
  - `draft`: yours.
  - `approved`: only on the person's word.
  - `pending`: an open question, written as the question, with no gate.
  - `wont`: the person cut it. It stays; nothing builds it.
  - `retired`: no longer applies.
- **tier:** `must` if the client needs it, `aim` if it's nice to have.
- **text:** one requirement, under 20 words.
- **gate:** the test or check that proves it.

## Steps

1. **Tracks:** group the ask: goals, the main things the product handles, money, people and roles, constraints, outside dependencies. One `##` section per track.
2. **Draft** row by row. Each traces to something the client said. Nothing the client didn't ask for is ever approved.
3. **Open points:**
   - A sensible default, and a wrong guess is cheap: a draft row stating the assumption, e.g. "Reminders go by text; email can come later." The person can flip it.
   - It changes scope, money, safety or a must-row: a pending row, written as a question.
4. **Questions:** ask only what blocks a must-row.
   - **At most five.** Keep the five with the most at stake (money, data loss, safety, what the client sees). The rest become draft rows stating your assumption.
   - **Only what the client sees.** If either answer would suit them, decide and state it in a draft row. Internal storage and numbering are yours.
   - **Aim features:** one question at most: in scope now?
   - **An example in the ask** (a date, a command) answers its format question.
5. **Look for what clients leave out:**
   - two statements that can't both be true;
   - a number the system needs that nobody gave;
   - a need nobody mentioned: refunds, privacy, running out;
   - an outside party nobody chose: payments, an existing system;
   - a nice-to-have written as a must, or the reverse;
   - bad input: an unknown id, a malformed value;
   - whether ids or numbers are ever reused;
   - what an empty list or a first run shows;
   - dates and times: compared to what, in whose time zone.
6. **Exact words:** quote the client when you restate a constraint; a paraphrase can change it.
   Every must-row is testable without a guess: name the exact word, format, number or comparison. Not "overdue tasks are flagged" but "a task due before today's local date shows the word overdue". The client didn't say? Write your assumption into the draft row.
7. **Show the person** one track at a time. Ask pending questions one at a time, most consequential first, each with your recommended answer.
8. **After each answer,** update the row and keep its id: pending becomes approved with the answer as its text, or draft becomes approved. A must-row gets its gate now. Run `pullboard spec check`.

## Never

- Never mark a row approved without the person saying so.
- Never delete or renumber a row, even to tidy. The commit refuses a deleted row.
- Cut: mark it `wont`. Stopped applying: mark it `retired`.

## Done

- Every part of the ask has a row, or a stated reason it's out of scope.
- Every approved must-row names its gate.
- For every must-row you could write the exact check: command, input, expected output.
- Each gate can become an item's criterion: at most 3 numbered clauses, one checkable requirement each.
- Only unanswered questions stay pending.
- `pullboard spec check` passes. Commit with a `docs(spec): ...` message; docs commits need no row ids.
- To read the spec: `pullboard spec view`. One row and its history: `pullboard spec show <id>`.
