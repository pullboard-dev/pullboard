---
name: pullboard-decompose
description: Turn a client's ask into SPEC.md rows together with the person, one question at a time. Use when a project starts, when a brief or new requirements arrive, or when the person says "break this down" or "spec this out".
---

# Decompose an ask into the spec

You turn what the client asked for into SPEC.md rows. You draft; the person decides.

## Before you start

- Read every document in `ask/`, or the brief the person points you to. Read SPEC.md and PRACTICE.md if they exist.
- Run `pullboard spec check`, so you start from a clean spec.

## The row format

One requirement per line:

```
- G1.2 [draft, must] Same file twice is a no-op. | gate: idempotency test | serves: G1
```

- **id:** a track letter and a number. Never reuse one, even after a row is retired.
- **status:** `approved` only on the person's word. Your rows are `draft`. An open question is `pending`, with its text phrased as the question; a pending row has no gate.
- **tier:** `must` or `aim`.
- **text:** one requirement, under 20 words.
- **gate:** the test or check that would prove it.

## How to work

1. Group the ask into tracks: the goals, the main things the product handles, money, people and roles, constraints, outside dependencies. One `##` section per track.
2. Draft rows track by track. Each row traces to something the client said. Nothing the client did not ask for is ever approved.
3. Sort what the ask leaves open:
   - **A sensible default exists and a wrong guess is cheap:** write a draft row that states the assumption, such as "Reminders go by text; email can come later." The person can flip it.
   - **It changes scope, money, safety or a must-row:** write a pending row phrased as a question.

   Ask only what blocks a must-row; a spec with forty questions is a spec nobody answers.
   - **Ask at most five questions.** If you have more, keep the five with the most at stake (money, data loss, safety, what the client will see) and turn the rest into draft rows that state your assumption.
   - **A question must change something the client sees.** If either answer would suit them, decide, and state it in a draft row. How the product stores or numbers things internally is yours to decide.
   - **Optional (aim) features get one question at most:** is it in scope now?
   - **If the ask shows an example,** such as a date or a command, the example answers the format question.
4. Look hard for what clients leave out:
   - two statements that cannot both be true
   - a number the system needs that nobody gave
   - a need nobody mentioned: refunds, privacy, what happens when something runs out
   - an outside party nobody chose: payments, an existing system
   - a nice-to-have phrased as a must, or the reverse
   - what happens on bad input: an unknown id, a malformed value
   - whether ids or numbers are ever reused
   - what an empty list or first run shows

   - dates and times: compared to what, and in whose time zone

   When you restate a constraint, quote the client's words; a paraphrase can change its meaning.

   Every must-row must be testable without a guess. Name the exact word, format, number or comparison it means: not "overdue tasks are flagged" but "a task due before today's local date shows the word overdue". If the client did not say, write your assumption into the draft row; the person will flip it if it is wrong.
5. Show the person one track at a time. Ask the pending questions one at a time, the most consequential first, each with your recommended answer.
6. After each answer, update the row and keep its id: pending becomes approved with the answer as its text, or draft becomes approved. Run `pullboard spec check`.
7. Never mark a row approved without the person saying so. Never delete a row; retire it.

## Done

- Every part of the ask is covered by a row, or by a stated reason it is out of scope.
- Every approved must-row names its gate.
- For every must-row you could write the exact check: the command, the input and the expected output.
- What remains pending is only the questions the person has not answered yet.
- `pullboard spec check` passes, and the spec is committed with a `docs(spec): ...` message. Docs commits need not cite row ids.
