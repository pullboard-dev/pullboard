---
name: pullboard-decompose
description: Turn a client's ask into SPEC.md rows together with the person, one question at a time. Use when a project starts, when a brief or new requirements arrive, or when the person says "break this down" or "spec this out".
---

# Decompose an ask into the spec

- You turn what the client asked for into SPEC.md rows.
- You draft; the person decides.

## Read first

1. The checklist:
   - `pullboard prompt decompose`
2. Every document in `ask/`, or the brief the person points to.
3. SPEC.md and DOCTRINE.md (PRACTICE.md in legacy repos), if they exist.
4. A clean start:
   - `pullboard spec check`
5. States or transitions involved:
   - `pullboard lifecycle`

## The row

```
- G1.2 [draft, must] Same file twice is a no-op. | gate: idempotency test | serves: G1
```

| Part | Means |
|---|---|
| id | track letter and number; permanent, never reused |
| tier | `must` if the client needs it, `aim` if nice to have |
| text | one requirement, under 20 words |
| gate | the test or check that proves it; required once a must-row is approved |
| serves | the row it supports, if any |

| Status | Means |
|---|---|
| `draft` | yours, proposed |
| `pending` | an open question |
| `approved` | the person said yes |
| `wont` | cut by the person |
| `retired` | no longer applies |

## Steps

1. **Tracks:** group the ask, one `##` section per track.
   - Goals, what the product handles, money, people and roles, constraints, outside dependencies.
2. **Draft** rows. Each traces to something the client said.
3. **Open points:**
   - A cheap guess: a draft row stating it ("Reminders go by text; email later").
   - Scope, money, safety or a must-row at stake: a pending row, written as the question.
   - Two statements that can't both be true: a pending row quoting both.
4. **Look for what clients leave out.** See Gaps.
5. **Make every must-row testable:** the exact word, format, number or comparison.
   - Not "overdue tasks are flagged".
   - "A task due before today's local date shows the word overdue."
6. **Show the person** one track at a time.
   - Pending questions one at a time, most at stake first, each with your recommended answer.
7. **After each answer,** keep the id and update the row:
   - pending becomes approved, the answer as its text;
   - draft becomes approved;
   - a must-row gets its gate now.
   - `pullboard spec check`

## Questions

1. **Five at most:** the ones with the most at stake.
   - Money, data loss, safety, what the client sees.
2. **The rest** become draft rows stating your assumption.
3. **Only what the client sees.** Internal storage and numbering are yours.
   - Decide, and state it in a draft row.
4. **Aim features:** one question at most: in scope now?
5. **An example in the ask** (a date, a command) answers its own format question.

## Gaps

- Two statements that can't both be true.
- A number the system needs that nobody gave.
- A need nobody mentioned: refunds, privacy, running out.
- An outside party nobody chose: payments, an existing system.
- A nice-to-have written as a must, or the reverse.
- Bad input: an unknown id, a malformed value.
- Ids or numbers reused, or not.
- What an empty list or a first run shows.
- Dates and times: compared to what, in whose time zone.
- Quote the client when you restate a constraint. A paraphrase can change it.

## Never

- Mark a row approved without the person saying so.
- Delete or renumber a row, even to tidy. The commit refuses it.
  - Cut: mark it `wont`.
  - Stopped applying: mark it `retired`.
- Approve anything the client didn't ask for.

## Done

1. Every part of the ask has a row, or a reason it's out of scope.
2. Every approved must-row has a gate.
3. Each gate can become a bar: at most 3 numbered clauses, each checkable.
4. Only unanswered questions stay pending.
5. Check, then commit with a `docs(spec): ...` message (no row ids needed):
   - `pullboard spec check`
6. Read it back:
   - `pullboard spec view`
   - `pullboard spec show <id>`
7. Ask the person to approve the rows:
   - `pullboard view`
   - Agents can't approve: `pullboard spec approve` is refused.
