/**
 * What `pullboard init` writes into a repo: the config, a starter spec, and the agent instructions
 * every coding agent reads (AGENTS.md, which CLAUDE.md points at).
 */

export const AGENTS_START = '<!-- pullboard:start -->';
export const AGENTS_END = '<!-- pullboard:end -->';

/**
 * The starting pullboard.json: the gate and the fixers init detected, the spec, and no lanes yet.
 *
 * @param {string} gate
 * @param {{ run: string, files: string[] }[]} [fix]
 * @returns {string}
 */
export function configTemplate(gate, fix = []) {
  const config = {
    gate,
    ...(fix.length ? { fix } : {}),
    spec: 'SPEC.md',
    practice: 'PRACTICE.md',
    verify: 'any',
    lease: '2h',
    lanes: { review: { owns: [], starts: 'any time: verifiers check submitted work and own no folders' } },
    shared: [],
    commits: { requireIds: ['feat', 'fix'] },
  };
  return `${JSON.stringify(config, null, 2)}\n`;
}

/**
 * A starter SPEC.md with the row format shown by example.
 *
 * @param {string} project
 * @returns {string}
 */
export function specTemplate(project) {
  return `# ${project} spec

Every requirement is a row with an id. Agents build against approved rows; commits cite the ids they serve. \`pullboard spec check\` lints this file.

Statuses: approved = decided · draft = proposed · pending = open question · fact = true today · wont = won't build, decided and kept · retired = no longer applies, kept. Ids are permanent: never delete or renumber a row. Tiers: must · aim.

Write each requirement as one row under its section, in this format. The fence keeps the example out of the spec, so no placeholder id is ever committed; your own rows go below, outside it.

\`\`\`text
- G1 [draft, must] The first thing the client needs, in one line. | gate: the test that proves it
- K1 [draft, must] A constraint, e.g. runs locally with no account. | gate: review
\`\`\`

## G · Goals: what the client asked for

## K · Constraints
`;
}

/**
 * A starter PRACTICE.md: the house rules as rows, in the spec's own format. A standard to edit, not
 * a law: the project keeps, changes or retires each row, and approves what it keeps. A row whose gate
 * names a check is enforced by that check; a row gated by review guides agents and reviewers.
 *
 * @returns {string}
 */
export function practiceTemplate() {
  return `# Practice

How this project is built: the house rules, as rows. SPEC.md says what to build; this file says how. Edit it for your project: keep, change or retire each row, and approve what you keep. A row whose gate names a check fails the build when broken; a row gated by review guides agents and reviewers.

Statuses: approved = in force · draft = proposed · wont = considered and declined, id kept · retired = dropped, id kept. Ids are permanent: never delete or renumber a row. Tiers: must · aim.

## W · Writing
- W1 [approved, must] Numbers over adjectives. No hedges, no filler. | gate: review
- W2 [approved, must] Commit headers are type(scope): subject [ids], 72 characters at most. | gate: commit-msg hook
- W3 [draft, aim] Ban the filler words basically, simply, just, very, robust, seamless, leverage. | gate: commit-msg hook, commits.banned
- W4 [approved, must] Spec ids go in commits and code headers, never in words meant for people. | gate: review
- W5 [draft, aim] One record per decision, at most 100 words, citing rows and naming who decided. | gate: review

## C · Code
- C1 [draft, must] Files under 1,000 lines; functions under 60; complexity 10; nesting 3; parameters 3. | gate: linter
- C2 [draft, must] Every exported function has a doc comment saying why, not restating its name. | gate: linter
- C3 [draft, must] Comments explain why and sit above the code; no commented-out code in the main line. | gate: linter, review
- C4 [draft, must] Errors and logs never echo input values. | gate: review
- C5 [draft, aim] Plain over clever: early returns, named intermediate values, one idea per line. | gate: review
- C6 [draft, must] No inline ignore comments; exceptions live in config, each with its reason. | gate: linter
- C7 [approved, must] One implementation per concern: use another lane's module, never a copy of it. | gate: review

## T · Tests
- T1 [approved, must] Every feature and fix cites the spec rows it serves, and a test proves each one. | gate: commit-msg hook, review
- T2 [draft, must] A test fails when the code is wrong: break the code once and watch it go red. | gate: mutation testing on critical code
- T3 [draft, must] No test marked as expected to fail without an open item. | gate: review
- T4 [draft, aim] Tests use real dependencies where practical, not mocks of them. | gate: review
- T5 [approved, must] Tests and checks never write outside a temporary directory. | gate: review

## G · Git and the gate
- G1 [approved, must] The gate passes on a clean tree before every push. | gate: pre-push hook
- G2 [approved, must] Never bypass a hook. Never rewrite the main line, except to remove a secret. | gate: review
- G3 [approved, must] Work stays in its lane; changes elsewhere go through the lane's owner. | gate: pre-commit lane check
- G4 [approved, must] The builder never verifies its own work. | gate: pullboard verify

## D · Dependencies
- D1 [draft, must] A new dependency states its need, the built-in it replaces, and what it pulls in. | gate: review
- D2 [draft, aim] Install scripts only from native drivers. | gate: package manager allowlist

## S · Security and data
- S1 [approved, must] No secrets and no env files in git. | gate: pre-commit secret scan
- S2 [draft, must] Real customer data never enters the repo or an agent's context; test data is synthetic. | gate: review
- S3 [draft, must] Every entry point declares who may use it; anything undeclared is denied. | gate: review
`;
}

/**
 * The agent instructions, between markers so init can find its own block and never touch the rest.
 *
 * @returns {string}
 */
export function agentsBlock() {
  return `${AGENTS_START}
## Working here: pullboard

This repo runs on pullboard: a work board, lanes and a spec that live in git. Nothing ships until a second agent verifies it.

**Source of truth.** \`SPEC.md\` holds every requirement as a row with an id, like \`G1.2\`. Code follows the spec. Commits cite the ids they serve: \`feat(scope): subject [G1.2]\`. Only a person approves or changes an approved row. Ids are permanent: a row the person cuts stays, marked \`wont\` (won't build), so every commit that cites it keeps its meaning.

**House rules.** \`PRACTICE.md\` holds how this project is built, in the same row format. Its approved rows are in force; follow them as you would the spec.

**Role guides.** \`pullboard prompt run\`, \`decompose\`, \`plan\`, \`signoff\`, \`review\` and \`verify\` print the guide for each role. Claude Code also has them as skills. The agent in the main checkout runs the whole team by the run guide (the pullboard-run skill).

**Who you are.** An agent is its worktree. The main checkout is the coordinator. Every other agent gets its own worktree, already joined to one lane, from the main checkout:

    pullboard worktree <lane>

It prints the folder to work in and what to run there first. A smaller model joins with \`--route light\` or \`--route mid\` and takes items at its tier and below. Work only in that folder. Your shell may start every command in the main checkout, where pullboard takes you for the coordinator, so begin each command with \`cd <your worktree> &&\`. Verifiers take the \`review\` lane, which owns no folders. Keep your worktree and branch until your items are merged.

**The loop.**
1. \`pullboard resume\` at the start of every session and after your context is compacted: your claim, what came back, unread shouts and the next step. Then \`pullboard inbox\`.
2. \`pullboard next\` claims the next item in your lane that is free to start. When everything is waiting on other work, \`pullboard next --wait 9\` keeps looking for up to 9 minutes, which fits one tool call with a ten-minute timeout; run it again to keep waiting. A claim is a 2-hour lease; claim again to renew. The criterion freezes now: \`pullboard show <id>\` is the bar your work is judged against, and its brief says how to start.
3. Build inside your lane's folders (\`pullboard lanes\`). Pre-commit refuses anything else; shout the owner instead.
4. Commit, then \`pullboard submit <id>\`. It needs a clean tree and the gate green at HEAD.
5. A different agent verifies: \`pullboard next --verify\` names the next item to check. It checks out the submitted commit and runs \`pullboard verify <id> accept --note "how it proved it"\`, or \`pullboard verify <id> reject --reason TEST_FAILURE --note "what failed"\`.
6. A reject reopens the item. Fix it, commit, claim, submit again; the same head is refused. If you cannot get an item green, do not force it: \`pullboard escalate <id> --note "what you tried and how it failed"\` hands it one tier up.
7. Your lane is done when its items are verified, not when they are submitted. After your last submit, keep running \`pullboard next --wait 9\`: a rejected item comes back to your lane.

The coordinator merges verified items into the main line; builders never merge.

If your item needs code another lane owns and it is not there yet, shout that lane and take another item. Never copy their code into your lane, and never build another lane's item, even one that was rejected and blocks you: shout that lane and the coordinator. A claim refused as BLOCKED names the item it waits on.

**Talk.** \`pullboard shout <lane|agent|all> "<text>"\`. Read \`pullboard inbox\` before you start and after you submit.

**Never.** Bypass a hook with \`--no-verify\`, or get past a refusal with filler text: fix what it names. Edit the board's database. Verify your own work. Change an approved spec row without the person's OK. Delete or renumber a spec row. Act from the main checkout; it is the coordinator's. Count a yes relayed by another agent as the person's approval.
${AGENTS_END}
`;
}
