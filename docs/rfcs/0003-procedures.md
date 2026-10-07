# RFC 0003: Procedures, resources and proposals

- Status: accepted, 7 October 2026. Step 1 is approved to build.
- Proposed: 7 October 2026, by Corey Olson
- Rows: Q1 to Q11, O5, O6

## Summary

Agents keep hitting the same kinds of coordination problems: two test gates at once starve the machine, two agents share one worktree's identity, merges land in the wrong order. Today the person or the coordinator spells out each fix, and the next agent has to be told again. This RFC gives Pullboard three blocks, so that a fix becomes a procedure the engine enforces, and so that agents can propose new procedures themselves:

- **Resources:** something shared, with a capacity and a queue.
- **Procedures:** state machines declared as data.
- **Proposals:** how a procedure is born or changed, decided up the chain of command.

Two of the pieces exist already. The item lifecycle is a state machine declared as data in `src/machine.js`, and its guards refuse a move with a code, what they saw and the next step. This RFC generalizes them.

## Resources

A resource has a name, a capacity, a scope (one machine, one repo, or one board) and a queue. Taking a resource that is full puts the taker in line, first come first served; the taker hears what it waits behind and starts when its turn comes. A holder holds the resource under a lease, so a holder that dies frees it when the lease lapses, and nothing waits forever. `pullboard resources` shows every resource, its holders and its line.

A machine-scoped resource lives in `~/.pullboard`, since every repo on the machine shares its CPU. A repo-scoped one lives in the repo's git directory. A board-scoped one needs the relay, since it spans machines.

The first three:

1. **The gate:** gate slots per machine, two by default, set in the machine's settings. A gate already passed on the exact tree takes no slot.
2. **A worktree:** one agent at a time, so two sessions can't share an identity.
3. **The merge:** one at a time per repo, in the order items were accepted.

## Procedures

A procedure is a state machine written as data: its states; its moves, each with a verb, the states it starts from and goes to, who may make it, the guards it must pass and the resources it takes or gives back; and what evidence a move must carry. Pullboard ships standard procedures, as it ships a standard doctrine, and a repo adds its own as files in `.pullboard/procedures/`.

```json
{
  "procedure": "gate", "version": 1,
  "resources": { "slot": { "per": "machine", "capacity": "settings.gateSlots" } },
  "states": ["queued", "running", "passed", "failed"],
  "moves": [
    { "verb": "start", "from": ["queued"], "to": "running", "takes": "slot" },
    { "verb": "finish", "from": ["running"], "to": ["passed", "failed"], "gives": "slot" }
  ]
}
```

`spec check` checks a procedure before anything runs it: every state is reachable, every move has an actor that can make it, every guard is one Pullboard knows, and resources are taken in one order, so no two moves can wait on each other. Guards come from a fixed list at first, never arbitrary code. The item lifecycle becomes the first procedure the engine runs from its declaration.

## Proposals

A proposal is itself a procedure:

1. **Raised** by any agent that hits friction: the problem, its evidence (timings, failures, receipts) and a draft procedure.
2. **Open** for other agents to add constraints and needs.
3. **Reviewed** by another agent, from a different lane and, where one is available, a different vendor. The review is a verdict on the evidence, not a vote: agents running one model would vote alike, so a count of agreements proves little.
4. **Decided** by the coordinator, which adopts it, sends it back, or passes it up with a recommendation.
5. **Landed** as an item that adds the procedure file and its spec rows, built and verified like any other. It takes effect when that item merges.

An adopted procedure starts as a draft, like a spec row, and the person approves it formally when they get to it. Until then it is raised to them with what it does, why, and the evidence behind it, among the rows waiting for their approval, and they can suspend any procedure at any time. A suspended procedure stops taking moves until the person resumes it.

A repo says when a draft procedure runs, with one option in `pullboard.json`:

- `"procedures": "draft"`, the default: it runs at once, while it waits for the person's approval, so the person never blocks it.
- `"procedures": "approved"`: it runs only once the person approves it.
- `"procedures": "off"`: agents can't define procedures, and only Pullboard's standard ones run.

That is safe because procedures only add structure. A procedure can queue, order and guard moves, and require evidence, but it can never drop a standard guard, skip verification or weaken a check. A bad procedure can slow work down, and it is then suspended, but it can't make work less safe. A change to the standard rules themselves stays a change to the doctrine, which goes up the chain to the person.

## Build order

1. **Resources:** the gate queue, then worktree occupancy, then the merge order (Q1 to Q4, O5, O6).
2. **Procedures as data:** the item lifecycle runs from its declaration, repos add their own, and `spec check` validates them (Q5, Q6, Q9).
3. **Proposals:** agents raise them, and they land through the chain without waiting on the person, unless the repo asks for that (Q7, Q8, Q10, Q11).

## Open questions

- Guards beyond the fixed list: whether a small expression language is worth its risk, once there are procedures that need it.
- Board-scoped resources wait for the relay, which is the only place one lock spans machines.
