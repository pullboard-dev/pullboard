/**
 * What `pullboard init` writes into a repo: the config, a starter spec, and the agent instructions
 * every coding agent reads (AGENTS.md, which CLAUDE.md points at).
 */

export const AGENTS_START = '<!-- pullboard:start -->';
export const AGENTS_END = '<!-- pullboard:end -->';

/**
 * The starting pullboard.json: the gate init detected, the spec, and no lanes yet.
 *
 * @param {string} gate
 * @returns {string}
 */
export function configTemplate(gate) {
  const config = {
    gate,
    spec: 'SPEC.md',
    verify: 'any',
    lease: '2h',
    lanes: {},
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

Statuses: approved = decided · draft = proposed · pending = open question · fact = true today · retired = spent, never reused. Tiers: must · aim.

## G · Goals: what the client asked for
- G1 [draft, must] Replace with the first thing the client needs, in one line. | gate: the test that proves it

## K · Constraints
- K1 [draft, must] Replace with a constraint, e.g. runs locally with no account. | gate: review
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

**Source of truth.** \`SPEC.md\` holds every requirement as a row with an id, like \`G1.2\`. Code follows the spec. Commits cite the ids they serve: \`feat(scope): subject [G1.2]\`. Only a person approves or changes an approved row.

**Who you are.** An agent is its worktree. The main checkout is the coordinator. Every other agent works in its own worktree and joins one lane:

    git worktree add ../<repo>-<lane> -b <lane>/<slug>
    cd ../<repo>-<lane> && pullboard join <lane>

**The loop.**
1. \`pullboard inbox\`, then \`pullboard list <lane>\`.
2. \`pullboard claim <id>\`. A claim is a 2-hour lease; claim again to renew. The criterion freezes now: \`pullboard show <id>\` is the bar your work is judged against.
3. Build inside your lane's folders (\`pullboard lanes\`). Pre-commit refuses anything else; shout the owner instead.
4. Commit, then \`pullboard submit <id>\`. It needs a clean tree and the gate green at HEAD.
5. A different agent verifies: it checks out the submitted commit and runs \`pullboard verify <id> accept\`, or \`pullboard verify <id> reject --reason TEST_FAILURE --note "what failed"\`.
6. A reject reopens the item. Fix it, commit, claim, submit again; the same head is refused.

**Talk.** \`pullboard shout <lane|agent|all> "<text>"\`. Read \`pullboard inbox\` before you start and after you submit.

**Never.** Bypass a hook with \`--no-verify\`. Edit the board's database. Verify your own work. Change an approved spec row without the person's OK.
${AGENTS_END}
`;
}
