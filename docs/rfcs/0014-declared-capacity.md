# RFC 0014: Declared capacity

- Status: proposed, 21 November 2026. By Corey Olson.
- Builds on RFC 0003 and RFC 0008, with DJ ids as proposed there. P7 is `[draft, must]`.
- Pools use Q1 resources. Amends DJ1 to add `census`.
- Ids in brackets (DC1…) become spec rows with new ids on approval.

## Summary

The person states capacity once, and the board keeps it true.

1. **State:** agent caps and pool policy in `pullboard.json`; machine facts in registration.
2. **Plan:** the board validates the policy against real slots and shows the change.
3. **Apply:** a person move on that exact plan.

Why:
- No one has to remember how many builders to run.
- One ledger per machine stops a slot being allocated twice.
- Board math suggests the count. The person can override it.

## Motivation

- A person can end up restating the same agent target.
- One missing timing sample can hide the board's estimate of useful agents.
- Long jobs can wait behind other work while registered capacity sits idle.

This RFC makes capacity one reviewed description.

## Design

### Where capacity lives [DC1]
- Agent caps and pool policy live in `pullboard.json`.
- Host addresses and slot counts stay in machine or runner registration (O6).
- Pools refer to registered runner names and labels only.
- Numbers below are illustrative.

```json
{
  "agents": { "mode": "auto", "cap": { "light": 4, "mid": 6, "strong": 2 } },
  "pools": {
    "census":  { "runners": ["runner-a"], "slots": 4, "kinds": ["census"], "lend": "when-idle" },
    "default": { "runners": { "label": "general" }, "slots": "rest", "kinds": ["*"] }
  }
}
```

- Routes are light, mid and strong (B13).
- Review is not a route. If it needs a cap, that is a separate seat limit.

### Agents [DC2]
- `auto`: per route, the smaller of the cap and the board's recommendation.
- `fixed`: exactly the person's number. It always wins.
- `pullboard fleet run` starts the shortfall from live seats.
- It never stops an agent mid-item.

### Board math always answers [DC3]
- Missing timing samples fall back to the smaller of width and ready supply.
- That answer is labelled "from ready work only".
- It never exceeds the measured peak when one exists.
- Never "unknown" while ready work exists.

### Pools [DC4]
- A pool is repo-scoped policy, held on the board that owns its runners.
- It names runners (registered names or a label), slots, job kinds and lending.
- Slots per runner: `n`, `all` or `rest`. Lending: `never` or `when-idle`.

**One slot ledger**
- One ledger per machine identity is the only authority for slots (Q1, Q4).
- Every runner registration on that machine refers to it.
- A pool is a claim against it and creates no capacity.

**Allocation**, per runner, in order:
1. Fixed `n` claims, by pool name.
2. `all`, only when it is that runner's only pool.
3. `rest`, at most one per runner, takes what remains.

Plan refuses claims that exceed the ledger or overlap ambiguously.

**Across repos**
- Claims on a shared runner are validated together against its ledger.
- Shares for contended slots are set in the machine's registration.
- Without shares, the plan reports the conflict and does not apply.

**Borrowing**
- A slot takes its pool's kinds first.
- Only a `when-idle` pool lends, and only a slot idle at admission.
- Job-kind reserved shares do not lend.
- Borrowed work holds its machine slot until release and counts on the ledger.
- Borrowed work is never killed.
- Within a pool, agent test runs still go ahead of queued gate shards, as shipped.
- Job kinds keep their reserved shares.

### Plan and apply [DC5]
- `pullboard capacity plan` prints the change against live state.
- It prints the policy, registration and ledger revisions it read.
- `pullboard capacity apply` is a person move (P6). It applies only that plan.
- If any input changed, it returns a new plan.
- Apply checks revisions and reserves across affected ledgers in one compare-and-set.
- Two plans read from the same free slots cannot both apply.
- A stale or failed apply leaves each ledger on its old or reserved allocations.
- Draining stops new admissions to removed slots.
- Running work finishes. Nothing is killed.

### Checks on runners [DC6]
- With no registered runner, the machine remains its own runner, as shipped.
- With runners, expensive builder checks may run on an immutable committed tree.
- Or on a complete eligible snapshot, which depends on RFC 0013 CK7.
- Results bind to that exact input.
- With no complete eligible snapshot, the board says so.
- It never gates incomplete work silently.
- Hooks stay local and light.
- Local must-run checks stay local, including the pre-commit secret scan (S1).
- Only heavy checks may move to the gate.

### Status [DC7]
- Status prints each pool and route: target, live, busy, queued.
- An override shows beside the math: "mid 6 of 6 (fixed by person; board math says 4)".

## Open questions
- Host load as a pool limit, or a separate guard.
- How apply commits atomically across ledgers on different machines.
