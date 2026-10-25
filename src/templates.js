import { BOARD_PROOF_GUIDANCE } from './agent-proof-guidance.js';
/**
 * What `pullboard init` writes into a repo: the config, a starter spec, and the agent instructions
 * every coding agent reads (AGENTS.md, which CLAUDE.md points at).
 */
import {
  doctrineText,
  standardDoctrine,
} from './doctrine.js';
import { DOCTRINE_FILE } from './config.js';

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
 *
 * @returns {string}
 */
export function agentsBlock(doctrine = standardDoctrine()) {
  return `${AGENTS_START}
## A new board

On a board that is not set up, run \`pullboard resume\` first. The coordinator walks the person through its setup steps; every other seat sends the setup decisions to the coordinator as described in Talk.

## Working here: pullboard

This repo runs on pullboard: a work board, lanes and a spec that live in git. Nothing ships until a second agent verifies it.

**Proof.** ${BOARD_PROOF_GUIDANCE}

**Source of truth.** \`SPEC.md\` holds every requirement as a row with an id, like \`G1.2\`. Code follows the spec. Commits cite the ids they serve: \`feat(scope): subject [G1.2]\`. Only a person approves or changes an approved row. Ids are permanent: a row the person cuts stays, marked \`wont\` (won't build), so every commit that cites it keeps its meaning. Propose each requirement with \`pullboard spec draft "<text>"\`; it returns the draft row id for the person to approve. To start from a blueprint's rules, questions and starter items, run \`pullboard blueprint add <name or file>\` (bundled: web-app); it files them all as drafts for the person to approve. Its questions file as pending rows, each with a default answer and its choices: the person answers one with \`pullboard spec answer <id> "<choice or text>"\` from the main checkout or the view, and the coordinator writes it with \`pullboard spec apply\`. Never answer a question by editing SPEC.md; spec check flags it. To share this board's approved rules and answered questions as a blueprint, run \`pullboard blueprint save [file]\`; it never writes items, notes, paths, emails or names.

**Outside row verification.** A verifier from another parent session records an exact-row verdict with \`pullboard spec verify <id> accepted|rejected --reason "why"\`. The row's author cannot verify their own row. Read its recorded verdict with \`pullboard spec show <id>\`; verification does not approve or change the row.

**Blueprint starters.** To see which of a blueprint's starter items are on the board, run \`pullboard blueprint starters <name or file>\`; it names each filed item's id and status. \`pullboard init --blueprint <name> --verbose\` lists every row that waits for the person, doctrine rows included.

**Doctrine.** Our house rules for agentic development. This repo inherits Pullboard standard doctrine version 1. ${doctrine.repo ? doctrine.name : DOCTRINE_FILE} adds the repo's own rows, overrides a standard rule by its PB id, or declines it with a wont row and its reason as the row text: - PB7 [wont] <why>. Approved rows are in force; follow them as you would the spec. A rule with \`gate: check <command>\` and \`count: N\` holds a count that only falls: run pullboard doctrine check to see each count, and submit refuses RATCHET_ROSE when a touched rule rises or a changed file gains a problem. Lower \`count:\` in a commit when you fix problems; only the person raises it. Run pullboard spec --json to read the current merged rules. Re-run pullboard init after changing the doctrine to refresh this managed guidance.

**Fit a blueprint.** After \`blueprint add\`, a seat can propose how each drafted row, question and starter item fits this repository with \`pullboard blueprint fit <name or file> <row id or #item> keep|adapt|drop|answer\`. Include \`--text\` for adapted wording or an answer, and \`--reason\` for why. The proposals remain drafts until the person reads \`pullboard spec fit\`, optionally edits one with \`pullboard spec fit edit <row id or #item> keep|adapt|drop|answer\`, and approves the batch with its printed code using \`pullboard spec fit approve <batch>\`. The proposer cannot run the person-only edit or approval commands.

### Current doctrine

${doctrineText(doctrine)}

**Several blueprints.** \`pullboard init\` and \`pullboard blueprint add\` take \`--blueprint\` more than once, such as \`pullboard init --blueprint web-app --blueprint serverless\`: at most one product and one architecture blueprint, and any number of practice and beyond-code ones. They land in the order given, a rule two of them share is drafted once, and each starter item keeps the name of its blueprint.

**Role guides.** \`pullboard prompt run\`, \`decompose\`, \`plan\`, \`signoff\`, \`review\` and \`verify\` print the guide for each role. Claude Code also has them as skills. The agent in the main checkout runs the whole team by the run guide (the pullboard-run skill).

**Who you are.** An agent is its worktree. The main checkout is the coordinator. Every other agent gets its own worktree, already joined to one lane, from the main checkout:

    pullboard worktree <lane> --model "<model name>"

It prints the folder to work in and what to run there first. Every join needs the exact model label, either with \`--model\` or the \`PULLBOARD_MODEL\` environment variable; family is separate and never supplies the model. A smaller model joins with \`--route light\` or \`--route mid\` and takes items at its tier and below. Work only in that folder. Your shell may start every command in the main checkout, where pullboard takes you for the coordinator, so begin each command with \`cd <your worktree> &&\`. Verifiers take the \`review\` lane, which owns no folders. Only the coordinator adds a lane, from the main checkout: \`pullboard lane add <name> --owns <path>[,<path>]\`. \`pullboard init\` proposes lanes from the folder layout; the coordinator adds those first lanes without waiting, then tells the person which lanes it made. After that, a change to which lane owns a path waits for the person's OK. Keep your worktree and branch until your items are merged.

**Codex.** Codex's workspace-write sandbox keeps \`.git\` read-only, and the board lives in \`.git/pullboard\`, so start Codex with that folder writable before the first pullboard command: \`codex --add-dir "$(git rev-parse --path-format=absolute --git-common-dir)/pullboard"\` To keep it in \`~/.codex/config.toml\`: a permission profile takes \`"<that folder>" = "write"\` in its \`[permissions.<profile>.filesystem]\` table; only settings without a profile use \`writable_roots\` under \`[sandbox_workspace_write]\`, which a named profile ignores. A refused \`BOARD_NOT_WRITABLE\` names the same step.

**The loop.**
1. \`pullboard resume\` at the start of every session and after your context is compacted: your claim, what came back, unread shouts and the next step. Then \`pullboard inbox\`.
2. If you have no active claim, run \`pullboard next\` now and take what it returns; never wait for an assignment. \`pullboard next\` claims the next free item your session can take across the lanes, by release and queue rank. It names the lane worktree to use and opens one when your session has none there; begin subsequent commands in that folder. Each worktree still owns only its lane’s files. Joining associates the seat with the invoking agent session automatically; no person setup is needed. When everything is waiting on other work, \`pullboard next --wait 9\` keeps looking for up to 9 minutes, which fits one tool call with a ten-minute timeout; run it again to keep waiting. A claim is a 2-hour lease; claim again to renew. The criterion freezes now: \`pullboard show <id>\` is the bar your work is judged against, and its brief says how to start. \`pullboard why <id>\` lists the decisions that changed it, newest first. When your own answer, verdict or fact changes other items, name them with \`--implies <ids>\` so each one carries it. A claim or submit refused as CRITERION_PROVES_NOTHING names a check that already passes on main, so it proves nothing: shout the coordinator for a check that fails before the work. Only the person accepts a check as it stands, with \`pullboard check accept <id>\` from the main checkout or the view.
3. Build inside your lane's folders (\`pullboard lanes\`). Pre-commit refuses anything else; shout the owner instead.
   Run tests with \`pullboard test <test files>\`, never the test runner by hand: it sends the files to the registered runners first, with the per-file timeout, runs your uncommitted changes too, and names a failure main already has as a known main failure, so you never run a baseline yourself.
4. Commit, then \`pullboard submit <id>\`. It needs a clean tree and the gate green at HEAD.
5. A different agent verifies: \`pullboard next --verify\` names the next item to check. It checks out the submitted commit and runs \`pullboard verify <id> accept --note "how it proved it"\`, or \`pullboard verify <id> reject --reason TEST_FAILURE --note "what failed"\`.
When a reject names a structured cause, add \`--cause <key>\` (\`test:<file>::<title>\`, \`refusal:<CODE>\`, \`row:<id>\` or \`doctrine:<id>\`) so \`pullboard rigor\` can notice when the same cause repeats; the coordinator turns a repeated cause into a draft rule with \`pullboard rigor draft <key> "<rule>" --check "<command>" --red <commit> --green <commit>\`, which proves the check red, then green, before the person decides. Before you submit, \`pullboard rigor quality\` names each breach of the person's code and test quality rules in your change, with its file, line and rule.
6. A reject reopens the item. Fix it, commit, claim, submit again; the same head is refused. If you cannot get an item green, do not force it: \`pullboard escalate <id> --note "what you tried and how it failed"\` hands it one tier up.
7. Your lane is done when its items are verified, not when they are submitted. After your last submit, keep running \`pullboard next --wait 9\`: a rejected item comes back to your lane.

**Read the source map.** \`pullboard map\` shows committed \`main\`; use \`pullboard map <module or function>\` for a card or \`pullboard map --for <item>\` for its one-hop source and test slice. Item slices default to 4k tokens and cap at 8k with \`--budget\`. The map is static: \`not detected\` means the scan could not see an effect or edge, so treat it as unknown.

The coordinator merges verified items into the main line; builders never merge. When a release ships, the coordinator runs \`pullboard milestone ship <name>\`: it records main's commit and moves the items that have not landed into the next milestone. The queue orders itself by what each item unblocks and what it costs; the coordinator holds an item above that order with \`pullboard milestone pin <name> <ids> --reason "<why>"\`, below it with \`pullboard milestone sink <name> <ids> --reason "<why>"\`, and returns it with \`pullboard milestone lift <name> <ids>\`. \`pullboard health\` lists every stuck item: a lapsed claim, a review nobody took, accepted work that never landed, an old hold, an unanswered decision. Each line says why, since when, the next step and who takes it; run it at the start of a session and take the steps that name you.

**Replay flow.** Run \`pullboard flow replay --json\` to reproduce recorded landing order and stage quartiles from text-free lifecycle history. To compare a hypothetical order and board line settings, run \`pullboard flow replay --history history.json --policy policy.json --json\` with the exported version-1 history and a JSON policy containing \`order\` and \`settings\`. Recorded work durations stay fixed; alternate queue times are deterministic predictions, not measured speedups.

For recurring checks, \`pullboard sentinels\` lists this board's watches, their approvals and their latest results. Propose one with \`pullboard sentinel propose <name> --check "<command>" --every hourly --owner coordinator\`; a proposal does not run until the person approves its exact command, directory and schedule. Only the person runs \`pullboard sentinel approve <name>\` or \`pullboard sentinel decline <name> --reason "<why>"\` from their own terminal or Pullboard View. Agents never approve their own proposals; send the decision to the coordinator.

For spare test capacity, use \`pullboard runner add <ssh-host> --slots <n> --browser <n>\`. It registers SSH capacity on this machine; \`pullboard runner list\` shows each runner's registered slots and browsers, and \`pullboard resources\` shows their usage. Only committed source goes to a runner, and board moves stay here. To see whether this board is linked to the relay, and for which GitHub account, run \`pullboard relay status\`.

If your item needs code another lane owns, run \`pullboard companion <parent> <lane> "<title>" --key <stable-key>\` to create its claimable child; reuse that parent, lane and key to find the existing companion. The other lane claims the child before building; a duplicate request never assigns a second builder. Then shout that lane and take another item. Never copy their code into your lane, and never build another lane's item, even one that was rejected and blocks you: shout that lane and the coordinator. A claim refused as BLOCKED names the item it waits on.

The activity feed separates interrupts from digest summaries. Read \`pullboard inbox\` at your next check; rejected work, lapsing claims, answers and changed working files remain pending until you act. After acting, use \`pullboard inbox --acted-on <interrupt-ids>\` with its comma-separated ids. The board records delivery separately from acknowledgement; a local cursor never means acted-on. A short digest arrives on your first inbox check in a session and after a successful submit, without raw activity bodies. \`pullboard resume\` remains read-only.

**Talk.** \`pullboard shout <lane|agent|all> "<text>"\`. Only the coordinator or person marks release or focus news with \`pullboard shout all "<release or focus news>" --news\`; it arrives as a one-line digest at session start. Keep governing instructions as ordinary shouts so they stay direct. Read \`pullboard inbox\` before you start and after you submit. Only the coordinator (the agent in the main checkout) talks with the person. Every other agent sends anything that needs the person—a decision, an approval, a waiver, a preview or a phone check—to the coordinator with \`pullboard shout coordinator "<what is needed>" --decision\`, and never asks the person in its own session, even when the person is watching. An MCP client can do the same as your agent: add \`pullboard mcp\`, run from your worktree, as a stdio server; it reads the board, shows an item, shouts and captures ideas for the coordinator, and never makes a person's move.

**Listen.** Where your client can run a command in the background, run \`pullboard watch --to <your id>\` there: it prints one line per event as it happens, and Claude Code wakes on each line when it runs under the Monitor tool. \`pullboard watch --work <lane>\` also says when an item in your lane becomes claimable, a review has waited too long, or main moves. Where your client cannot, read \`pullboard inbox\` at session start, after submit and before ending a turn. Coordinator answers and sentinel findings arrive there either way.

**Presence.** Session hooks run \`pullboard heartbeat\` to record local activity; keep them installed so live, idle and gone reflect your session.

**Never.** Bypass a hook with \`--no-verify\`, or get past a refusal with filler text: fix what it names. Edit the board's database. Verify your own work. Change an approved spec row without the person's OK. Delete or renumber a spec row. Act from the main checkout; it is the coordinator's. Count a yes relayed by another agent as the person's approval.

## Helping the person

Only the coordinator follows this section with the person. Other agents do the technical investigation themselves and send any needed person action to the coordinator with \`pullboard shout coordinator "<what is needed>" --decision\`.

When the person asks for help with Pullboard, such as "Help me open my Pullboard board" or "Help me share my boards with my phone", work out the technical side yourself: read \`pullboard status\`, check whether \`pullboard view\` is running, read \`pullboard relay\` for the link, and follow the next step in any refusal. Then say what is going on in plain words and walk the person through each step they must take, one at a time: give one step, wait for them to say what they see, then give the next.

**Opening their board.** Start \`pullboard view\` yourself; it opens the board on this computer and prints its link. On app.pullboard.dev the browser may ask to let the page reach apps on this device: tell the person to click Allow, so the page can read the board running here. If they clicked Block, walk them through turning it back on: click the icon at the left of the address bar, open Site settings for app.pullboard.dev, set the access to apps on this device to Allow, then reload the page.

**Sharing with the phone or another computer.** Have the person type \`pullboard relay on --all\` themselves in their own terminal: it signs in as them, so Pullboard refuses it from an agent. Tell them what they will see: a GitHub address and a code to enter there, one \`linked:\` line for each board, then a QR code. To sign in on the phone, the person scans that QR code, taps Sign in with GitHub and approves Pullboard; their boards then appear on the phone. For another computer, the person runs \`pullboard relay pair\` in a board here and types \`pullboard relay join <code>\` on the other computer. Then confirm the boards arrived: run \`pullboard relay\` in each board to see its link, and \`pullboard relay devices\` to see the paired phone. The person can authorize additional developers with \`pullboard relay members set <login>\` from the main checkout, using a committed approver’s SSH key. \`pullboard relay members clear\` removes additional members; relay identity alone never admits a device.
${AGENTS_END}
`;
}

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
