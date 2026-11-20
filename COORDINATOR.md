# COORDINATOR.md

For the coordinator only. Workers follow `AGENTS.md`.

## Coordinator loop

Fix the board, not the prompt.

1. `pullboard resume`: the work card and board health.
2. `pullboard inbox`: decisions, blockers and Stuck shouts; act within the hour.
3. **Watch** the pipeline: gates, verifies, accepts, landings.
4. **File:** `pullboard add` with a numbered bar, each clause tagged.
5. **Fix:** stuck or wrong items (see Fixing).
6. **Repeat.**

### Watching

- **Pipeline:** `pullboard stats pipeline`.
- **Gates:** `pullboard gate-health --since 2h`.
- **Verifies:** `pullboard queue`.
- **Landing:** `pullboard land --due --dry-run`; landed: `pullboard merged`.
- **Seats:** `pullboard seats`.
- **Shouts:** `pullboard watch --to coordinator`.
- **Health:** `pullboard health`.

### Filing

- **Clauses:** tagged `[test]`, `[command]` or `[measurement]`.
- **Wiring:** name the caller files, plus one real-path clause.
- **Never name:** runtime state or paths no lane owns.

### Fixing

- **Re-bar:** `pullboard edit <id>`, then lift any hold.
- **Pause:** `pullboard hold <id>`; lift with `--off`.
- **Stranded submit:** `pullboard reopen <id>`.
- **Stale policy:** `pullboard refreeze <id>`.
- **Done elsewhere:** `pullboard withdraw <id> <reason>`, so no one rebuilds it.
- **Stale claim:** release it before another worker starts.
- **Row decisions:** `pullboard spec apply` after the person rules.
- **New stall kind:** file a board-side fix.
- **Forced landing:** with the person's OK, when the gate is broken.
- **Forced means:** green at its exact candidate; never dodges a red.

### Closure ceilings

- **The adapter allowance:** an env or fs adapter-migration item may raise a row of `apps/cli/journeys/imports/closure-budget.json` by exactly that adapter's module count (env 2, fs 1), once per adapter per row, recorded as a fact on the item naming the row, the adapter and the count. No other raise is allowed.
- **Lander override:** the lander lands a change whose only closure-ceiling refusal is such a recorded raise, and names the item and its fact in the landing note. Any other closure-ceiling refusal stays refused.

### Outside PRs

- Land outside PRs through the merge train, never GitHub's merge button; GitHub marks the PR merged when their commit reaches main.
- Outsiders never get commit rights, npm publishing rights or any token.

### Tools

- **Order:** `pullboard roadmap`; `pullboard milestone pin` or `order`.
- **People's calls:** `pullboard decisions`.
- **Capacity:** `pullboard capacity`; runners: `pullboard runner list`.
- **Time:** `pullboard stats time` shows where items spend it.
- **Flakes:** `pullboard flakes quarantine`.
- **Sentinels:** `pullboard sentinels` lists the stall detectors.
- **Why:** `pullboard why <id>` and `pullboard trace` explain a move.
