/**
 * What `pullboard init` writes into a repo: the config, a starter spec, and the agent instructions
 * every coding agent reads (AGENTS.md, which CLAUDE.md points at).
 */
import { DOCTRINE_FILE } from './main.js';
import { defaults } from './main.js';

export const AGENTS_START = '<!-- pullboard:start -->';
export const AGENTS_END = '<!-- pullboard:end -->';

/**
 * The starting pullboard.json: the gate and the fixers init detected, the spec, no lanes yet, and
 * checks.provesNothing at "hold", so a new board holds an item whose check already passes on main.
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
    practice: DOCTRINE_FILE,
    worktrees: 'inside',
    verify: { policy: 'any', family: 'off' },
    modelTiers: defaults().modelTiers,
    agents: { names: 'suffix' },
    lease: '2h',
    lanes: { review: { owns: [], starts: 'any time: verifiers check submitted work and own no folders' } },
    shared: [],
    commits: { requireIds: ['feat', 'fix'] },
    checks: { provesNothing: 'hold' },
  };
  return `${JSON.stringify(config, null, 2)}\n`;
}

/**
 * A starter SPEC.md with the row format shown by example.
 *
 * @param {string} project
 * @param {string} [gate] Use the detected ecosystem's check in the fenced example.
 * @returns {string}
 */
export function specTemplate(project, gate = 'the test that proves it') {
  return `# ${project} spec

Every requirement is a row with an id. Agents build against approved rows; commits cite the ids they serve. \`pullboard spec check\` lints this file.

Statuses: approved = decided · draft = proposed · pending = open question · fact = true today · wont = won't build, decided and kept · retired = no longer applies, kept. Ids are permanent: never delete or renumber a row. Tiers: must · aim.

Write each requirement as one row under its section, in this format. The fence keeps the example out of the spec, so no placeholder id is ever committed; your own rows go below, outside it.

\`\`\`text
- G1 [draft, must] The first thing the client needs, in one line. | gate: ${gate || 'the test that proves it'}
- K1 [draft, must] A constraint, e.g. runs locally with no account. | gate: review
\`\`\`

## G · Goals: what the client asked for

## K · Constraints
`;
}

/**
 * A repo's own rule sections. The package supplies the inherited rows once, rather than copying
 * them into every repo and leaving each copy to drift.
 *
 * @returns {string}
 */
export function practiceTemplate() {
  return `# Doctrine

Our house rules for agentic development.

Inherits Pullboard standard doctrine version 1.

## W · Writing

## C · Code

## T · Tests

## P · Git and the gate

## D · Dependencies

## S · Security and data
`;
}

/**
 * The agent instructions, between markers so init can find its own block and never touch the rest.
 * The text is the approved block from this repo's AGENTS.md, so every new board gets the same words.
 *
 * @returns {string}
 */
export function renderAgentsBlock() {
  return `<!-- pullboard:start -->
## Pullboard

This repo runs on Pullboard: board, lanes and spec, all in git.

- **Spec:** \`SPEC.md\` rows, each with an id like \`G1.2\`; code follows them.
- **Commits:** \`feat(scope): subject [G1.2]\`, citing the ids served.
- **Seats:** an agent is its worktree; the main checkout is the coordinator.
- **Lanes:** join one with \`pullboard join <lane>\`.

## Roles

Agents think; Pullboard does everything deterministic.

| Role | Does |
|---|---|
| Coordinator | One per board. Files, routes, unblocks; never builds. Reads \`COORDINATOR.md\`. |
| Worker | Builds and verifies whatever \`next\` hands it. |
| Sub-agent | Any agent may launch one. Runs the worker loop as written, on its own seat. |
| Pullboard | Runs gates, routes verifies, lands accepted work. |

## Worker loop

Never wait: submit and move on.

1. \`pullboard next\`: a build or a verify.
2. \`pullboard show <id>\`: your bar, frozen at claim.
3. **Build** in your lane's folders; pre-commit refuses others.
4. **Commit**, then \`pullboard submit <id>\`; it returns at once.
5. **Repeat.** \`next\` returns reds and rejects; fix and resubmit.

### Building

- **Gate:** Pullboard runs it; never run whole suites.
- **Long commands:** background anything over 1 min.
- **Other folders:** shout their owner.
- **Can't build:** \`pullboard release <id> --reason <CODE>\`, then \`next\`.
- **Shouts:** arrive only while a command runs.
- **Stop:** after 4 empty \`next\` answers in a row.

### Verifying

- **Judge:** the diff against the bar and the gate's receipts.
- **Rerun:** only if no recorded run covers a clause, or you doubt the gate.
- **Accept:** \`pullboard verify <id> accept\`.
- **Reject:** \`pullboard verify <id> reject --reason <CODE> --note "…"\`.

## Troubleshoot

- **A refusal:** do what its \`next:\` line says.
- **An item:** \`pullboard show <id>\` prints its last refusal.
- **Your state:** \`pullboard whoami\`.
- **Stale work:** \`pullboard resume --diagnostics\`.
- **Setup:** \`pullboard doctor\`.

## Warning

Still stuck? Tell the coordinator, with the refusal word for word:

\`\`\`
pullboard shout coordinator --kind blocker "<what; the refusal>"
\`\`\`

Need an override? Only the person grants one:

\`\`\`
pullboard escalate <id> --note "what was tried"
\`\`\`

## Never

- Bypass a hook with \`--no-verify\`.
- Edit the board's database.
- Verify your own work.
- Change an approved spec row without the person's OK.
<!-- pullboard:end -->
`;
}

/**
 * The coordinator guide setup writes as COORDINATOR.md, byte for byte the approved guide.
 *
 * @returns {string}
 */
export function renderCoordinatorGuide() {
  return `# COORDINATOR.md

For the coordinator only. Workers follow \`AGENTS.md\`.

## Coordinator loop

Fix the board, not the prompt.

1. \`pullboard resume\`: the work card and board health.
2. \`pullboard inbox\`: decisions, blockers and Stuck shouts; act within the hour.
3. **Watch** the pipeline: gates, verifies, accepts, landings.
4. **File:** \`pullboard add\` with a numbered bar, each clause tagged.
5. **Fix:** stuck or wrong items (see Fixing).
6. **Repeat.**

### Watching

- **Pipeline:** \`pullboard stats pipeline\`.
- **Gates:** \`pullboard gate-health --since 2h\`.
- **Verifies:** \`pullboard queue\`.
- **Landing:** \`pullboard land --due --dry-run\`; landed: \`pullboard merged\`.
- **Seats:** \`pullboard seats\`.
- **Shouts:** \`pullboard watch --to coordinator\`.
- **Health:** \`pullboard health\`.

### Filing

- **Clauses:** tagged \`[test]\`, \`[command]\` or \`[measurement]\`.
- **Wiring:** name the caller files, plus one real-path clause.
- **Never name:** runtime state or paths no lane owns.

### Fixing

- **Re-bar:** \`pullboard edit <id>\`, then lift any hold.
- **Pause:** \`pullboard hold <id>\`; lift with \`--off\`.
- **Stranded submit:** \`pullboard reopen <id>\`.
- **Stale policy:** \`pullboard refreeze <id>\`.
- **Done elsewhere:** \`pullboard withdraw <id> <reason>\`, so no one rebuilds it.
- **Stale claim:** release it before another worker starts.
- **Row decisions:** \`pullboard spec apply\` after the person rules.
- **New stall kind:** file a board-side fix.
- **Forced landing:** with the person's OK, when the gate is broken.
- **Forced means:** green at its exact candidate; never dodges a red.

### Tools

- **Order:** \`pullboard roadmap\`; \`pullboard milestone pin\` or \`order\`.
- **People's calls:** \`pullboard decisions\`.
- **Capacity:** \`pullboard capacity\`; runners: \`pullboard runner list\`.
- **Time:** \`pullboard stats time\` shows where items spend it.
- **Flakes:** \`pullboard flakes quarantine\`.
- **Sentinels:** \`pullboard sentinels\` lists the stall detectors.
- **Why:** \`pullboard why <id>\` and \`pullboard trace\` explain a move.
`;
}

/** The file the coordinator guide is written to. */
export const COORDINATOR_GUIDE_FILE = 'COORDINATOR.md';

/** Git subcommands used directly by Pullboard's documented agent loop, never all Git commands. */
export const PULLBOARD_LOOP_GIT_COMMANDS = Object.freeze([
  'status', 'diff', 'log', 'add', 'commit', 'merge', 'rebase', 'switch', 'checkout', 'worktree',
]);

/**
 * Return gate argv only when the configured command is plain words; shell syntax is never widened
 * into an allow rule that could hide other commands.
 *
 * @param {string} gate
 * @returns {string[] | null}
 */
export function plainGateWords(gate) {
  const text = String(gate ?? '').trim();
  return /^[A-Za-z0-9_./:=@+-]+(?: [A-Za-z0-9_./:=@+-]+)*$/u.test(text) ? text.split(' ') : null;
}

/**
 * Rules Claude Code can add to this project without changing the person's home or session settings.
 *
 * @param {{ gate?: string }} options
 * @returns {string[]}
 */
export function claudeLoopRules({ gate = '' }) {
  const rules = ['Bash(pullboard:*)', ...PULLBOARD_LOOP_GIT_COMMANDS.map(command => `Bash(git ${command}:*)`)];
  const words = plainGateWords(gate);
  if (words) rules.push(`Bash(${words.join(' ')})`);
  // Project-relative rules follow each linked worktree's primary working directory.
  rules.push('Edit(/**)');
  return rules;
}

/**
 * Codex project-local rules use argv prefixes and apply only after the project is trusted. Each
 * pattern is intentionally scoped to one product command or one listed Git verb.
 *
 * @param {string} gate
 * @returns {string[]}
 */
export function codexLoopRules(gate = '') {
  const patterns = [['pullboard'], ...PULLBOARD_LOOP_GIT_COMMANDS.map(command => ['git', command])];
  const words = plainGateWords(gate);
  if (words) patterns.push(words);
  return patterns.map(pattern => `prefix_rule(pattern=${JSON.stringify(pattern)}, decision="allow", justification="Run the Pullboard project loop.")`);
}

/** The board owns proof; generated agent instructions never prescribe a separate evidence system [I1,I3,V4]. */
export const BOARD_PROOF_GUIDANCE = "The frozen check, the gate and the verifier's verdict are the proof. "
  + 'Do not keep private evidence folders, packets, manifests or custody rules. '
  + "Cite the board's receipts. If those runs cannot decide the item, ask the coordinator to sharpen its bar.";
