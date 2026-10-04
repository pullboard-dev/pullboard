# AGENTS.md

This repo is pullboard itself. Humans start at `README.md`; the spec is `SPEC.md`.

## Code

- Plain JavaScript, ES modules, Node 22.13 or newer. No dependencies and no build step: every import is a `node:` built-in or a file in this repo (`test/package.test.js` checks).
- Every function gets a JSDoc block: what it does, then why when the why is not obvious.
- A refusal is a `Refused(code, message)`: the code names the rule, the message says the next step.
- Tests use `node:test` against real git repos and a real SQLite file. Each test name cites the spec ids it proves.
- `npm run gate` is the spec check plus the tests. Pre-push runs it.

<!-- pullboard:start -->
## Working here: pullboard

This repo runs on pullboard: a work board, lanes and a spec that live in git. Nothing ships until a second agent verifies it.

**Source of truth.** `SPEC.md` holds every requirement as a row with an id, like `G1.2`. Code follows the spec. Commits cite the ids they serve: `feat(scope): subject [G1.2]`. Only a person approves or changes an approved row.

**Who you are.** An agent is its worktree. The main checkout is the coordinator. Every other agent works in its own worktree and joins one lane:

    git worktree add ../<repo>-<lane> -b <lane>/<slug>
    cd ../<repo>-<lane> && pullboard join <lane>

**The loop.**
1. `pullboard inbox`, then `pullboard list <lane>`.
2. `pullboard claim <id>`. A claim is a 2-hour lease; claim again to renew. The criterion freezes now: `pullboard show <id>` is the bar your work is judged against.
3. Build inside your lane's folders (`pullboard lanes`). Pre-commit refuses anything else; shout the owner instead.
4. Commit, then `pullboard submit <id>`. It needs a clean tree and the gate green at HEAD.
5. A different agent verifies: it checks out the submitted commit and runs `pullboard verify <id> accept`, or `pullboard verify <id> reject --reason TEST_FAILURE --note "what failed"`.
6. A reject reopens the item. Fix it, commit, claim, submit again; the same head is refused.

**Talk.** `pullboard shout <lane|agent|all> "<text>"`. Read `pullboard inbox` before you start and after you submit.

**Never.** Bypass a hook with `--no-verify`. Edit the board's database. Verify your own work. Change an approved spec row without the person's OK.
<!-- pullboard:end -->
