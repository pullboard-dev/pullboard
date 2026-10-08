/**
 * The pullboard command line: every command, bound to who is asking (B3). The main checkout is the
 * coordinator; every other worktree is the agent that joined from it.
 */
import { createHash } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import * as store from './board.js';
import { CONFIG_FILE, COORDINATOR, loadConfig } from './config.js';
import { doctrineHistory, loadDoctrine } from './doctrine.js';
import { requirePersonChannel } from './person.js';
import { decisionProjection, planRowApply, prepareRowDecisions, restoreRowApply, writeRowApply } from './row-decisions.js';
import { digestOf, gateReport, runGate, runShell } from './gate.js';
import { bareWorktreeFinding, contains, differFromHead, git, headCommit, headTree, isClean, repoInfo, resolveCommit, tryGit, untracked } from './git.js';
import {
  FIX_NOTE,
  applyFixers,
  commitMsgProblems,
  installHooks,
  preCommitProblems,
  prePushProblems,
} from './hooks.js';
import { initRepo } from './init.js';
import { lifecycleHelp, lifecycleMarkdown } from './machine.js';
import { productLine, productProblems, productSummaries } from './products.js';
import { isLane, laneNames, laneOf, outOfLane } from './lanes.js';
import { Refused } from './refused.js';
import { commitCitations, committedIds } from './history.js';
import { promptFor } from './skills.js';
import {
  frozenCriterion,
  idProblems,
  lintSpec,
  loadSpec,
  permanenceProblems,
  readSignoffs,
  signOff,
  standings,
  unmetRows,
} from './spec.js';
import { briefFiles } from './brief.js';
import { checkBaseline, sayCheckBaseline } from './check-baseline.js';
import { runItems } from './run.js';
import { parseProblems, sweepItems } from './sweep.js';
import { renderSpecView } from './view.js';
import { tour } from './tour.js';
import { commandOutput } from './json.js';
import { forgetProject, registerProject } from './projects.js';
import { milestoneRoadmap } from './roadmap.js';
import { listResources } from './resources.js';
import { citedTestFiles, rowEvidence, rowStage } from './evidence.js';
import { exportView, serveView } from './serve.js';
import { serveApi } from './api.js';
import { doctorProblems, doctrineProblems } from './doctor.js';
import { staleFrozenItems, staleItemFinding } from './approved-rows.js';
import { mainPolicy, itemPolicy, submissionPaths, frozenCheck, checkAtCommit, dependencySnapshots } from './trusted-policy.js';
import { exportBoard, importBoard } from './exchange.js';
import { addSigner, assertRequiredSigners, defaultPrincipal, hasSignerFile } from './signature.js';
import { loadMachineSettings, setGateSlots } from './settings.js';
import { relayCommandReceipt, relayCommandReceiptReported, relayLinked, relayOff, relayOn, relayOperation, relayRecovered, relayStatus, syncRelay } from './relay.js';
import { executePersonRequests } from './relay-request-execution.js';

const PACKAGE = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
export const VERSION = PACKAGE.version;

const ALL_HELP = `pullboard ${VERSION}: the local-first work board for teams of coding agents.
Nothing ships until a second agent verifies it.

Set up
  pullboard tour                        see it work: a reject and its rework, scripted, in thirty seconds
  pullboard init                        config, SPEC.md, agent instructions, git hooks, board
  pullboard worktree <lane> [--route light] [--family <name>]   make and join a worktree for a new agent
  pullboard join <lane> [--route light] [--family <name>]       register this worktree as an agent
                                        --route sets which work the model can take; --family records its name
  pullboard whoami | lanes | status     who you are, the lanes, the board at a glance
  pullboard resources                  local resource holders and their FIFO queues
  pullboard settings [gateSlots <n>]    view or set this machine's gate slots (default 2)
  pullboard view [--port N] [--no-open]  every project on this machine in your browser: items, shouts, doctrine,
                                        agents and activity, live; add items, shout and hold lanes from it
  pullboard view --export <dir>         a read-only snapshot with event replay, for any static host
  pullboard serve [--port N]           local API v1: boards, state, moves, requests and live events,
                                        behind the session secret in its printed address
  pullboard relay [on|off] [--url <address>]  link, inspect or unlink this board's sealed relay mirror
                                        on signs in through GitHub; the address defaults to https://app.pullboard.dev
  pullboard resume                      where you are: your claim, branch, uncommitted work, what came back,
                                        unread shouts, what to do next; run it to start any session
  pullboard hooks                       reinstall the git hooks (e.g. after a fresh clone)

Work
  pullboard add <lane> <title> [--criterion "..."] [--specs G1.2,K3] [--after 3,4] [--parent <id>]
                [--brief "..." | --brief-file <file>] [--route light|mid]
                                        --after: claiming waits until those items are verified
                                        --brief: what a cold agent needs; --route light: any model can build it
                [--check "<command>"]  the command that proves it; with --criterion and a brief, needed below strong
  pullboard edit <id> [--brief "..." | --brief-file <file>] [--route light|mid|strong] [--criterion "..."] [--check "..."]
  pullboard escalate <id> --note "what was tried and how it failed"   hand it one tier up
  pullboard run --agent "<command>" [--attempts 3] [--minutes 15] [--items N] [--wait M]
                                        build routed items unattended in this worktree: the agent command reads
                                        the context pack at $PULLBOARD_PACK (and $PULLBOARD_CHECK, $PULLBOARD_ITEM,
                                        $PULLBOARD_ATTEMPT, $PULLBOARD_TIER); green work is submitted, red escalated
                [--agent-light "..."] [--agent-mid "..."] [--agent-strong "..."]   a command per tier
  pullboard list [lane] [--all] [--route light|mid|strong]   open and active items; --all adds closed ones
  pullboard roadmap                     ordered milestones and each item's live status
  pullboard milestone add <name> [--note ...] [--items 1,2,3]   create a milestone and optionally add items
  pullboard milestone items <name> --add|--remove ids          append or remove item references
  pullboard milestone move <name> --before <other>             reorder a milestone
  pullboard milestone edit <name> [--name <new>] [--note <text>]
                                        rename or update a milestone note
  pullboard milestone remove <name>                            remove a milestone without changing its items
  pullboard doctor                     check board integrity without changing it
  pullboard show <id> [--history]       an item, the criterion frozen at claim, its verdicts: the latest in full,
                                        earlier ones as one line; --history prints every note in full
  pullboard fact <id> <kind> <text> [--supersedes <fact-id>] [--ref path:lines@full-sha]
                                        append an observation or a holder/coordinator judgement to its thread
  pullboard next [--wait <minutes>]     offer an eligible review when reviews pile up, otherwise claim work
  pullboard next --build                claim a build explicitly, recording a skipped review offer
  pullboard next --verify               reserve the next submitted item you can check;
  pullboard next --verify <id>          reserve that submitted item instead
                                        in the main checkout, verifying needs --as coordinator
  pullboard check [id] [--yes]          show and run your item's check; --yes confirms a check set by someone else
                                        the command and its author print first; the project gate is pullboard gate
  pullboard claim <id>                  take or renew a lease; the first claim freezes the criterion
  pullboard release <id>                hand it back
  pullboard submit <id>                 needs a clean tree and the gate green at HEAD (alias: done)
  pullboard verify <id> accept --note "what you broke or which edge you tried, and what happened"
  pullboard verify <id> reject --reason TEST_FAILURE --note "what failed"
                                        any --note can be --note-file <file>, which keeps quotes, $ and backticks intact
  pullboard shout <lane|agent|person|all> <text>  pullboard inbox
  pullboard shout [<to>] <text> --decision       ask for a decision; defaults to your coordinator or the person
  pullboard shout <to> <text> --evidence attempt|receipt --outcome <word> --item <id> --commit <rev>
  pullboard answer <shout-id> <text> [--as person]
                                        answer your decision; person mode is main-checkout only
  pullboard pass <shout-id> <note>                coordinator passes a decision to the person
  pullboard decisions [--as person]               shouts waiting for you; main checkout defaults to coordinator
  pullboard export                              print the whole board as versioned JSON
  pullboard import <file>                       restore a versioned export into an empty board

Coordinator
  pullboard sweep --run "<checker>" --check "<checker on {file}>" [--route light] [--max 20] [--dry-run]
                                        file one item per file a linter, type checker or test reporter flags
  pullboard merged <id> <commit>        record where verified work landed
  pullboard withdraw <id> <reason>      drop an item nobody should build
  pullboard refreeze <id>               re-freeze a criterion after its spec rows changed
  pullboard hold <lane> --reason "..."   pause a lane: next there claims nothing and names the reason
  pullboard hold <lane> --off           release it

Receipts
  pullboard ledger                      markdown: what was built, by whom, verified by whom
  pullboard log [id]                    every move, in order

Spec
  pullboard spec --json                 parsed SPEC.md and doctrine rows as JSON
  pullboard forget <path>               remove a repo from this machine's project list
  pullboard spec check                  lint SPEC.md and the doctrine (house rules for agentic development)
  pullboard spec view [--out file]      the spec, open questions, sign-offs and doctrine as one page
  pullboard spec show <id> | unmet [--must] | signoff <ids> [--by <principal>]
                                        signoff: --note "what was checked" stays with the receipt
  pullboard spec signers add [--key <path>] [--by <principal>]  opt into SSH-signed sign-offs
                                        principal defaults to Git user.email; --by overrides it
  pullboard spec approve <ids> | decline <ids> --reason "why"  the person's exact-row decision
                                        approve <id> --text "new wording" approves an exact rewrite
  pullboard spec apply                  coordinator applies recorded row decisions to the files

Role guides
  pullboard prompt decompose|plan|signoff|review|verify   how to do each role; Claude Code gets them as skills

Gate and hooks
  pullboard gate                        run the configured gate
  pullboard hook pre-commit|commit-msg|pre-push   git runs these

${lifecycleHelp()}

Reject reasons: TEST_FAILURE, BEHAVIOR_MISMATCH, INSUFFICIENT_EVIDENCE, STALE_HEAD, OTHER.
--json prints one versioned document for every command; refusals include their code and next step.`;

const HELP_NAMES = [
  'tour', 'init', 'worktree', 'join', 'whoami', 'lanes', 'status', 'resources', 'settings', 'view', 'view export',
  'serve', 'relay', 'resume', 'hooks', 'add', 'edit', 'escalate', 'run', 'list', 'doctor', 'show', 'next',
  'check', 'claim', 'release', 'submit', 'done', 'verify', 'fact', 'shout', 'answer', 'pass', 'decisions', 'inbox', 'export', 'import',
  'sweep', 'merged', 'withdraw', 'refreeze', 'hold', 'ledger', 'log', 'spec', 'spec check', 'spec view',
  'spec show', 'spec unmet', 'spec signoff', 'spec signers', 'spec signers add', 'forget', 'prompt', 'gate', 'hook',
  'hook pre-commit', 'hook commit-msg', 'hook pre-push', 'view export', 'version', 'lifecycle', 'help',
  'roadmap', 'milestone',
];

const HELP_GROUPS = [
  ['Start', ['tour', 'init', 'worktree']],
  ['Work', ['add', 'list', 'claim']],
  ['Review', ['submit', 'next', 'verify']],
  ['See', ['status', 'view', 'log']],
];

const HELP_EXAMPLES = {
  tour: 'pullboard tour', init: 'pullboard init', worktree: 'pullboard worktree web', resume: 'pullboard resume',
  add: 'pullboard add web "Upload page" --specs G1', list: 'pullboard list web', show: 'pullboard show 12',
  claim: 'pullboard claim 12', submit: 'pullboard submit 12', 'next --verify': 'pullboard next --verify',
  fact: 'pullboard fact 12 measurement "The check passes in 8 seconds"',
  verify: 'pullboard verify 12 accept --note "removed the fix; the test failed"',
  answer: 'pullboard answer 12 "done"', pass: 'pullboard pass 12 "please decide"',
  status: 'pullboard status', view: 'pullboard view', log: 'pullboard log 12', ledger: 'pullboard ledger',
  roadmap: 'pullboard roadmap', milestone: 'pullboard milestone add "0.7.0" --items 12,13',
  edit: 'pullboard edit 12 --brief "Add the upload page"', release: 'pullboard release 12',
  escalate: 'pullboard escalate 12 --note "needs a manual step"', next: 'pullboard next',
  run: 'pullboard run --agent "node agent.js"', 'view export': 'pullboard view --export ./site',
  'spec check': 'pullboard spec check',
  'spec view': 'pullboard spec view', 'spec show': 'pullboard spec show G1',
  'spec unmet': 'pullboard spec unmet', 'spec signoff': 'pullboard spec signoff G1',
  'spec signers add': 'pullboard spec signers add', help: 'pullboard help claim', version: 'pullboard --version',
};

const HELP_ALIASES = {
  whoami: { usage: 'pullboard whoami', source: 'whoami' },
  lanes: { usage: 'pullboard lanes', source: 'whoami' },
  status: { usage: 'pullboard status', source: 'whoami' },
  done: { usage: 'pullboard done <id>', source: 'submit <id>' },
  inbox: { usage: 'pullboard inbox', source: null },
  lifecycle: { usage: 'pullboard lifecycle', source: null },
  escalate: { usage: 'pullboard escalate <id> --note "..." [--note-file <file>]', source: 'escalate <id> --note "what was tried and how it failed"', extraFlags: ['--note-file <file>'] },
  'view export': { usage: 'pullboard view --export <dir>', source: 'view' },
  'spec check': { usage: 'pullboard spec check', source: 'spec check' },
  'spec view': { usage: 'pullboard spec view [--out file]', source: 'spec view' },
  'spec show': { usage: 'pullboard spec show <id>', source: 'spec show', onlyFlags: [] },
  'spec unmet': { usage: 'pullboard spec unmet [--must]', source: 'spec show', onlyFlags: ['--must'] },
  'spec signoff': { usage: 'pullboard spec signoff <ids> [--by <principal>] [--note "..."] [--note-file <file>]', source: 'spec show', onlyFlags: ['--by', '--note', '--note-file'], extraFlags: ['--note-file <file>'] },
  'spec signers': { usage: 'pullboard spec signers add [--key <path>] [--by <principal>]', source: 'spec signers add' },
  'spec signers add': { usage: 'pullboard spec signers add [--key <path>] [--by <principal>]', source: 'spec signers add' },
  hook: { usage: 'pullboard hook pre-commit|commit-msg|pre-push', source: 'hook' },
  'hook pre-commit': { usage: 'pullboard hook pre-commit', source: 'hook' },
  'hook commit-msg': { usage: 'pullboard hook commit-msg <file>', source: 'hook' },
  'hook pre-push': { usage: 'pullboard hook pre-push', source: 'hook' },
};

const HELP_FLAG_EXPLANATIONS = {
  '--after': 'claiming waits until those items are verified',
  '--brief': 'what a cold agent needs',
  '--check': 'the command that proves it',
  '--family': 'records the family name',
  '--json': 'prints one versioned document',
  '--note': 'what was checked stays with the receipt',
  '--note-file': 'keeps quotes, $ and backticks intact',
  '--route': 'sets which work the model can take',
};

/** Build command-specific help rows from the preserved full list so its syntax stays authoritative. */
function commandHelpRows(fullHelp) {
  const lines = fullHelp.split('\n');
  const rows = [];
  for (let index = 0; index < lines.length; index += 1) {
    if (!lines[index].startsWith('  pullboard ')) continue;
    const details = [lines[index].trim()];
    for (let next = index + 1; next < lines.length && lines[next].startsWith(' ') && lines[next].trim() && !lines[next].startsWith('  pullboard '); next += 1) details.push(lines[next].trim());
    rows.push({ usage: lines[index].trim().slice('pullboard '.length).split(/\s{2,}/, 1)[0].trim(), details });
  }
  return Object.fromEntries(HELP_NAMES.map((name) => {
    const parts = name.split(' ');
    const alias = HELP_ALIASES[name];
    const matches = alias?.source ? rows.filter((row) => row.usage === alias.source || row.usage.startsWith(`${alias.source} `)) : alias ? [] : rows.filter((row) => {
      const tokens = row.usage.split(/\s+/u);
      if (!parts.every((part, index) => tokens[index] === part)) return false;
      const next = tokens[parts.length];
      return !next || next.startsWith('--') || next.startsWith('<') || next.startsWith('[') || next === '|';
    });
    const usages = alias ? [alias.usage] : matches.length ? [...new Set(matches.map((row) => `pullboard ${row.usage}`))] : [`pullboard ${name}`];
    const foundFlags = [...matches.flatMap((row) => row.details.flatMap((line) => line.match(/--[a-z][a-z-]*(?:\s+(?:<[^>]+>|"[^"]*"|\[[^\]]+\]|[A-Za-z][A-Za-z0-9|_-]*))?/gu) ?? [])), ...(alias?.extraFlags ?? []), '--json', '--help', ...(name === 'help' ? ['--all'] : [])];
    const flagMap = new Map();
    for (const flag of foundFlags) {
      const key = flag.split(/\s/u, 1)[0];
      if (alias?.onlyFlags && !alias.onlyFlags.includes(key) && !['--json', '--help'].includes(key)) continue;
      if (!flagMap.has(key) || flagMap.get(key).length < flag.length) flagMap.set(key, flag);
    }
    const flags = [...flagMap.values()].map((flag) => {
      const explanation = HELP_FLAG_EXPLANATIONS[flag.split(/\s/u, 1)[0]];
      return explanation ? `${flag} — ${explanation}` : flag;
    });
    const example = exampleFor(name, usages[0]);
    return [name, Object.freeze({ usages, flags, example })];
  }));
}

/** Render the short first-run overview, with command names grouped by when a person needs them. */
function overviewHelp(groups, firstRun = false) {
  const pointer = 'New here? pullboard tour, then pullboard init.';
  const description = 'Pullboard is a local-first work board for coding agents; nothing ships until a second agent verifies it.';
  const lines = [
    ...(firstRun ? [pointer, description] : [description, pointer]),
    '',
  ];
  for (const [group, names] of groups) lines.push(group, ...names.map((name) => `  pullboard ${name}`));
  lines.push('', 'More: pullboard help <command>; pullboard help --all for the full list.');
  return lines.join('\n');
}

/** The one help declaration feeds the overview, command detail, JSON result and unchanged full list. */
export const HELP = Object.freeze({
  overview: overviewHelp(HELP_GROUPS),
  firstRun: overviewHelp(HELP_GROUPS, true),
  all: ALL_HELP,
  groups: HELP_GROUPS,
  commands: Object.freeze(commandHelpRows(ALL_HELP)),
});

/** Find the nearest declared command for a useful typo hint. */
function closestHelpCommand(input) {
  const needle = input.toLowerCase();
  /** Measure edit distance between two command names for a useful typo hint. */
  const distance = (left, right) => {
    let row = Array.from({ length: right.length + 1 }, (_, index) => index);
    for (let i = 1; i <= left.length; i += 1) {
      const next = [i];
      for (let j = 1; j <= right.length; j += 1) {
        next[j] = Math.min(next[j - 1] + 1, row[j] + 1, row[j - 1] + (left[i - 1] === right[j - 1] ? 0 : 1));
      }
      row = next;
    }
    return row.at(-1);
  };
  return Object.keys(HELP.commands).sort((a, b) => distance(needle, a) - distance(needle, b) || a.localeCompare(b))[0];
}

/** Render one command's usage, one-line flags and a pasteable example from the help declaration. */
function commandHelp(name) {
  const entry = HELP.commands[name];
  if (!entry) return null;
  return [
    `Usage: ${entry.usages[0]}`,
    ...entry.usages.slice(1).map((usage) => `       ${usage}`),
    'Flags:',
    ...(entry.flags.length ? entry.flags.map((flag) => `  ${flag}`) : ['  none']),
    'Example:',
    `  ${entry.example}`,
  ].join('\n');
}

/** Replace help placeholders with ordinary values so every command receives a usable example. */
function exampleFor(name, usage) {
  if (HELP_EXAMPLES[name]) return HELP_EXAMPLES[name];
  return usage.split(/\s+\|\s+|\|/u, 1)[0]
    .replace(/\s+\[[^\]]+\]/gu, '')
    .replace(/<lane>/gu, 'web')
    .replace(/<title>/gu, '"Example"')
    .replace(/<id>/gu, '12')
    .replace(/<file>/gu, 'board.json')
    .replace(/<path>/gu, 'src/cli.js')
    .replace(/<commit>/gu, '0123456')
    .replace(/<principal>/gu, 'person@example.invalid')
    .replace(/<[^>]+>/gu, 'value');
}

/** Write a selected help view in text and the stable help:string JSON field. */
function printHelp(io, text) {
  io.result?.({ help: text });
  io.say(text);
  return 0;
}

/** Refuse an unknown command with its nearest declared spelling and a route to the full list. */
function unknownCommand(io, input) {
  const closest = closestHelpCommand(input);
  io.err(`pullboard: no command "${input}"; closest match is "${closest}". Run pullboard help --all for the full list.`);
  return 2;
}

/** Resolve overview, command detail or the preserved full list from one invocation. */
function selectedHelp(command, first, second, rest, values) {
  if (command === 'help') {
    if (values.all) return { text: HELP.all };
    const requested = [first, second, ...rest].filter(Boolean).join(' ');
    if (!requested || values.help && !first) return { text: HELP.overview };
    return { name: requested, text: commandHelp(requested) };
  }
  if (values.all && (!command || command === 'help')) return { text: HELP.all };
  if (!command) return { text: HELP.firstRun };
  if (values.help) {
    const words = [command, first, second, ...rest].filter(Boolean);
    const candidates = words.map((_, index) => words.slice(0, index + 1).join(' ')).filter((name) => HELP.commands[name]);
    const nested = candidates.at(-1) ?? command;
    return { name: nested, text: commandHelp(nested) };
  }
  return null;
}

const OPTIONS = {
  criterion: { type: 'string' },
  specs: { type: 'string' },
  parent: { type: 'string' },
  reason: { type: 'string' },
  off: { type: 'boolean' },
  port: { type: 'string' },
  export: { type: 'string' },
  'no-open': { type: 'boolean' },
  note: { type: 'string' },
  'note-file': { type: 'string' },
  by: { type: 'string' },
  key: { type: 'string' },
  out: { type: 'string' },
  after: { type: 'string' },
  brief: { type: 'string' },
  'brief-file': { type: 'string' },
  text: { type: 'string' },
  route: { type: 'string' },
  family: { type: 'string' },
  as: { type: 'string' },
  check: { type: 'string' },
  yes: { type: 'boolean' },
  agent: { type: 'string' },
  'agent-light': { type: 'string' },
  'agent-mid': { type: 'string' },
  'agent-strong': { type: 'string' },
  attempts: { type: 'string' },
  minutes: { type: 'string' },
  items: { type: 'string' },
  run: { type: 'string' },
  max: { type: 'string' },
  'dry-run': { type: 'boolean' },
  before: { type: 'string' },
  add: { type: 'string' },
  remove: { type: 'string' },
  name: { type: 'string' },
  url: { type: 'string' },
  wait: { type: 'string' },
  verify: { type: 'boolean' },
  build: { type: 'boolean' },
  all: { type: 'boolean' },
  must: { type: 'boolean' },
  json: { type: 'boolean' },
  history: { type: 'boolean' },
  decision: { type: 'boolean' },
  evidence: { type: 'string' },
  outcome: { type: 'string' },
  item: { type: 'string' },
  commit: { type: 'string' },
  ref: { type: 'string' },
  supersedes: { type: 'string' },
  help: { type: 'boolean', short: 'h' },
  version: { type: 'boolean', short: 'v' },
};

/**
 * A positive whole number from an argument, or a refusal naming what was expected.
 *
 * @param {string | undefined} text
 * @param {string} what
 * @returns {number}
 */
function idArg(text, what = 'an item id') {
  const id = Number(String(text ?? '').replace(/^#/, ''));
  if (!Number.isInteger(id) || id < 1) throw new Refused('USAGE', `expected ${what}, got "${text ?? ''}"`);
  return id;
}

/**
 * A comma list of spec ids from a flag.
 *
 * @param {string | undefined} text
 * @returns {string[]}
 */
const idList = (text) => (text ?? '').split(',').map((id) => id.trim()).filter(Boolean);

/**
 * Text a command was given as --<name> "..." or as --<name>-file <file>, or undefined when neither.
 * A file carries text past the shell exactly: backticks, dollar signs and quotes included.
 *
 * @param {any} io
 * @param {any} values
 * @param {string} name
 * @returns {string | undefined}
 */
function textArg(io, values, name) {
  const path = values[`${name}-file`];
  if (values[name] !== undefined && path !== undefined) {
    throw new Refused('USAGE', `give the ${name} once: --${name} "..." or --${name}-file <file>`);
  }
  if (path === undefined) return values[name];
  const file = resolve(io.cwd, path);
  if (!existsSync(file)) throw new Refused('NO_FILE', `no file ${path}`);
  return readFileSync(file, 'utf8');
}

/**
 * The brief a command was given, from --brief or --brief-file.
 *
 * @param {any} io
 * @param {any} values
 * @returns {string | undefined}
 */
const briefArg = (io, values) => textArg(io, values, 'brief');

/**
 * The start of a command an agent can paste anywhere: agent shells often start each command in the
 * main checkout, so every command pullboard suggests names its folder (I5).
 *
 * @param {string} root
 * @returns {string}
 */
const shellWord = (text) => (/^[\w@%+=:,./-]+$/.test(text) ? text : `'${text.replaceAll("'", "'\\''")}'`);

/**
 * `cd <folder> &&`, the folder quoted for any POSIX shell: single quotes, so a space, a quote or a
 * dollar sign in the path reaches cd as written (I7).
 *
 * @param {string} root
 * @returns {string}
 */
const cdTo = (root) => `cd ${shellWord(root)} &&`;

/**
 * Verifying from the main checkout files the verdict as the coordinator's (V9). An agent whose
 * shell started there would be taken for the coordinator, so the coordinator says so explicitly
 * and anyone else is sent back to a worktree.
 *
 * @param {any} ctx
 * @param {any} board
 * @param {any} values
 */
function checkMainVerifier(ctx, board, values) {
  if (values.as !== undefined && values.as !== COORDINATOR) throw new Refused('USAGE', '--as takes one value: coordinator');
  if (!ctx.info.isMain) {
    if (values.as) throw new Refused('USAGE', '--as coordinator works only in the main checkout; here you are the agent this worktree joined as');
    return;
  }
  if (values.as === COORDINATOR) return;
  const agents = store.listAgents(board).filter((agent) => agent.agent_id !== COORDINATOR);
  const listed = agents.length ? ` Agent worktrees: ${agents.slice(0, 6).map((agent) => `${agent.agent_id} at ${agent.agent_path}`).join('; ')}.` : '';
  const detached = tryGit(ctx.info.root, ['symbolic-ref', '-q', 'HEAD']).status !== 0 ? ' The main checkout is not on its branch; whoever switched it puts it back.' : '';
  throw new Refused(
    'MAIN_IS_COORDINATOR',
    `this is the main checkout, so this verdict would be the coordinator's. An agent verifies from its own worktree, starting every command with cd <worktree> &&.${listed}${detached} The coordinator adds --as coordinator`,
  );
}

/**
 * Select the person actor only through the main checkout's explicit person mode (B26).
 *
 * @param {any} ctx
 * @param {{ id: string }} me
 * @param {{ as?: string }} values
 * @returns {boolean}
 */
function personMode(ctx, me, values) {
  if (values.as === undefined) return false;
  if (values.as !== 'person') throw new Refused('USAGE', '--as person is supported for answer and decisions');
  if (!ctx.info.isMain || me.id !== COORDINATOR) {
    throw new Refused('B26_PERSON_ANSWER', 'only the main checkout can act as the person; ask your coordinator to answer or pass this decision');
  }
  return true;
}

/**
 * A brief whose Files section stays inside the item's lane (B14), so a builder working from it
 * never runs into the lane check: an item's files sit in its lane.
 *
 * @param {any} ctx
 * @param {string} lane
 * @param {string} brief
 * @returns {string}
 */
function briefInLane(ctx, lane, brief) {
  const foreign = outOfLane(ctx.config, lane, briefFiles(brief));
  if (foreign.length) {
    throw new Refused('BRIEF_LANE', `the brief names files outside the ${lane} lane: ${foreign.join(', ')}; split the item by lane, or wait on the other lane's item with --after`);
  }
  return brief;
}

/**
 * Print an item's brief, indented under a heading, when it has one.
 *
 * @param {any} io
 * @param {string} brief
 */
function sayBrief(io, brief) {
  if (!brief) return;
  io.say('brief:');
  brief.split('\n').forEach((line) => io.say(`  ${line}`.trimEnd()));
}

/**
 * Everything a command needs: the repo, its config, the board's file, and where output goes.
 *
 * @param {any} io
 * @returns {any}
 */
function context(io) {
  const info = repoInfo(io.cwd);
  const config = configHere(info);
  const file = join(info.commonDir, 'pullboard', 'board.sqlite');
  return { info, config, file, doctrine: loadDoctrine(info.root, config), io, clock: io.clock ?? store.systemClock };
}

/**
 * This checkout's config. Init is the fix only where pullboard never was (C4): a config deleted
 * from a checkout whose last commit has it is restored, and a linked worktree made from a commit
 * that lacks it, beside a main checkout that has one, is made again from there.
 *
 * @param {{ root: string, commonDir: string, isMain: boolean }} info
 * @returns {any}
 */
function configHere(info) {
  try {
    return loadConfig(info.root);
  } catch (error) {
    if (!(error instanceof Refused) || error.code !== 'NO_CONFIG') throw error;
    if (tryGit(info.root, ['cat-file', '-e', `HEAD:${CONFIG_FILE}`]).status === 0) {
      throw new Refused('NO_CONFIG', `${CONFIG_FILE} is deleted here, though this checkout's last commit has it: restore it: ${cdTo(info.root)} git checkout HEAD -- ${CONFIG_FILE}`);
    }
    const mainRoot = resolve(info.commonDir, '..');
    if (info.isMain || !existsSync(join(mainRoot, CONFIG_FILE))) throw error;
    throw new Refused(
      'NO_CONFIG',
      `this worktree's commit has no ${CONFIG_FILE}, though the main checkout has one: make a new worktree from the main checkout, which says what to commit first: ${cdTo(mainRoot)} pullboard worktree <lane>`,
    );
  }
}

/**
 * Open the board, run `work`, and always close it.
 *
 * @template T
 * @param {any} ctx
 * @param {(board: any) => T} work
 * @returns {T}
 */
function withBoard(ctx, work) {
  const board = store.openBoard(ctx.file, ctx.clock);
  const firstEvent = board.emittedEvents?.length ?? 0;
  /** Forward committed events before releasing either synchronous or asynchronous work. */
  const finish = () => {
    for (const event of board.emittedEvents?.slice(firstEvent) ?? []) ctx.io.onEvent?.(event);
    store.closeBoard(board);
  };
  let result;
  try { result = work(board); }
  catch (error) { finish(); throw error; }
  if (result && typeof result.then === 'function') return result.finally(finish);
  finish();
  return result;
}

/** Dispatch a board mutation locally, or seal it before any linked replica applies it. */
async function ordered(ctx, board, operation, args) {
  const command = ['add', 'edit', 'merged'].includes(ctx.io.relayCommand?.cliOperation) ? ctx.io.relayCommand : undefined;
  return relayLinked(ctx.info.root)
    ? relayOperation(ctx.info.root, operation, args, ctx.io, command)
    : store[operation](board, ...args);
}

/**
 * Who is asking: the coordinator in the main checkout, or the agent this worktree joined as.
 *
 * @param {any} ctx
 * @param {any} board
 * @returns {{ id: string, lane: string, route?: string, family: string | null }}
 */
function whoAmI(ctx, board) {
  if (ctx.info.isMain) {
    const registered = board.db.prepare('SELECT * FROM agent WHERE agent_id=?').get(COORDINATOR);
    const linked = relayLinked(ctx.info.root);
    if (linked && !registered) throw new Refused('NO_AGENT', 'the linked snapshot has no coordinator; restore a consistent relay snapshot before acting');
    const id = linked ? COORDINATOR : store.ensureCoordinator(board, ctx.info.root);
    const agent = registered ?? store.agentAt(board, ctx.info.root);
    return { id, lane: COORDINATOR, family: agent?.agent_family ?? null };
  }
  const agent = store.agentAt(board, ctx.info.root);
  if (!agent) {
    throw new Refused('NOT_JOINED', 'this worktree has not joined a lane: pullboard join <lane> (see: pullboard lanes)');
  }
  return { id: agent.agent_id, lane: agent.agent_lane, route: agent.agent_route, family: agent.agent_family ?? null };
}

/**
 * The criterion an item is held to, frozen from the spec as it reads now.
 *
 * @param {any} ctx
 * @returns {(item: any) => { text: string, digest: string }}
 */
const freezer = (ctx) => (item) => {
  const prior = item.item_frozen ? JSON.parse(item.item_frozen) : null;
  const policy = prior?.policy ?? (!prior && !(ctx.info.isMain && !headCommit(ctx.info.root)) ? { version: 1, commit: mainPolicy(ctx.info.root).commit } : null);
  const config = policy ? itemPolicy(ctx.info.root, { ...item, item_frozen: JSON.stringify({ policy }) }).config : ctx.config;
  const frozen = frozenCriterion(loadSpec(ctx.info.root, config), item);
  if (!policy) return frozen; // Legacy criteria retain their original digest and committed claim base.
  const text = JSON.stringify({ ...JSON.parse(frozen.text), policy });
  return { text, digest: createHash('sha256').update(text).digest('hex') };
};

/**
 * The evidence a shout carries, from its flags (B22). The commit is resolved here, in this repo,
 * so the board only ever stores a full SHA that names a real commit.
 *
 * @param {any} ctx
 * @param {any} values
 * @returns {{ kind: string, outcome: string, item: number, commit: string }}
 */
function evidenceFrom(ctx, values) {
  const rev = values.commit ?? '';
  const resolved = rev ? tryGit(ctx.info.root, ['rev-parse', '--verify', '--quiet', `${rev}^{commit}`]) : { status: 1, stdout: '' };
  if (resolved.status !== 0) throw new Refused('BAD_EVIDENCE', `evidence names a commit in this repo: --commit <rev> (saw "${rev}")`);
  const item = /^\d+$/.test(values.item ?? '') ? Number(values.item) : NaN;
  return { kind: values.evidence, outcome: values.outcome ?? '', item, commit: resolved.stdout };
}

/**
 * A shout's evidence as one line: its kind, outcome, item and commit (B22).
 *
 * @param {any} shout
 * @returns {string}
 */
const evidenceLine = (shout) => `${shout.shout_evidence_kind}: ${shout.shout_evidence_outcome}, #${shout.shout_evidence_item} at ${shout.shout_evidence_commit.slice(0, 12)}`;

/** How many characters of an earlier verdict's note show prints (N30). */
const NOTE_LINE = 120;

/**
 * A note's first line, cut to NOTE_LINE characters with … marking the cut. A line ends at any break
 * Unicode makes mandatory (UAX #14): LF, VT, FF, CR, CRLF, NEL, LS and PS. Characters are counted
 * as a reader sees them, so a cut never splits an emoji or an accented letter.
 *
 * @param {string} note
 * @returns {string}
 */
function firstLineOf(note) {
  const line = note.split(/[\n\v\f\r\x85\u2028\u2029]/)[0];
  const characters = [...new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(line)];
  return characters.length > NOTE_LINE ? `${characters.slice(0, NOTE_LINE).map((part) => part.segment).join('')}…` : line;
}

/**
 * One item on one line: id, status and holder, lane, title, spec ids.
 *
 * @param {any} item
 * @returns {string}
 */
function itemLine(item) {
  const holder = item.item_status === 'claimed' ? ` ${item.item_owner}` : '';
  const verifier = item.item_status === 'verified' ? ` by ${item.item_verified_by}` : '';
  const specs = item.item_spec_ids ? `  [${item.item_spec_ids}]` : '';
  const parent = item.item_parent_id ? `  under #${item.item_parent_id}` : '';
  const after = item.item_after ? `  after ${item.item_after.split(',').map((id) => `#${id}`).join(',')}` : '';
  const rejected = item.item_status === 'open' && item.item_verdict === 'REJECT' ? ' (rejected)' : '';
  const light = item.item_route === 'strong' ? '' : `  ${item.item_route}`;
  return `#${item.item_id}  ${item.item_status}${holder}${verifier}${rejected}  ${item.item_lane}  ${item.item_title}${specs}${parent}${after}${light}`;
}

/**
 * The files an agent has been working in (N20): what its latest three items touched, and what is
 * uncommitted in its worktree now.
 *
 * @param {any} ctx
 * @param {any} board
 * @param {{ id: string }} me
 * @returns {string[]}
 */
function warmFiles(ctx, board, me) {
  const recent = store
    .listItems(board, { all: true })
    .filter((item) => item.item_built_by === me.id)
    .sort((first, second) => second.item_updated_at.localeCompare(first.item_updated_at))
    .slice(0, 3)
    .flatMap((item) => store.itemFiles(item));
  return [...new Set([...recent, ...dirtyFiles(ctx.info.root)])];
}

/**
 * The paths with uncommitted changes in a worktree, untracked files included.
 *
 * @param {string} root
 * @returns {string[]}
 */
function dirtyFiles(root) {
  return tryGit(root, ['status', '--porcelain', '--untracked-files=all']).stdout.split('\n').filter(Boolean).map((line) => line.slice(3));
}

/**
 * The files an item's own commits changed since its claim (N21). First parents only, so main merged
 * into a lane branch is not counted as the item's work; and nothing another item submitted, such as
 * a verified dependency fast-forwarded in, which merges no commit to skip.
 *
 * @param {string} root
 * @param {number} id
 * @param {string | null} from
 * @param {string} to
 * @returns {string[]}
 */
function filesSince(root, id, from, to) {
  if (!from) return [];
  const others = [`--exclude=refs/pullboard/items/${id}/*`, '--glob=refs/pullboard/items/*'];
  const result = tryGit(root, ['log', '--first-parent', '--no-merges', '--format=', '--name-only', to, '--not', from, ...others]);
  return result.status === 0 ? [...new Set(result.stdout.split('\n').filter(Boolean))].sort() : [];
}

/**
 * How long ago an ISO time was, or how long until it, in the board's clock: 45m, 3h, 2d.
 *
 * @param {any} ctx
 * @param {string} iso
 * @returns {string}
 */
function span(ctx, iso) {
  const minutes = Math.round(Math.abs(ctx.clock.now().getTime() - Date.parse(iso)) / 60_000);
  if (minutes < 60) return `${minutes}m`;
  if (minutes < 48 * 60) return `${Math.round(minutes / 60)}h`;
  return `${Math.round(minutes / 1440)}d`;
}

/**
 * A shout's text cut to one short line.
 *
 * @param {string} text
 * @returns {string}
 */
const firstLine = (text) => {
  const line = String(text).split('\n')[0];
  return line.length > 100 ? `${line.slice(0, 99)}…` : line;
};

/** The next step for an agent holding a claim: build it and submit. */
const buildNext = (card) => `build #${card.holding[0].item_id}, commit, then pullboard submit ${card.holding[0].item_id}`;

/** The next step for an agent whose work came back: rework it. */
const reworkNext = (card) => `pullboard claim ${card.sentBack[0].item.item_id}, fix what the verifier found, and submit again`;

/**
 * The coordinator's next step, from the board and the spec (N32): the spec with the person first,
 * then its own work in hand, then verdicts, merges, builders and the plan, so an agent that runs the
 * team by the run guide always knows where it is. Nothing jumps the spec, not even its own claim.
 *
 * @param {any} card
 * @param {{ id: string, status: string }[]} rows
 * @returns {string}
 */
function coordinatorNext(card, rows) {
  if (card.requests.length) return `answer request #${card.requests[0].shout_id}: pullboard answer ${card.requests[0].shout_id} done, or declined <reason>`;
  const live = rows.filter((row) => !['wont', 'retired'].includes(row.status));
  if (!live.length) return "turn what the person wants into spec rows with them: the pullboard-decompose skill (pullboard prompt decompose)";
  const approved = live.filter((row) => row.status === 'approved');
  if (!approved.length) return 'the person approves rows in SPEC.md; then plan them: the pullboard-plan skill';
  if (card.holding.length) return buildNext(card);
  if (card.sentBack.length) return reworkNext(card);
  if (card.toVerify.length) return 'pullboard next --verify --as coordinator, or a verifier that built nothing: pullboard worktree review';
  if (card.toMerge.length) {
    const [first] = card.toMerge;
    return `merge #${first.item_id}: git merge --no-edit ${first.item_commit.slice(0, 12)}, run the gate, then pullboard merged ${first.item_id} <merge commit>`;
  }
  if (card.open.length) {
    const lanes = [...new Set(card.open.map((item) => item.item_lane))];
    return `start a builder for each lane with open items (${lanes.join(', ')}): pullboard worktree <lane>, then the pullboard-run skill`;
  }
  const cited = new Set(card.all.flatMap((item) => (item.item_spec_ids ?? '').split(',').filter(Boolean)));
  const unplanned = approved.filter((row) => !cited.has(row.id));
  if (unplanned.length) {
    return `plan the approved rows no item cites (${unplanned.slice(0, 4).map((row) => row.id).join(', ')}${unplanned.length > 4 ? ', ...' : ''}): the pullboard-plan skill`;
  }
  return 'nothing open: report what was built to the person, or curate the queue: pullboard add, edit, hold';
}

/**
 * `pullboard resume` (N19): one short card that puts an agent back to work after a fresh start,
 * a restart or a compaction, from the board rather than from a summary.
 *
 * @param {any} io
 * @returns {number}
 */
function resumeHere(io) {
  const ctx = context(io);
  const { root, isMain } = ctx.info;
  const card = withBoard(ctx, (board) => {
    const me = whoAmI(ctx, board);
    const all = store.listItems(board, { all: true });
    return {
      me,
      all,
      requests: me.id === COORDINATOR ? store.openRequests(board) : [],
      holding: all.filter((item) => item.item_status === 'claimed' && item.item_owner === me.id),
      sentBack: all
        .filter((item) => item.item_status === 'open' && item.item_verdict === 'REJECT' && item.item_built_by === me.id)
        .map((item) => ({ item, verdict: store.verdictsFor(board, item.item_id).at(-1) })),
      awaiting: all.filter((item) => item.item_status === 'submitted' && item.item_built_by === me.id),
      toVerify: all.filter((item) => item.item_status === 'submitted' && item.item_built_by !== me.id),
      toMerge: all.filter((item) => item.item_status === 'verified' && !item.item_merged_commit),
      open: all.filter((item) => item.item_status === 'open'),
      hold: store.laneHold(board, me.lane),
      holds: store.laneHolds(board),
      unread: store.unreadCount(board, me.id),
      newest: store.peekShouts(board, me.id, 1),
    };
  });
  const { me } = card;
  card.stale = staleFrozenItems(card.all, loadSpec(root, ctx.config).rows).map((item) => ({ ...item, ...staleItemFinding(item) }));
  const say = (line) => io.say(line);
  const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;
  say(`resume: ${me.id}${me.family ? ` (${me.family})` : ''}, ${me.lane} lane${isMain ? ', the main checkout' : ''}, at ${root}`);
  const dirty = dirtyFiles(root).length;
  if (!isMain) {
    const branch = tryGit(root, ['rev-parse', '--abbrev-ref', 'HEAD']).stdout || 'HEAD';
    // Against the main checkout's branch, not its HEAD, which is detached while the coordinator verifies.
    const mainRef = /^branch (.+)$/m.exec(tryGit(root, ['worktree', 'list', '--porcelain']).stdout.split('\n\n')[0])?.[1];
    const [behind = 0, ahead = 0] = mainRef ? tryGit(root, ['rev-list', '--left-right', '--count', `${mainRef}...HEAD`]).stdout.split(/\s+/).map(Number) : [];
    const against = mainRef ? `${ahead} ahead of main, ${behind} behind${behind ? ' (merge main before you submit)' : ''}` : 'main is detached for a verification, so ahead and behind are unknown';
    say(`branch ${branch}: ${against}${dirty ? `; ${plural(dirty, 'file')} uncommitted` : ''}`);
  } else if (dirty) {
    say(`${plural(dirty, 'file')} uncommitted in the main checkout`);
  }
  for (const request of card.requests) say(`request #${request.shout_id}: ${request.shout_text}; answer with pullboard answer ${request.shout_id} done, or declined <reason>`);
  for (const item of card.holding) {
    say(`holding #${item.item_id} ${item.item_title}, lease ${span(ctx, item.item_lease_until)} left${item.item_check ? `; check: ${item.item_check}` : ''}`);
    const files = briefFiles(item.item_brief);
    if (files.length) say(`  files: ${files.join(', ')}`);
  }
  for (const { item, verdict } of card.sentBack) {
    say(`sent back: #${item.item_id} ${verdict ? `${verdict.verdict_reason} by ${verdict.verdict_by}: ${firstLine(verdict.verdict_note)}` : 'rejected'}`);
  }
  for (const item of card.stale) say(`stale: ${item.message}; next: ${item.next}`);
  if (card.awaiting.length) say(`awaiting a verdict: ${card.awaiting.map((item) => `#${item.item_id} (${span(ctx, item.item_updated_at)})`).join(', ')}`);
  if (isMain) {
    if (card.toVerify.length) say(`to verify: ${card.toVerify.map((item) => `#${item.item_id} ${item.item_lane} (${span(ctx, item.item_updated_at)})`).join(', ')}`);
    if (card.toMerge.length) say(`verified, not merged: ${card.toMerge.map((item) => `#${item.item_id} at ${item.item_commit.slice(0, 12)}`).join(', ')}; pullboard merged <id> <commit> records each`);
    for (const hold of card.holds) say(`held: the ${hold.hold_lane} lane, ${hold.hold_reason}`);
    const byLane = Object.entries(Map.groupBy(card.open, (item) => item.item_lane)).map(([lane, items]) => `${lane} ${items.length}`);
    say(`open: ${card.open.length}${byLane.length ? ` (${byLane.join(', ')})` : ''}`);
  } else if (card.hold) {
    say(`the ${me.lane} lane is held by ${card.hold.hold_by}: ${card.hold.hold_reason}`);
  }
  if (card.unread) say(`${plural(card.unread, 'unread shout')}; newest from ${card.newest[0].shout_from}: ${firstLine(card.newest[0].shout_text)} (pullboard inbox reads them)`);
  const inLane = card.open.filter((item) => item.item_lane === me.lane);
  const isVerified = (id) => card.all.find((other) => other.item_id === Number(id))?.item_status === 'verified';
  const ready = inLane.filter((item) => !item.item_after || item.item_after.split(',').every(isVerified)).length;
  let next;
  if (isMain) next = coordinatorNext(card, loadSpec(root, ctx.config).rows);
  else if (card.holding.length) next = buildNext(card);
  else if (card.sentBack.length) next = reworkNext(card);
  else if (card.hold) next = 'wait for the hold to lift: pullboard next --wait 9 (minutes)';
  else if (ready) next = `pullboard next (${ready} ready in your lane)`;
  else if (inLane.length) next = `pullboard next --wait 9 (minutes); ${inLane.length} in your lane ${inLane.length === 1 ? 'waits' : 'wait'} on other work`;
  else if (card.awaiting.length) next = 'pullboard next --wait 9 (minutes); a rejected item comes back to your lane';
  else next = 'nothing open in your lane; pullboard next --verify names work you can check';
  io.result?.({ ...card, root, dirty, next });
  say(`next: ${next}`);
  return 0;
}

/**
 * \`pullboard view\` (N26): serve the micro site for every project on this machine until stopped,
 * registering the repo it starts in, and open it in the browser unless asked not to. With --export,
 * write the current board's read-only static snapshot instead, and return its folder.
 *
 * @param {any} io
 * @param {any} values
 * @returns {Promise<number>}
 */
async function viewHere(io, values) {
  if (values.export !== undefined) {
    const exported = await exportView(io.cwd, resolve(io.cwd, values.export));
    io.result?.(exported);
    io.say(`wrote snapshot ${exported.path}`);
    return 0;
  }
  try {
    const info = repoInfo(io.cwd);
    if (info.isMain && existsSync(join(info.root, CONFIG_FILE))) registerProject(info.root, new Date(), loadConfig(info.root));
  } catch (error) {
    if (!(error instanceof Refused)) throw error;
  }
  const port = values.port === undefined ? 0 : Number(values.port);
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Refused('USAGE', '--port is a number from 0 to 65535; 0 picks a free one');
  const view = await serveView({ port });
  io.result?.({ url: view.url, port: view.port });
  io.say(`Pullboard view: ${view.url}`);
  io.say('Only this machine can reach it, and only with that link. Ctrl-C stops it.');
  io.flush?.(0);
  if (!values['no-open']) {
    const opener = process.platform === 'darwin' ? ['open', [view.url]] : process.platform === 'win32' ? ['cmd', ['/c', 'start', '', view.url]] : ['xdg-open', [view.url]];
    spawn(opener[0], opener[1], { detached: true, stdio: 'ignore' }).on('error', () => {}).unref();
  }
  await new Promise((stop) => {
    process.once('SIGINT', stop);
    process.once('SIGTERM', stop);
  });
  await view.close();
  return 0;
}

/** Serve API v1 until a shutdown signal, printing its address before waiting (A2). */
async function serveHere(io, values) {
  const ctx = context(io);
  const mainRoot = git(ctx.info.root, ['worktree', 'list', '--porcelain']).split('\n')[0].slice('worktree '.length);
  registerProject(mainRoot, new Date(), loadConfig(mainRoot));
  const port = values.port === undefined ? 0 : Number(values.port);
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Refused('USAGE', '--port is a number from 0 to 65535; use 0 to choose a free one');
  const api = await serveApi({ port, runCommand: main });
  io.result?.({ url: api.url, port: api.port });
  io.say(`Pullboard API v1: ${api.url}`);
  io.say('Only this machine can reach it, with its session secret. Ctrl-C stops it.');
  io.flush?.(0);
  await new Promise((stop) => {
    const stopped = () => { process.off('SIGINT', stopped); process.off('SIGTERM', stopped); stop(); };
    process.once('SIGINT', stopped);
    process.once('SIGTERM', stopped);
  });
  await api.close();
  return 0;
}

/**
 * The commands that set a repo or a worktree up.
 *
 * @param {any} io
 * @param {{ first?: string }} args
 * @returns {Record<string, () => number>}
 */
function setupCommands(io, { first, values }) {
  return {
    init: () => {
      const info = repoInfo(io.cwd);
      const notes = initRepo({
        info,
        openBoardHere: () => store.openBoard(join(info.commonDir, 'pullboard', 'board.sqlite'), io.clock),
        /** Keep a linked coordinator's canonical identity without writing a clone-local path. */
        register: (board, options) => {
          if (!relayLinked(info.root)) return store.register(board, options);
          if (!board.db.prepare('SELECT 1 FROM agent WHERE agent_id=?').get(COORDINATOR)) {
            throw new Refused('NO_AGENT', 'the linked snapshot has no coordinator; restore a consistent relay snapshot before initializing');
          }
          return COORDINATOR;
        },
        closeBoard: store.closeBoard,
      });
      io.result?.({ root: info.root, notes });
      const staging = notes.at(-1)?.startsWith('git add -f -- ') ? notes.at(-1) : null;
      (staging ? notes.slice(0, -1) : notes).forEach((note) => io.say(note));
      if (registerProject(info.root, new Date(), loadConfig(info.root))) io.say('registered this project on this machine, so pullboard view lists it');
      io.say('next: write SPEC.md rows, declare lanes in pullboard.json, then: pullboard add <lane> <title>');
      io.say('with an agent: start a new Claude Code session here, which loads the pullboard skills, then tell it what to build; the pullboard-run skill runs the team');
      if (staging) io.say(staging);
      return 0;
    },
    hooks: () => {
      const notes = installHooks(repoInfo(io.cwd).root);
      io.result?.({ notes });
      notes.forEach((note) => io.say(note));
      return 0;
    },
    join: async () => {
      const ctx = context(io);
      if (ctx.info.isMain) throw new Refused('MAIN_IS_COORDINATOR', 'the main checkout is the coordinator; join from a worktree: git worktree add ../<dir>');
      if (!first || first === COORDINATOR || !isLane(ctx.config, first)) {
        throw new Refused('NO_LANE', `no lane "${first ?? ''}"; lanes: ${laneNames(ctx.config).slice(1).join(', ') || 'none yet, declare them in pullboard.json'}`);
      }
      const route = values.route ?? 'strong';
      const id = await withBoard(ctx, async (board) => await ordered(ctx, board, 'register', [{ lane: first, path: ctx.info.root, route, family: values.family }]));
      io.result?.({ agent: id, lane: first, route, path: ctx.info.root });
      io.say(`joined as ${id} in the ${first} lane${route === 'light' ? ', on the light route' : ''}`);
      return 0;
    },
    worktree: () => worktreeFor(io, first, values.route ?? 'strong', values.family ?? null),
  };
}

/**
 * Make a worktree for a new agent in a lane, beside the main checkout, on its own branch, already
 * joined: one command where a new agent would otherwise copy three with placeholders in them.
 *
 * @param {any} io
 * @param {string | undefined} lane
 * @param {string} route
 * @param {string | null} family
 * @returns {Promise<number>}
 */
async function worktreeFor(io, lane, route, family = null) {
  const ctx = context(io);
  if (!lane || lane === COORDINATOR || !isLane(ctx.config, lane)) {
    throw new Refused('NO_LANE', `no lane "${lane ?? ''}"; lanes: ${laneNames(ctx.config).slice(1).join(', ') || 'none yet, declare them in pullboard.json'}`);
  }
  if (!store.ROUTES.includes(route)) {
    throw new Refused('BAD_ROUTE', `route "${route}" is strong (needs a frontier model) or light (any model can build it from the brief)`);
  }
  const mainRoot = resolve(ctx.info.commonDir, '..');
  refuseUncommittedSetup(mainRoot, ctx.config);
  const pathFor = (n) => join(dirname(mainRoot), `${basename(mainRoot)}-${lane}-${n}`);
  const isTaken = (n) => existsSync(pathFor(n)) || tryGit(mainRoot, ['rev-parse', '--verify', '--quiet', `refs/heads/${lane}/${n}`]).status === 0;
  let n = 1;
  while (isTaken(n)) n += 1;
  git(mainRoot, ['worktree', 'add', '-q', '-b', `${lane}/${n}`, pathFor(n), git(mainRoot, ['rev-parse', 'HEAD'])]);
  const root = git(pathFor(n), ['rev-parse', '--show-toplevel']);
  let id;
  try { id = await withBoard(ctx, async (board) => await ordered(ctx, board, 'register', [{ lane, path: root, route, family }])); }
  catch (error) {
    // Only remove the clean worktree just created here; preserve it if another process changed it.
    const removed = tryGit(mainRoot, ['worktree', 'remove', root]);
    if (removed.status === 0) tryGit(mainRoot, ['branch', '-d', `${lane}/${n}`]);
    else io.err(`pullboard: registration failed; the changed worktree was preserved at ${root}`);
    throw error;
  }
  io.result?.({ agent: id, lane, route, path: root, branch: `${lane}/${n}`, prompt: `You are ${id}, in the ${lane} lane. Work only in ${shellWord(root)}, and start every command with ${cdTo(root)}\nRead ${shellWord(join(root, 'AGENTS.md'))} first. Its rules govern this work, over any other repo's instructions you were given.` });
  io.say(`made ${root} on branch ${lane}/${n}, joined as ${id} in the ${lane} lane${route === 'light' ? ', on the light route' : ''}${family ? ` (${family})` : ''}`);
  io.say(`Work only in that folder. A shell that starts each command in the main checkout acts as the coordinator there, so start every command with: ${cdTo(root)}`);
  if (existsSync(join(root, 'package.json'))) io.say(`  ${cdTo(root)} npm install    (its own install, so its tests run its own code)`);
  io.say(`  ${cdTo(root)} pullboard inbox`);
  io.say(`  ${cdTo(root)} pullboard next`);
  // A subagent inherits the instructions of the session that launched it, often another repo's (I7).
  io.say('For a subagent working here, begin its prompt with:');
  io.say(`  You are ${id}, in the ${lane} lane. Work only in ${shellWord(root)}, and start every command with ${cdTo(root)}`);
  io.say(`  Read ${shellWord(join(root, 'AGENTS.md'))} first. Its rules govern this work, over any other repo's instructions you were given.`);
  return 0;
}

/**
 * The files a new worktree takes from the main checkout's last commit and works by: the config, the
 * spec, the practice file, the rules its opening lines name, and the hooks, when git looks for them
 * inside each worktree.
 *
 * @param {string} mainRoot
 * @param {any} config
 * @returns {string[]}
 */
function setupFiles(mainRoot, config) {
  const hooks = tryGit(mainRoot, ['config', '--get', 'core.hooksPath']).stdout;
  const inEach = hooks && !isAbsolute(hooks) && !relative(mainRoot, resolve(mainRoot, hooks)).startsWith('..');
  return [CONFIG_FILE, config.spec, config.practice, 'AGENTS.md', ...(inEach ? [hooks] : [])].filter(Boolean);
}

/**
 * Refuse a worktree whose agent would start without pullboard's files as the main checkout has
 * them: no config, rules or hooks, or older ones (I4). Name each file and how it differs, and the
 * command that commits just those (C4).
 *
 * @param {string} mainRoot
 * @param {any} config
 */
function refuseUncommittedSetup(mainRoot, config) {
  const hasCommit = headCommit(mainRoot) !== null;
  const differ = differFromHead(mainRoot, setupFiles(mainRoot, config));
  if (hasCommit && !differ.length) return;
  const why = hasCommit
    ? `a new worktree starts from the last commit, and these differ from it here: ${differ.map(({ path, how }) => `${path} (${how})`).join(', ')}`
    : `this repo has no commit yet, and a new worktree starts from one; not committed: ${differ.map(({ path, ignored }) => (ignored ? `${path} (git ignores it)` : path)).join(', ')}`;
  const words = differ.map(({ path }) => shellWord(path)).join(' ');
  // No commit holds a file git ignores unless it is added by force.
  const force = differ.some(({ ignored }) => ignored) ? ' -f' : '';
  const subject = hasCommit ? 'chore: commit pullboard files' : 'chore: set up pullboard';
  throw new Refused('NOT_COMMITTED', `${why}. Commit them first: ${cdTo(mainRoot)} git add${force} -- ${words} && git commit -q -m "${subject}" -- ${words}`);
}

/**
 * The commands that read the board without changing it.
 *
 * @param {any} io
 * @param {any} args
 * @returns {Record<string, () => number>}
 */
function readCommands(io, { first, second, rest, values }) {
  return {
    export: () => {
      if (first) throw new Refused('USAGE', 'pullboard export takes no arguments');
      const ctx = context(io);
      io.say(JSON.stringify(withBoard(ctx, (board) => exportBoard(board)), null, 2));
      return 0;
    },
    import: () => {
      if (!first || second || rest.length) throw new Refused('USAGE', 'pullboard import <file>');
      const file = resolve(io.cwd, first);
      if (!existsSync(file)) throw new Refused('NO_FILE', `no export file ${first}`);
      let document;
      try {
        document = JSON.parse(readFileSync(file, 'utf8'));
      } catch {
        throw new Refused('IMPORT_FORMAT', `file ${first} is not a JSON export; use pullboard export to make one`);
      }
      const ctx = context(io);
      const imported = withBoard(ctx, (board) => importBoard(board, document));
      io.result?.({ tables: imported.tables });
      io.say(`imported version ${document.version} board tables: ${imported.tables.join(', ')}`);
      return 0;
    },
    resources: () => {
      const ctx = context(io);
      const resources = [
        ...listResources({ scope: 'machine' }).map((resource) => ({ ...resource, scope: 'machine' })),
        ...listResources({ scope: 'repo', root: ctx.info.root }).map((resource) => ({ ...resource, scope: 'repo' })),
      ];
      io.result?.({ resources });
      if (!resources.length) io.say('no resources have been used');
      for (const resource of resources) {
        io.say(`${resource.name} (${resource.scope}, capacity ${resource.capacity})`);
        for (const holder of resource.holders) io.say(`  held by ${holder.agent}${holder.repo ? ` in ${holder.repo}` : ''} since ${holder.since}`);
        resource.line.forEach((waiter, index) => io.say(`  ${index + 1}. waiting: ${waiter.agent}${waiter.repo ? ` in ${waiter.repo}` : ''}`));
      }
      return 0;
    },
    resume: () => resumeHere(io),
    whoami: () => {
      const ctx = context(io);
      const me = withBoard(ctx, (board) => whoAmI(ctx, board));
      io.result?.({ ...me, path: ctx.info.root });
      io.say(`${me.id} (${me.lane} lane${me.route === 'light' ? ', light route' : ''}) at ${ctx.info.root}`);
      return 0;
    },
    lanes: () => {
      const { config } = context(io);
      io.result?.({ lanes: config.lanes, shared: config.shared, coordinator: COORDINATOR });
      io.say(`${COORDINATOR.padEnd(14)} everything no lane owns; verifies, merges, may change any path`);
      for (const [name, lane] of Object.entries(config.lanes)) {
        const specs = lane.specs?.length ? `  [${lane.specs.join(', ')}]` : '';
        const starts = lane.starts ? `  starts: ${lane.starts}` : '';
        io.say(`${name.padEnd(14)} ${lane.owns.length ? lane.owns.join(' ') : '(owns no folders)'}${specs}${starts}`);
      }
      if (config.shared.length) io.say(`${'shared'.padEnd(14)} ${config.shared.join(' ')} (any lane)`);
      return 0;
    },
    list: () => {
      const ctx = context(io);
      const items = withBoard(ctx, (board) => store.listItems(board, { lane: first, all: values.all }))
        .filter((item) => !values.route || item.item_route === values.route);
      if (values.json) io.result({ items });
      else if (!items.length) io.say(values.all ? 'no items yet' : 'nothing open; --all shows closed items');
      else items.forEach((item) => io.say(itemLine(item)));
      return 0;
    },
    roadmap: () => {
      if (first || second || rest.length) throw new Refused('USAGE', 'pullboard roadmap takes no arguments');
      const ctx = context(io);
      const milestones = withBoard(ctx, (board) => milestoneRoadmap(ctx.info.root, board));
      io.result?.({ milestones });
      if (!milestones.length) io.say('no milestones yet; the coordinator can add one with pullboard milestone add');
      for (const milestone of milestones) {
        io.say(`${milestone.name}: ${milestone.done}/${milestone.total} done`);
        if (milestone.note) io.say(`  ${milestone.note}`);
        for (const item of milestone.items) {
          const id = typeof item.id === 'number' ? `#${item.id}` : item.id;
          io.say(`  ${id} ${item.title} — ${item.status}`);
        }
      }
      return 0;
    },
    show: () => {
      const ctx = context(io);
      const id = idArg(first);
      const { item, verdicts, moves, thread, related, reviewer } = withBoard(ctx, (board) => ({
        item: store.getItem(board, id),
        verdicts: store.verdictsFor(board, id),
        moves: store.events(board, { itemId: id }).filter((event) => ['attempt', 'escalate'].includes(event.event_kind)),
        thread: store.itemThread(board, id),
        related: store.relatedItems(board, store.getItem(board, id)),
        reviewer: store.reviewHolder(board, store.getItem(board, id)),
      }));
      if (values.json) {
        io.result({ ...item, verdicts, thread });
        return 0;
      }
      io.say(itemLine(item));
      if (item.item_criterion) io.say(`criterion: ${item.item_criterion}`);
      if (item.item_check) io.say(`check: ${item.item_check}`);
      sayCheckBaseline(io, item);
      sayBrief(io, item.item_brief);
      for (const { item: other, shared } of related) {
        io.say(`related: #${other.item_id} ${other.item_title}: ${shared.slice(0, 4).join(', ')}${shared.length > 4 ? ', ...' : ''} (git log -p -1 ${other.item_commit.slice(0, 12)} -- ${shared[0]})`);
      }
      const attempts = moves.filter((event) => event.event_kind === 'attempt').map((event) => JSON.parse(event.event_detail).result);
      if (attempts.length) io.say(`unattended attempts: ${attempts.join(', ')}`);
      for (const event of moves.filter((entry) => entry.event_kind === 'escalate')) {
        const detail = JSON.parse(event.event_detail);
        io.say(`escalated ${detail.from} -> ${detail.to} by ${event.event_by}${detail.attempt ? `, pinned at ${detail.attempt}` : ''}: ${detail.note.split('\n')[0]}`);
      }
      if (item.item_frozen) {
        const frozen = JSON.parse(item.item_frozen);
        io.say(`frozen at claim (${item.item_frozen_digest.slice(0, 12)}):`);
        frozen.rows.forEach((row) => io.say(`  ${row.id}: ${row.text}${row.gate ? `  | gate: ${row.gate}` : ''}`));
      }
      if (item.item_commit) io.say(`submitted by ${item.item_built_by}${item.item_builder_family ? ` (${item.item_builder_family})` : ''} at ${item.item_commit}`);
      if (reviewer) io.say(`under review by ${reviewer} until ${item.item_review_until}`);
      // Earlier verdicts as one line each, so an item sent back several times stays short to read
      // (N30); --history prints every note in full.
      const verdictLine = (verdict) => `${verdict.verdict_decision} ${verdict.verdict_reason} by ${verdict.verdict_by}${verdict.verdict_verifier_family ? ` (${verdict.verdict_verifier_family})` : ''} at ${verdict.verdict_commit.slice(0, 12)}`;
      const notes = verdicts.map((verdict, index) => (values.history || index === verdicts.length - 1 ? verdict.verdict_note : firstLineOf(verdict.verdict_note)));
      verdicts.forEach((verdict, index) => {
        io.say(`${verdictLine(verdict)}${notes[index] ? `: ${notes[index]}` : ''}`);
        io.say(`  check: ${verdict.check ?? 'unknown'}`);
      });
      if (notes.some((note, index) => note !== verdicts[index].verdict_note)) io.say(`(earlier verdicts shortened; every note in full: pullboard show ${id} --history)`);
      if (item.item_merged_commit) io.say(`merged as ${item.item_merged_commit}`);
      if (item.item_withdrawn_reason) io.say(`withdrawn: ${item.item_withdrawn_reason}`);
      io.say('thread:');
      for (const entry of thread) {
        const stamp = `  ${entry.at}  ${entry.by}  `;
        if (entry.type === 'fact') {
          io.say(`${stamp}fact ${entry.kind} ${entry.id}${entry.supersedes ? ' (supersedes ' + entry.supersedes + ')' : ''}: ${entry.text}`);
          if (entry.ref) io.say(`    ref: ${entry.ref.path}:${entry.ref.start}${entry.ref.end === entry.ref.start ? '' : '-' + entry.ref.end}@${entry.ref.commit}`);
        } else {
          const detail = entry.detail;
          io.say(`${stamp}${entry.kind}${detail.commit ? ' at ' + detail.commit : ''}${detail.reason ? ': ' + detail.reason : ''}`);
        }
      }
      return 0;
    },
    status: () => {
      const ctx = context(io);
      const summary = withBoard(ctx, (board) => {
        const me = whoAmI(ctx, board);
        const mine = store.listItems(board).filter((item) => item.item_status === 'claimed' && item.item_owner === me.id);
        return { me, mine, stats: store.stats(board), reviewQueue: store.reviewQueue(board), unread: store.unreadCount(board, me.id), relay: relayStatus(ctx.info.root) };
      });
      if (values.json) {
        io.result(summary);
        return 0;
      }
      if (summary.relay.linked) io.say(`relay: sequence ${summary.relay.sequence}; ${summary.relay.behind} pending uploads`);
      const { items, accepted, rejected } = summary.stats;
      io.say(`${summary.me.id}: ${summary.unread} unread shouts; holding ${summary.mine.map((item) => `#${item.item_id}`).join(', ') || 'nothing'}`);
      io.say(`board: ${items.open} open, ${items.claimed} claimed, ${items.submitted} awaiting verification, ${items.verified} verified, ${items.withdrawn} withdrawn`);
      io.say(`verdicts: ${accepted} accepted, ${rejected} rejected`);
      io.say(reviewQueueLine(ctx, summary.reviewQueue));
      if (Object.keys(ctx.config.products).length) {
        const all = withBoard(ctx, (board) => store.listItems(board, { all: true }));
        productSummaries(ctx.config, loadSpec(ctx.info.root, ctx.config), all).forEach((product) => io.say(productLine(product)));
      }
      return 0;
    },
    doctor: () => {
      const bare = bareWorktreeFinding(io.cwd);
      if (bare) {
        const problems = [bare];
        io.result?.({ problems });
        for (const problem of problems) io.say(`problem: ${problem.message}; repair: ${problem.next}`);
        return 1;
      }
      const ctx = context(io);
      const problems = [...doctorProblems(ctx.file, ctx.info.root, tryGit, ctx.config), ...doctrineProblems(ctx.info.root, ctx.config)];
      io.result?.({ problems });
      if (!problems.length) {
        io.say('board is clean');
        return 0;
      }
      for (const problem of problems) io.say(`problem: ${problem.message}; repair: ${problem.next}`);
      return 1;
    },
    inbox: () => {
      const ctx = context(io);
      const shouts = withBoard(ctx, (board) => store.inbox(board, whoAmI(ctx, board).id));
      io.result?.({ shouts });
      if (!shouts.length) io.say('no new shouts');
      for (const shout of shouts) {
        const ask = shout.shout_decision ? `asks for a decision (#${shout.shout_id}; pullboard answer ${shout.shout_id} "..."): ` : '';
        const reply = shout.shout_answers ? `answers #${shout.shout_answers}: ` : '';
        io.say(`${shout.shout_at.slice(0, 16)}  ${shout.shout_from} -> ${shout.shout_to}: ${ask}${reply}${shout.shout_text}`);
        if (shout.shout_evidence_kind) io.say(`  ${evidenceLine(shout)}`);
      }
      return 0;
    },
    decisions: () => {
      const ctx = context(io);
      const asks = withBoard(ctx, (board) => {
        const me = whoAmI(ctx, board);
        const asPerson = personMode(ctx, me, values);
        return store.openDecisions(board, asPerson ? 'person' : [me.id, me.lane]);
      });
      io.result?.({ decisions: asks });
      if (!asks.length) io.say('no open decisions');
      for (const ask of asks) io.say(`#${ask.shout_id}  ${ask.shout_from} -> ${ask.shout_to}, ${span(ctx, ask.shout_at)} ago: ${firstLine(ask.shout_text)}`);
      return 0;
    },
    ledger: () => {
      const ctx = context(io);
      const { items, stats } = withBoard(ctx, (board) => ({
        items: store.listItems(board, { all: true }).map((item) => ({
          ...item,
          check: store.verdictsFor(board, item.item_id).at(-1)?.check ?? 'unknown',
        })),
        stats: store.stats(board),
      }));
      const built = items.filter((item) => item.item_built_by && item.item_status !== 'withdrawn').reverse();
      io.result?.({ items: built, stats });
      const cell = (text) => String(text ?? '').replace(/\|/g, '/').replace(/\s+/g, ' ');
      io.say(`${stats.items.verified} verified by a second agent · ${stats.items.submitted} awaiting verification · ${stats.rejected} rejection${stats.rejected === 1 ? '' : 's'} along the way`);
      io.say('');
      io.say('| # | Lane | Item | Spec | Built by | Verified by | Check | Commit | Merged |');
      io.say('| --- | --- | --- | --- | --- | --- | --- | --- | --- |');
      for (const item of built) {
        io.say(`| ${item.item_id} | ${item.item_lane} | ${cell(item.item_title)} | ${cell(item.item_spec_ids)} | ${item.item_built_by} | ${item.item_verified_by ?? ''} | ${item.check === 'none' ? 'unchecked' : item.check} | ${(item.item_commit ?? '').slice(0, 12)} | ${(item.item_merged_commit ?? '').slice(0, 12)} |`);
      }
      return 0;
    },
    log: () => {
      const ctx = context(io);
      const itemId = first ? idArg(first) : undefined;
      const rows = withBoard(ctx, (board) => store.events(board, { itemId }));
      io.result?.({ events: rows });
      rows.forEach((event) => io.say(`${event.event_at.slice(0, 19)}  ${event.event_by.padEnd(14)} ${event.event_kind.padEnd(9)} ${event.item_id ? `#${event.item_id}` : ''} ${event.event_detail === '{}' ? '' : event.event_detail}`.trimEnd()));
      return 0;
    },
  };
}

/**
 * Submit: a clean tree, nothing untracked, the gate green at HEAD, then the board (V4).
 *
 * The cheap checks run before the gate, so a submit that cannot succeed fails fast.
 *
 * @param {any} ctx
 * @param {number} id
 * @returns {Promise<number>}
 */
async function submitHere(ctx, id) {
  const { root } = ctx.info;
  const recovered = relayRecovered(root);
  if (recovered?.operation === 'submit' && recovered.args[0] === id) {
    const me = withBoard(ctx, (board) => whoAmI(ctx, board));
    if (recovered.args[1]?.agentId === me.id) {
      await withBoard(ctx, async (board) => await ordered(ctx, board, 'submit', recovered.args));
      return reportSubmission(ctx, id, recovered.args[1].commit,
        { green: true, report: 'recovered the original submission; its gate ran before the original send' });
    }
  }
  const held = withBoard(ctx, (board) => {
    const me = whoAmI(ctx, board);
    const item = store.getItem(board, id);
    if (item.item_status !== 'claimed' || item.item_owner !== me.id) throw new Refused('NOT_YOURS', 'claim this item before submitting it');
    return item;
  });
  const policy = itemPolicy(root, held);
  const acceptedMain = mainPolicy(root);
  ctx = { ...ctx, config: policy.config };
  const dependencies = withBoard(ctx, board => dependencySnapshots(board.db, held));
  submissionPaths(root, held, headCommit(root), { mainCommit: acceptedMain.commit, dependencies });
  const { me, claimHead } = withBoard(ctx, (board) => {
    const who = whoAmI(ctx, board);
    const item = store.getItem(board, id);
    if (item.item_status !== 'claimed' || item.item_owner !== who.id) {
      throw new Refused('NOT_YOURS', `item #${id} is not claimed by you; claim it first`);
    }
    // A bar that moved since claim can get no verdict (V3), so say so now, not after a verifier's run (V11).
    // A cited row taken out of force (retired, wont) cannot be frozen at all, and says so too.
    if (item.item_frozen_digest) {
      let digest = null;
      let unusable = '';
      try {
        digest = freezer(ctx)(item).digest;
      } catch (error) {
        if (!(error instanceof Refused) || error.code === 'A5_GRAMMAR_VERSION') throw error;
        unusable = error.message.replace(/^\[\w+\] /, '').split(';')[0];
      }
      if (digest !== item.item_frozen_digest) {
        const step = unusable
          ? `the coordinator either restores the row and runs pullboard refreeze ${id}, or withdraws #${id}`
          : `${who.id === COORDINATOR ? '' : 'the coordinator runs '}pullboard refreeze ${id}, then you claim it and submit again`;
        throw new Refused('CRITERIA_CHANGED', `the spec rows #${id} cites changed after it was claimed${unusable ? ` (${unusable})` : ''}, so no verifier could judge it; ${step}`);
      }
    }
    return { me: who, claimHead: item.item_claim_head };
  });
  if (!isClean(root)) throw new Refused('DIRTY', 'commit your changes first; the gate must check what you submit');
  const stray = untracked(root);
  if (stray.length) throw new Refused('UNTRACKED', `commit or ignore ${stray.length} untracked file(s), e.g. ${stray[0]}`);
  const commit = headCommit(root);
  if (!commit) throw new Refused('NO_COMMIT', 'nothing committed yet');
  // Submit runs the gate itself, every time: a stamp from an earlier run is a file any agent can
  // write, so it never stands in for this run (V16). It starts on the commit submitted, and must end
  // on it too. What the gate's own code does in between is the submitted tree's, under review.
  const gate = await runGate(root, ctx.config, { trustStamp: false, onWait: gateWaitReporter(ctx.io) });
  if (!gate.isGreen) throw new Refused('GATE_RED', `the gate is red at ${commit.slice(0, 12)}; fix it, commit, submit again. ${gateReport(gate)}`);
  if (headCommit(root) !== commit || !isClean(root)) {
    throw new Refused(
      'MOVED_DURING_GATE',
      `when the gate ended, HEAD or a tracked file differed from ${commit.slice(0, 12)}, the commit it started on, so the gate did not end on what you would submit; leave the worktree alone until the gate finishes, then submit again`,
    );
  }
  await withBoard(ctx, async (board) => await ordered(ctx, board, 'submit', [id, { agentId: me.id, commit, tree: headTree(root) ?? '', files: filesSince(root, id, claimHead, commit), policyCommit: acceptedMain.commit }]));
  return reportSubmission(ctx, id, commit, { green: gate.isGreen, report: gateReport(gate) });
}

/** Report and pin the original submitted commit, including a recovered acknowledged outcome. */
function reportSubmission(ctx, id, commit, gate) {
  const { root } = ctx.info;
  const pin = `refs/pullboard/items/${id}/${commit.slice(0, 12)}`;
  git(root, ['update-ref', pin, commit]);
  ctx.io.result?.({ id, commit, pin, gate });
  ctx.io.say(`submitted #${id} at ${commit.slice(0, 12)}; ${gate.report}`);
  ctx.io.say(`pinned as ${pin}, so this work can't be lost; keep your worktree until it is merged`);
  ctx.io.say(`next: another agent checks out ${commit.slice(0, 12)} and runs: pullboard verify ${id} accept|reject`);
  return 0;
}

/**
 * Verify from this checkout (V3, V7): the submitted commit must be here, at or under HEAD, and the
 * criterion is re-read from the spec, so a verdict is never given against a moved bar.
 *
 * @param {any} ctx
 * @param {number} id
 * @param {any} args
 * @returns {Promise<number>}
 */
async function verifyHere(ctx, id, { second, values }) {
  const decision = { accept: 'ACCEPT', reject: 'REJECT' }[String(second ?? '').toLowerCase()];
  if (!decision) throw new Refused('USAGE', 'pullboard verify <id> accept, or reject --reason CODE --note "..."');
  const { root } = ctx.info;
  const result = await withBoard(ctx, async (board) => {
    checkMainVerifier(ctx, board, values);
    const me = whoAmI(ctx, board);
    const recovered = relayRecovered(root);
    const previous = recovered?.args[1];
    if (recovered?.operation === 'verify' && recovered.args[0] === id && previous?.agentId === me.id &&
        previous.decision === decision && previous.reason === values.reason &&
        previous.note === (textArg(ctx.io, values, 'note') ?? '')) {
      return await ordered(ctx, board, 'verify', recovered.args);
    }
    const item = store.getItem(board, id);
    if (item.item_status !== 'submitted') {
      throw new Refused('NOT_SUBMITTED', `item #${id} is ${item.item_status}, not submitted`);
    }
    const policy = itemPolicy(root, item);
    ctx = { ...ctx, config: policy.config };
    const head = headCommit(root) ?? '';
    const commit = resolveCommit(root, item.item_commit);
    if (!commit || !contains(root, commit, head)) {
      throw new Refused('NOT_AT_COMMIT', `check out the submitted commit first: ${cdTo(root)} git switch --detach ${item.item_commit.slice(0, 12)}`);
    }
    let digest = 'missing';
    let check;
    try {
      digest = freezer(ctx)(item).digest;
    } catch (error) {
      if (!(error instanceof Refused) || error.code === 'A5_GRAMMAR_VERSION') throw error;
    }
    if (decision === 'ACCEPT') {
      if (digest !== item.item_frozen_digest) throw new Refused('CRITERIA_CHANGED', 'the criterion changed; ask the coordinator to refreeze this item before checking it');
      check = checkAtCommit(root, item);
      if (check.state === 'unverified') throw new Refused('CHECK_UNVERIFIED', `the frozen ${check.stage} could not be verified at the submitted commit; restore the install or check environment, then retry verification; output digest:\n${check.report.replace(/^/gm, '  ')}`);
      if (check.state === 'red') throw new Refused('CHECK_RED', `the frozen item check is red at the submitted commit; check.install may be needed for dependencies; reject with the failing behavior or ask the builder to fix and resubmit; output digest:\n${check.report.replace(/^/gm, '  ')}`);
      const receipt = store.events(board, { itemId: id }).filter(event => event.event_kind === 'submit').map(event => JSON.parse(event.event_detail)).find(event => event.commit === commit);
      submissionPaths(root, item, commit, { mainCommit: receipt?.policyCommit, dependencies: dependencySnapshots(board.db, item) });
    }
    return await ordered(ctx, board, 'verify', [id, {
      agentId: me.id,
      decision,
      reason: values.reason,
      note: textArg(ctx.io, values, 'note') ?? '',
      head,
      digest,
      policy: ctx.config.verify.policy,
      familyPolicy: ctx.config.verify.family,
      ...(decision === 'ACCEPT' ? { check: check.checked ? 'green' : 'none' } : {}),
    }]);
  });
  ctx.io.result?.({ id, ...result });
  ctx.io.say(result.decision === 'ACCEPT'
    ? `verified #${id}: ${result.reason}${result.check === 'none' ? '; no frozen check ran' : ''}`
    : `rejected #${id}: ${result.reason}; it is open again for rework`);
  return 0;
}

/**
 * One loop of `next`: claim the next free item, or reserve the next review (V15). A claim that loses
 * a race to another agent is not an error; the caller looks again. A review is looked for and
 * reserved in one transaction, so it cannot lose that race.
 *
 * @param {any} ctx
 * @param {any} values
 * @returns {{ item?: any, held?: boolean, retry?: boolean, reasons?: string[] }}
 */
async function nextOnce(ctx, values) {
  return await withBoard(ctx, async (board) => {
    if (values.verify) checkMainVerifier(ctx, board, values);
    const me = whoAmI(ctx, board);
    if (values.verify) {
      const reservation = { agentId: me.id, leaseMs: ctx.config.reviewLeaseMs, policy: ctx.config.verify.policy, familyPolicy: ctx.config.verify.family };
      if (values.verifyId !== undefined) {
        return { item: await ordered(ctx, board, 'reserveReview', [idArg(values.verifyId, 'an item id after --verify'), reservation]), reasons: [] };
      }
      return await ordered(ctx, board, 'reserveNextReview', [{ agentId: me.id, lane: me.lane, leaseMs: ctx.config.reviewLeaseMs, policy: ctx.config.verify.policy, familyPolicy: ctx.config.verify.family, runnable: values.runnable, routes: values.routes }]);
    }
    const warm = warmFiles(ctx, board, me);
    const { item, reasons, shared } = store.nextFor(board, { agentId: me.id, lane: me.lane, runnable: values.runnable, routes: values.routes, warm });
    const held = item?.item_status === 'claimed';
    const offer = held ? null : store.reviewOffer(board, { agentId: me.id, lane: me.lane, policy: ctx.config.verify.policy,
      familyPolicy: ctx.config.verify.family, ratio: ctx.config.verify.reviewRatio, runnable: values.runnable, routes: values.routes });
    if (offer && !values.build) return { item: offer.item, offer, build: item ?? null };
    if (!item) return { reasons };
    const reviewSkipped = values.build && !held
      ? { offeredItem: offer?.item.item_id ?? null, ratio: ctx.config.verify.reviewRatio, ...store.reviewQueue(board) } : null;
    try {
      await ordered(ctx, board, 'claim', [item.item_id, { agentId: me.id, lane: me.lane, leaseMs: ctx.config.leaseMs, freeze: freezer(ctx), head: headCommit(ctx.info.root), reviewSkipped }]);
    } catch (error) {
      if (error instanceof Refused && ['HELD', 'BLOCKED', 'ONE_CLAIM'].includes(error.code)) return { retry: true };
      throw error;
    }
    return { item: store.getItem(board, item.item_id), shared, held, reviewSkipped };
  });
}

/** Describe the queue's actual outstanding reviews and submission age [Q1,V15]. */
function reviewQueueLine(ctx, queue) {
  const age = queue.oldestSubmittedAt ? `${span(ctx, queue.oldestSubmittedAt)} ago` : 'none';
  return `review queue: ${queue.pending} awaiting, ${queue.reviewing} agents reviewing; oldest submission ${age}`;
}

/** Print an unreserved review first, then the build available through an explicit opt-out. */
function sayReviewOffer(ctx, found) {
  const command = `pullboard next --verify ${found.item.item_id}${ctx.info.isMain ? ' --as coordinator' : ''}`;
  const offer = { item: found.item.item_id, command, queue: found.offer.queue, ratio: found.offer.ratio };
  ctx.io.result?.({ item: found.item, review: true, held: false, shared: [], offer, build: found.build });
  ctx.io.say(`${reviewQueueLine(ctx, offer.queue)}; ratio ${offer.ratio} reached (zero active reviewers counts as one)`);
  ctx.io.say(`review offered: #${found.item.item_id} ${found.item.item_title}, built by ${found.item.item_built_by}; reserve it explicitly: ${command}`);
  if (found.build) ctx.io.say(`build available: #${found.build.item_id} ${found.build.item_title}; claim it explicitly: pullboard next --build`);
  else ctx.io.say('no build is currently free in your lane; this review is available');
}

/**
 * `pullboard next` (N2): the whole start of an agent's loop in one command. With --wait, it keeps
 * looking until something is free, so an agent blocked on other work needs no polling of its own.
 *
 * @param {any} io
 * @param {any} values
 * @returns {Promise<number>}
 */
async function nextHere(io, values) {
  const ctx = context(io);
  if (values.build && values.verify) throw new Refused('USAGE', 'choose a build or a review: pullboard next --build or pullboard next --verify');
  if (values.verifyId !== undefined && !values.verify) {
    throw new Refused('USAGE', 'give an item id only with --verify: pullboard next --verify <id>');
  }
  if (values.verifyId !== undefined) idArg(values.verifyId, 'an item id after --verify');
  const minutes = values.wait === undefined ? 0 : Number(values.wait);
  if (!Number.isFinite(minutes) || minutes < 0 || minutes > 240) {
    throw new Refused('USAGE', '--wait is a number of minutes from 0 to 240');
  }
  const deadline = Date.now() + minutes * 60_000;
  for (;;) {
    const found = await nextOnce(ctx, values);
    if (found.item) {
      if (found.offer) { sayReviewOffer(ctx, found); return 0; }
      const item = found.item;
      io.result?.({ item, review: Boolean(values.verify), held: Boolean(found.held), shared: found.shared ?? [] });
      const here = cdTo(ctx.info.root);
      const as = ctx.info.isMain ? ' --as coordinator' : '';
      if (values.verify) {
        sayCheckBaseline(io, item);
        io.say(`next to verify: #${item.item_id} ${item.item_title}, built by ${item.item_built_by} at ${item.item_commit.slice(0, 12)}`);
        io.say(`reserved for you until ${item.item_review_until}: another agent's verdict on it is refused until then; pullboard next --verify again renews it`);
        io.say(`check out exactly that commit, here: ${here} git switch --detach ${item.item_commit}`);
        io.say(`then: ${here} pullboard verify ${item.item_id} accept${as} --note "how you proved it", or reject${as} --reason CODE --note "what failed"`);
      } else {
        if (found.reviewSkipped) io.say(`${reviewQueueLine(ctx, found.reviewSkipped)}; explicit build intent recorded with this claim`);
        io.say(`${found.held ? 'you hold' : 'claimed'} #${item.item_id}: ${item.item_title}`);
        if (found.shared?.length) io.say(`it touches ${found.shared.length === 1 ? 'a file' : `${found.shared.length} files`} you worked in recently: ${found.shared.slice(0, 4).join(', ')}`);
        if (item.item_criterion) io.say(`criterion: ${item.item_criterion}`);
        if (item.item_check) io.say(`check: ${item.item_check}   (run it before you submit)`);
        for (const row of item.item_frozen ? JSON.parse(item.item_frozen).rows : []) io.say(`  ${row.id}: ${row.text}`);
        sayBrief(io, item.item_brief);
        io.say(`when it is built and committed: ${here} pullboard submit ${item.item_id}`);
      }
      return 0;
    }
    if (!found.retry && Date.now() >= deadline) {
      const waited = minutes ? ` after ${minutes} minutes` : '';
      io.err(`pullboard: [NOTHING_FREE] ${found.reasons.join('; ')}${waited}. To keep looking: pullboard next --wait 9${values.verify ? ' --verify' : ''} (minutes; give the command a ten-minute timeout)`);
      return 1;
    }
    if (!found.retry) await new Promise((done) => setTimeout(done, 5000));
  }
}

/**
 * `pullboard sweep` (N15, N17): run a checker, then file one routed item per file it flags, each
 * with the problems in its brief and the checker on that file as its check. Each check runs once
 * first, on the file as it is: it must fail there, or it could never prove a fix.
 *
 * @param {any} ctx
 * @param {any} board
 * @param {{ id: string }} me
 * @param {any} values
 * @returns {Promise<number>}
 */
async function sweepHere(ctx, board, me, values) {
  if (me.id !== COORDINATOR) throw new Refused('COORDINATOR_ONLY', 'the coordinator files sweep items, from the main checkout');
  const report = String(values.run ?? '').trim();
  const check = String(values.check ?? '').trim();
  if (!report || !check.includes('{file}')) {
    throw new Refused('USAGE', 'pullboard sweep --run "<checker over the repo>" --check "<the checker on one file, with {file} where its path goes>"');
  }
  const max = values.max === undefined ? 20 : idArg(values.max, 'a number after --max');
  const ran = spawnSync(report, { cwd: ctx.info.root, shell: true, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });
  const problems = parseProblems(`${ran.stdout ?? ''}\n${ran.stderr ?? ''}`, ctx.info.root);
  if (!problems.length) {
    ctx.io.say(`the checker reported no problems I can read (exit ${ran.status}); nothing to file`);
    return 0;
  }
  const covered = new Set(store.listItems(board).filter((item) => item.item_title.startsWith('fix ')).flatMap((item) => briefFiles(item.item_brief)));
  const { items, skipped } = sweepItems(problems, {
    laneOf: (path) => laneOf(ctx.config, path),
    covered,
    check,
    report,
    route: values.route ?? 'light',
    max,
  });
  const blind = [];
  for (const item of items) {
    const canary = spawnSync(item.check, { cwd: ctx.info.root, shell: true, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
    if (canary.status === 0) {
      blind.push(item.file);
      continue;
    }
    if (values['dry-run']) {
      ctx.io.say(`would file: ${item.title} (${item.lane} lane, ${item.route})`);
      continue;
    }
    const id = await ordered(ctx, board, 'addItem', [{ by: me.id, lane: item.lane, title: item.title, criterion: item.criterion, brief: item.brief, route: item.route, check: item.check }]);
    ctx.io.say(`#${id} ${item.title} (${item.lane} lane, ${item.route})`);
  }
  if (skipped.length) ctx.io.say(`already open: ${skipped.join(', ')}`);
  if (blind.length) {
    ctx.io.err(`pullboard: [CHECK_CANNOT_FAIL] the check passes on ${blind.join(', ')} although the checker flags problems there, so it could never prove a fix; not filed. A check ending in a pipe takes its exit status from the last command`);
  }
  const filed = items.length - blind.length;
  ctx.io.say(`${problems.length} problems in ${new Set(problems.map((problem) => problem.file)).size} files; ${values['dry-run'] ? 'would file' : 'filed'} ${filed}`);
  return blind.length ? 1 : 0;
}

/**
 * The commands that change the board.
 *
 * @param {any} io
 * @param {any} args
 * @returns {Record<string, () => number>}
 */
function workCommands(io, args) {
  const { first, second, rest, values } = args;
  const act = (work) => {
    const ctx = context(io);
    return withBoard(ctx, (board) => work(ctx, board, whoAmI(ctx, board)));
  };
  return {
    fact: () => act(async (ctx, board, me) => {
      if (!first || !second || rest.length !== 1) throw new Refused('USAGE', 'pullboard fact <id> <kind> <text> [--supersedes <fact-id>] [--ref path:lines@full-sha]');
      const id = idArg(first);
      const fact = await ordered(ctx, board, 'appendFact', [id, { agentId: me.id, kind: second,
        text: rest[0], supersedes: values.supersedes ?? null, ref: values.ref ?? null }]);
      io.result?.({ item: id, fact });
      io.say(`fact ${fact.id} appended to #${id} as ${fact.kind}`);
      return 0;
    }),
    milestone: () => act(async (ctx, board, me) => {
      const ids = (text) => (text ?? '').split(',').map((value) => value.trim()).filter(Boolean);
      let name;
      let entry;
      if (first === 'add') {
        if (!second || rest.length || values.before !== undefined || values.add !== undefined || values.remove !== undefined || values.name !== undefined) {
          throw new Refused('USAGE', 'pullboard milestone add <name> [--note ...] [--items 1,2,3]');
        }
        name = await ordered(ctx, board, 'addMilestone', [{ agentId: me.id, name: second, note: values.note ?? null, items: ids(values.items) }]);
      } else if (first === 'items') {
        if (!second || rest.length || Boolean(values.add) === Boolean(values.remove) || values.items !== undefined || values.note !== undefined || values.before !== undefined || values.name !== undefined) {
          throw new Refused('USAGE', 'pullboard milestone items <name> --add ids or --remove ids');
        }
        name = second;
        const next = await ordered(ctx, board, 'editMilestoneItems', [name, {
          agentId: me.id,
          add: values.add === undefined ? [] : ids(values.add),
          remove: values.remove === undefined ? [] : ids(values.remove),
        }]);
        entry = { ...store.milestones(board).find((value) => value.name === name), items: next };
      } else if (first === 'move') {
        if (!second || rest.length || !values.before || values.items !== undefined || values.note !== undefined || values.name !== undefined || values.add !== undefined || values.remove !== undefined) {
          throw new Refused('USAGE', 'pullboard milestone move <name> --before <other>');
        }
        name = second;
        await ordered(ctx, board, 'moveMilestone', [name, { agentId: me.id, before: values.before }]);
        entry = store.milestones(board).find((value) => value.name === name);
      } else if (first === 'edit') {
        if (!second || rest.length || (values.name === undefined && values.note === undefined) || values.items !== undefined || values.before !== undefined || values.add !== undefined || values.remove !== undefined) {
          throw new Refused('USAGE', 'pullboard milestone edit <name> [--name <new name>] [--note <text>]');
        }
        name = second;
        entry = await ordered(ctx, board, 'editMilestone', [name, { agentId: me.id, newName: values.name, note: values.note }]);
      } else if (first === 'remove') {
        if (!second || rest.length || values.items !== undefined || values.note !== undefined || values.before !== undefined || values.name !== undefined || values.add !== undefined || values.remove !== undefined) {
          throw new Refused('USAGE', 'pullboard milestone remove <name>');
        }
        name = second;
        await ordered(ctx, board, 'removeMilestone', [name, { agentId: me.id }]);
        entry = { name };
      } else {
        throw new Refused('USAGE', 'use pullboard milestone add, items, move, edit or remove');
      }
      entry ??= store.milestones(board).find((value) => value.name === name);
      io.result?.({ milestone: entry });
      io.say(`milestone ${first === 'remove' ? 'removed' : first === 'add' ? 'added' : 'updated'}: ${name}`);
      return 0;
    }),
    add: () => act(async (ctx, board, me) => {
      const recovered = await relayCommandReceipt(ctx.info.root, io.relayCommand);
      if (recovered) {
        const id = recovered.result;
        io.result?.({ item: store.getItem(board, id) });
        io.say(`#${id}`);
        sayCheckBaseline(io, store.getItem(board, id));
        await relayCommandReceiptReported(ctx.info.root, recovered.move.id);
        return 0;
      }
      if (!first || !isLane(ctx.config, first)) throw new Refused('NO_LANE', `no lane "${first ?? ''}"; see: pullboard lanes`);
      const specIds = idList(values.specs);
      const problems = idProblems(loadSpec(ctx.info.root, ctx.config), specIds);
      if (problems.length) throw new Refused('UNKNOWN_SPEC', `${problems.join('; ')}`);
      const parentId = values.parent ? idArg(values.parent, 'a parent item id') : null;
      const after = idList(values.after).map((text) => idArg(text, 'an item id after --after'));
      const title = [second, ...rest].filter(Boolean).join(' ');
      const item = {
        by: io.personRequest?.phase === 'execute' ? store.PERSON : me.id,
        lane: first,
        title,
        criterion: values.criterion ?? '',
        specIds,
        parentId,
        after,
        brief: briefInLane(ctx, first, briefArg(io, values) ?? ''),
        route: values.route ?? 'strong',
        check: values.check,
      };
      const { command } = store.validateItemAddition(board, item);
      if (command) item.checkBaseline = checkBaseline(ctx.info.root, command);
      const id = await ordered(ctx, board, 'addItem', [item]);
      io.result?.({ item: store.getItem(board, id) });
      io.say(`#${id}`);
      sayCheckBaseline(io, store.getItem(board, id));
      return 0;
    }),
    edit: () => act(async (ctx, board, me) => {
      const id = idArg(first);
      const recovered = await relayCommandReceipt(ctx.info.root, io.relayCommand);
      if (recovered) {
        io.result?.({ item: store.getItem(board, id) });
        io.say(`edited #${id}`);
        sayCheckBaseline(io, store.getItem(board, id));
        await relayCommandReceiptReported(ctx.info.root, recovered.move.id);
        return 0;
      }
      const brief = briefArg(io, values);
      const change = {
        agentId: me.id,
        brief: brief === undefined ? undefined : briefInLane(ctx, store.getItem(board, id).item_lane, brief),
        route: values.route,
        criterion: values.criterion,
        check: values.check,
      };
      const { item, command } = store.validateItemEdit(board, id, change);
      if (command && command !== item.item_check) change.checkBaseline = checkBaseline(ctx.info.root, command);
      await ordered(ctx, board, 'editItem', [id, change]);
      io.result?.({ item: store.getItem(board, id) });
      io.say(`edited #${id}`);
      sayCheckBaseline(io, store.getItem(board, id));
      return 0;
    }),
    escalate: () => act(async (ctx, board, me) => {
      const id = idArg(first);
      const note = textArg(io, values, 'note') ?? '';
      const moved = await ordered(ctx, board, 'escalate', [id, { agentId: me.id, note }]);
      if (me.id !== COORDINATOR) {
        await ordered(ctx, board, 'shout', [{ from: me.id, to: COORDINATOR, text: `#${id} escalated ${moved.from} -> ${moved.to}: ${note}`, lanes: laneNames(ctx.config) }]);
      }
      io.result?.({ id, ...moved });
      io.say(`#${id} escalated ${moved.from} -> ${moved.to}; it is open for a ${moved.to} agent`);
      return 0;
    }),
    run: () => runItems(io, values, { context, withBoard, whoAmI, nextOnce, submitHere, freezer, ordered }),
    sweep: () => act((ctx, board, me) => sweepHere(ctx, board, me, values)),
    next: () => nextHere(io, { ...values, verifyId: first }),
    check: async () => {
      const ctx = context(io);
      const { item, author, caller } = withBoard(ctx, (board) => {
        const me = first ? (ctx.info.isMain ? { id: COORDINATOR } : { id: store.agentAt(board, ctx.info.root)?.agent_id }) : whoAmI(ctx, board);
        const held = first ? store.getItem(board, idArg(first))
          : store.listItems(board).find((entry) => entry.item_status === 'claimed' && entry.item_owner === me.id && entry.item_parent_id === null);
        if (!held) throw new Refused('NOT_HOLDING', 'you hold no item; name one, pullboard check <id>, or run the project gate: pullboard gate');
        return { item: held, author: store.itemCheckAuthor(board, held.item_id), caller: me.id };
      });
      const check = frozenCheck(item);
      if (!check) throw new Refused('NO_CHECK', `#${item.item_id} has no check command; its proof is the project gate: pullboard gate`);
      if (item.item_claim_head) itemPolicy(ctx.info.root, item);
      else mainPolicy(ctx.info.root);
      const by = author || 'unknown (legacy)';
      const notice = `check #${item.item_id} set by ${by}: ${check}`;
      if (values.json) io.stderr.write(`${notice}\n`);
      else io.say(notice);
      if (!values.yes && (!author || author !== caller)) {
        if (values.json) io.stderr.write('Run this check? [y/N]\n');
        else io.err('Run this check? [y/N]');
        const answer = await firstInputLine(io.stdin);
        if (!/^y(?:es)?$/iu.test(answer.trim())) {
          throw new Refused('CHECK_CONFIRM', `the check set by ${by} was not run: ${check}; run pullboard check ${item.item_id} --yes after reading the command, or answer yes at the prompt`);
        }
      }
      const run = runShell(ctx.info.root, check);
      io.result?.({ id: item.item_id, green: run.isGreen, seconds: run.seconds, check, by, report: run.isGreen ? '' : digestOf(run.output) });
      io.say(`check ${run.isGreen ? 'green' : 'red'} in ${run.seconds}s: ${check}`);
      if (!run.isGreen) io.say(digestOf(run.output).replace(/^/gm, '  '));
      return run.isGreen ? 0 : 1;
    },
    claim: () => act(async (ctx, board, me) => {
      const result = await ordered(ctx, board, 'claim', [idArg(first), { agentId: me.id, lane: me.lane, leaseMs: ctx.config.leaseMs, freeze: freezer(ctx), head: headCommit(ctx.info.root) }]);
      io.result?.({ id: idArg(first), ...result });
      io.say(`${result.renewed ? 'renewed' : 'claimed'} #${first} until ${result.leaseUntil}; criterion frozen as ${result.digest.slice(0, 12)}`);
      return 0;
    }),
    hold: () => act(async (ctx, board, me) => {
      if (!first || !isLane(ctx.config, first)) throw new Refused('NO_LANE', `no lane "${first ?? ''}"; see: pullboard lanes`);
      if (values.off) {
        await ordered(ctx, board, 'releaseLane', [first, { agentId: me.id, asPerson: io.personChannel === 'view', channel: io.personChannel ?? 'terminal' }]);
        io.say(`released the ${first} lane`);
      } else {
        await ordered(ctx, board, 'holdLane', [first, { agentId: me.id, reason: values.reason ?? '', asPerson: io.personChannel === 'view', channel: io.personChannel ?? 'terminal' }]);
        io.say(`holding the ${first} lane: ${values.reason}. Release it with: pullboard hold ${first} --off`);
      }
      io.result?.({ lane: first, held: !values.off, reason: values.off ? null : values.reason });
      return 0;
    }),
    release: () => act(async (ctx, board, me) => {
      const review = await ordered(ctx, board, 'release', [idArg(first), me.id]);
      io.result?.({ id: idArg(first) });
      io.say(review ? `released the review of #${first}; the review is free again` : `released #${first}`);
      return 0;
    }),
    submit: async () => submitHere(context(io), idArg(first)),
    done: async () => submitHere(context(io), idArg(first)),
    verify: () => verifyHere(context(io), idArg(first), args),
    merged: () => act(async (ctx, board, me) => {
      const recovered = await relayCommandReceipt(ctx.info.root, io.relayCommand);
      if (recovered) {
        const commit = recovered.move.args[1].commit;
        io.result?.({ id: idArg(first), commit });
        io.say(`#${first} merged as ${commit.slice(0, 12)}`);
        await relayCommandReceiptReported(ctx.info.root, recovered.move.id);
        return 0;
      }
      const commit = resolveCommit(ctx.info.root, second ?? '');
      if (!commit) throw new Refused('NO_COMMIT', `no commit "${second ?? ''}" in this repo`);
      await ordered(ctx, board, 'merged', [idArg(first), { agentId: me.id, commit }]);
      io.result?.({ id: idArg(first), commit });
      io.say(`#${first} merged as ${commit.slice(0, 12)}`);
      return 0;
    }),
    withdraw: () => act(async (ctx, board, me) => {
      await ordered(ctx, board, 'withdraw', [idArg(first), { agentId: me.id, reason: [second, ...rest].filter(Boolean).join(' ') }]);
      io.result?.({ id: idArg(first), reason: [second, ...rest].filter(Boolean).join(' ') });
      io.say(`withdrew #${first}`);
      return 0;
    }),
    refreeze: () => act(async (ctx, board, me) => {
      const result = await ordered(ctx, board, 'refreeze', [idArg(first), { agentId: me.id, freeze: freezer(ctx) }]);
      io.result?.({ id: idArg(first), ...result });
      io.say(`#${first} refrozen ${String(result.before).slice(0, 12)} -> ${result.after.slice(0, 12)}; open again`);
      return 0;
    }),
    shout: () => act(async (ctx, board, me) => {
      const evidence = values.evidence === undefined ? null : evidenceFrom(ctx, values);
      const recipients = ['all', 'person', ...laneNames(ctx.config), ...board.db.prepare('SELECT agent_id FROM agent').all().map((agent) => agent.agent_id)];
      const hasRecipient = first && recipients.includes(first);
      const to = hasRecipient ? first : values.decision ? (me.id === COORDINATOR ? 'person' : COORDINATOR) : first ?? '';
      const text = [hasRecipient ? second : first, ...(hasRecipient ? rest : [second, ...rest])].filter(Boolean).join(' ');
      const id = await ordered(ctx, board, 'shout', [{ from: io.personRequest?.phase === 'execute' ? store.PERSON : me.id, to, text, lanes: laneNames(ctx.config), decision: Boolean(values.decision), evidence }]);
      io.result?.({ id, decision: Boolean(values.decision) });
      io.say(values.decision ? `asked ${to} for a decision as #${id}; it stays open until someone runs: pullboard answer ${id} "<the decision>"` : `shouted to ${to}`);
      return 0;
    }),
    answer: () => act(async (ctx, board, me) => {
      const asPerson = personMode(ctx, me, values);
      if (asPerson) requirePersonChannel(ctx.io.personChannel);
      const id = await ordered(ctx, board, 'answerDecision', [idArg(first), { agentId: me.id, text: [second, ...rest].filter(Boolean).join(' '), lanes: laneNames(ctx.config), asPerson, channel: ctx.io.personChannel ?? 'terminal' }]);
      const ask = store.getShout(board, idArg(first));
      io.result?.({ id, answers: ask.shout_id });
      if (asPerson) {
        const originalAsker = ask.shout_answers === null ? ask.shout_from : store.getShout(board, ask.shout_answers).shout_from;
        io.say(`person answered #${ask.shout_id}; notified ${originalAsker} as #${id}`);
      } else {
        io.say(`answered #${ask.shout_id} to ${ask.shout_from} as #${id}`);
      }
      return 0;
    }),
    pass: () => act(async (ctx, board, me) => {
      const id = await ordered(ctx, board, 'passDecision', [idArg(first), { agentId: me.id, note: [second, ...rest].filter(Boolean).join(' '), lanes: laneNames(ctx.config) }]);
      io.result?.({ id, answers: idArg(first) });
      io.say(`passed #${first} to the person as #${id}`);
      return 0;
    }),
  };
}

/** Build a de-duplicated queue message for a gate waiting on machine capacity. */
function gateWaitReporter(io) {
  let last = '';
  return ({ holders, position }) => {
    const repos = holders.map(({ repo }) => repo).filter(Boolean);
    const message = `gate waiting: ${holders.length} running${repos.length ? ` in ${repos.join(', ')}` : ''}; place ${position}`;
    if (message !== last) {
      io.say(message);
      last = message;
    }
  };
}

/** Read or update machine-wide gate capacity. */
function settingsCommand(io, { first, second, rest }) {
  if (!first && !second && !rest.length) {
    const settings = loadMachineSettings();
    io.result?.({ settings });
    io.say(`gateSlots: ${settings.gateSlots}`);
    return 0;
  }
  if (first !== 'gateSlots' || !second || rest.length || !/^[1-9]\d*$/u.test(second) || !Number.isSafeInteger(Number(second))) {
    throw new Refused('USAGE', 'pullboard settings gateSlots <positive integer>');
  }
  const settings = setGateSlots(Number(second));
  io.result?.({ settings });
  io.say(`gateSlots set to ${settings.gateSlots}`);
  return 0;
}

/**
 * Every spec id something cites (S8): commit headers since the spec's first commit, and every item
 * on the board, open or closed. Each must still be in the spec. The board is shared by every
 * checkout, so at an older commit an item may cite a row a later commit added: that id is not lost
 * here, only not written yet, and it counts once any ref has committed it (S10).
 *
 * @param {any} ctx
 * @param {{ ids: Map<string, string>, since: string | null }} history - this checkout's.
 * @returns {Map<string, string>} Each id, with who cites it.
 */
function citations(ctx, { ids, since }) {
  const cited = since ? commitCitations(ctx.info.root, since) : new Map();
  if (!existsSync(ctx.file)) return cited;
  const byItems = new Map();
  for (const item of withBoard(ctx, (board) => store.listItems(board, { all: true }))) {
    for (const id of item.item_spec_ids ? item.item_spec_ids.split(',') : []) {
      if (!cited.has(id) && !byItems.has(id)) byItems.set(id, `item #${item.item_id}`);
    }
  }
  const unseen = [...byItems.keys()].some((id) => !ids.has(id));
  const elsewhere = unseen ? committedIds(ctx.info.root, ctx.config.spec, ['--all']).ids : new Map();
  for (const [id, where] of byItems) if (ids.has(id) || !elsewhere.has(id)) cited.set(id, where);
  return cited;
}

/** Current board evidence, with each item's accepting receipts included once. */
function specProof(ctx) {
  if (!existsSync(ctx.file)) return { items: [], verdicts: [] };
  return withBoard(ctx, (board) => {
    const items = store.listItems(board, { all: true });
    return { items, verdicts: items.flatMap((item) => store.verdictsFor(board, item.item_id)) };
  });
}

/**
 * The spec commands: reads, sign-offs and person decisions applied by the coordinator.
 *
 * @param {any} io
 * @param {any} args
 * @returns {Promise<number>}
 */
async function specCommand(io, { first, second, rest, values }) {
  const ctx = context(io);
  const commandFlags = {
    '--json': ['json'],
    check: ['json'],
    view: ['out'],
    show: [],
    unmet: ['must'],
    signoff: ['by', 'note', 'note-file'],
    signers: ['key', 'by'],
    approve: ['by', 'text'],
    decline: ['reason'],
    apply: [],
  }[first ?? '--json'];
  if (!commandFlags) throw new Refused('USAGE', 'use pullboard spec --json | check | view | show <id> | unmet [--must] | signoff <ids> | approve <ids> | decline <ids> --reason "why" | apply');
  const allowedFlags = [...new Set([...commandFlags, 'json'])];
  for (const flag of Object.keys(values)) {
    if (!allowedFlags.includes(flag)) {
      const next = flag === 'must' ? 'use --must with spec unmet' : 'use a flag accepted by this spec command';
      throw new Refused('FLAG_NOT_ALLOWED', `spec ${first ?? '--json'} does not take --${flag}; ${next}`);
    }
  }
  const spec = loadSpec(ctx.info.root, ctx.config);
  if (!spec.exists) throw new Refused('NO_SPEC', `no ${ctx.config.spec}; run: pullboard init`);
  const practice = ctx.doctrine;
  const signoffs = readSignoffs(ctx.info.root);
  if (first === 'approve' || first === 'decline') {
    requirePersonChannel(io.personChannel);
    return withBoard(ctx, async (board) => {
      const me = whoAmI(ctx, board);
      if (!ctx.info.isMain || me.id !== COORDINATOR) throw new Refused('B26_PERSON_APPROVAL', 'only the person from the main checkout approves or declines rows; use pullboard view for the person to decide');
      const ids = [second, ...rest].filter(Boolean).flatMap((text) => text.split(/[\s,]+/u)).filter(Boolean);
      const records = prepareRowDecisions(ctx.info.root, ctx.config, { ids, decision: first, reason: values.reason, text: values.text, by: values.by, on: new Date().toISOString(), commit: headCommit(ctx.info.root) ?? '' });
      const decisions = await ordered(ctx, board, 'recordRowDecisions', [{ agentId: store.PERSON, channel: io.personChannel ?? 'terminal', decisions: records }]);
      io.result?.({ decisions });
      decisions.forEach((record) => io.say(`${record.kind === 'doctrine' ? 'doctrine:' : ''}${record.id}: ${first === 'approve' ? 'approved' : 'declined'}, pending apply`));
      return 0;
    });
  }
  if (first === 'apply') {
    if (second || rest.length) throw new Refused('USAGE', 'pullboard spec apply takes no ids; it applies current person decisions');
    return withBoard(ctx, async (board) => {
      const me = whoAmI(ctx, board);
      if (!ctx.info.isMain || me.id !== COORDINATOR) throw new Refused('COORDINATOR_ONLY', 'only the coordinator applies row decisions; ask your coordinator to run pullboard spec apply');
      const plan = planRowApply(ctx.info.root, ctx.config, store.rowDecisions(board));
      writeRowApply(ctx.info.root, plan);
      let applied;
      try { applied = await ordered(ctx, board, 'applyRowDecisions', [{ agentId: me.id, events: plan.records.map((record) => record.event) }]); }
      catch (error) { restoreRowApply(ctx.info.root, plan); throw error; }
      io.result?.({ applied, files: plan.files.map((file) => file.file) });
      applied.forEach((record) => io.say(`${record.file}: ${record.id} ${record.decision === 'approve' ? 'approved' : 'wont'}${record.reason ? `: ${record.reason}` : ''}`));
      if (!applied.length) io.say('no pending row decisions');
      else io.say('stage and commit the changed row files and any .pullboard/signoffs.jsonl receipts');
      return 0;
    });
  }
  if (first === 'check' || first === undefined) {
    const files = [[ctx.config.spec, spec], ...(practice.exists ? [[ctx.config.practice, practice]] : [])];
    for (const [, parsed] of files) assertRequiredSigners(ctx.info.root, parsed.rows);
    let errors = 0;
    const messages = [];
    for (const [name, parsed] of files) {
      const findings = lintSpec(parsed);
      findings.forEach((finding) => messages.push(`${name}:${finding.line} ${finding.id ?? ''} ${finding.level}: ${finding.message}`.replace('  ', ' ')));
      const history = parsed === practice ? doctrineHistory(ctx.info.root, name) : committedIds(ctx.info.root, name);
      const cited = name === ctx.config.spec ? citations(ctx, history) : new Map();
      const lost = permanenceProblems(parsed === practice ? practice.repo : parsed, { committed: history.ids, cited });
      lost.forEach((problem) => messages.push(`${name}: ${problem.id} error: ${problem.message}`));
      const fileErrors = findings.filter((finding) => finding.level === 'error').length + lost.length;
      errors += fileErrors;
      messages.push(`${name}: ${parsed.rows.length} rows, ${fileErrors} errors, ${findings.length + lost.length - fileErrors} warnings`);
    }
    const unnamed = productProblems(ctx.config, spec);
    unnamed.forEach((problem) => messages.push(`${ctx.config.spec}: error: ${problem}`));
    errors += unnamed.length;
    if (values.json && !errors) {
      const rows = files.flatMap(([file, parsed]) => parsed.rows.map(({ id, status, tier, text, gate, serves, signers = [], section, line, origin, version, reason, file: source }) => (
        { id, status, tier, text, gate, serves, signers, section, line, file: source ?? file,
          ...(origin ? { origin, version, reason } : {}) }
      )));
      io.result({ rows });
    } else messages.forEach((message) => io.say(message));
    return errors ? 1 : 0;
  }
  if (first === 'signers' && second === 'add') {
    requirePersonChannel(io.personChannel);
    const signer = addSigner(ctx.info.root, { by: values.by, key: values.key });
    io.result?.(signer);
    io.say(signer.added
      ? signer.initial
        ? `added SSH signer ${signer.by}; stage and commit ${signer.path}, .pullboard/first-commit, and .pullboard/signers.initial`
        : `added SSH signer ${signer.by} to ${signer.path}; commit ${signer.path} and .pullboard/signoffs.jsonl`
      : `${signer.by} is already listed in ${signer.path}`);
    return 0;
  }
  if (first === 'view') {
    const out = values.out ? resolve(ctx.io.cwd, values.out) : join(ctx.info.gitDir, 'pullboard', 'spec.html');
    const html = renderSpecView({
      title: spec.title,
      spec,
      practice,
      signoffs,
      generatedAt: new Date().toISOString().slice(0, 16).replace('T', ' '),
      files: { spec: ctx.config.spec, practice: ctx.config.practice },
    });
    mkdirSync(dirname(out), { recursive: true });
    writeFileSync(out, html);
    io.result?.({ path: out });
    io.say(`wrote ${out}`);
    io.say(`open: ${pathToFileURL(out).href}`);
    return 0;
  }
  if (first === 'show') {
    const doctrineId = second?.startsWith('doctrine:');
    const parsed = doctrineId ? practice : spec;
    const id = doctrineId ? second.slice('doctrine:'.length) : second;
    const source = parsed.rows.find((entry) => entry.id === id);
    const row = source && withBoard(ctx, (board) => decisionProjection(store.rowDecisions(board), source, doctrineId ? 'doctrine' : 'spec'));
    if (!row) throw new Refused('NO_ROW', `no row ${second ?? ''} in ${ctx.config.spec}`);
    const standing = standings(parsed.rows, signoffs).get(row.id) ?? { met: [], stale: [] };
    io.result?.({ row, standing });
    io.say(`${row.id} [${row.status}${row.tier ? `, ${row.tier}` : ''}] ${row.text}`);
    if (row.stage) io.say(row.stage);
    if (row.gate) io.say(`gate: ${row.gate}`);
    if (row.serves.length) io.say(`serves: ${row.serves.join(', ')}`);
    io.say(`signed: ${standing.met.map((entry) => `${entry.by} ${entry.on}`).join(', ') || 'no'}${standing.stale.length ? `; stale: ${standing.stale.length}` : ''}`);
    for (const entry of [...standing.met, ...standing.stale]) if (entry.note) io.say(`note (${entry.by}): ${entry.note}`);
    return 0;
  }
  if (first === 'unmet') {
    const rows = unmetRows(spec.rows, signoffs, { mustOnly: values.must });
    const proof = specProof(ctx);
    const testFiles = citedTestFiles(ctx.info.root);
    const by = standings(spec.rows, signoffs);
    io.result?.({ rows: rows.map((row) => ({ ...row, stage: rowStage(by.get(row.id), rowEvidence(ctx.info.root, row.id, { ...proof, testFiles })) })) });
    rows.forEach((row) => io.say(`${row.id} [${row.tier || 'no tier'}] ${row.text} — ${rowStage(by.get(row.id), rowEvidence(ctx.info.root, row.id, { ...proof, testFiles }))}`));
    io.say(`${rows.length} approved rows without a current sign-off`);
    return 0;
  }
  if (first === 'signoff') {
    requirePersonChannel(io.personChannel);
    const ids = [second, ...rest].filter(Boolean).flatMap((text) => idList(text));
    if (!ids.length) throw new Refused('USAGE', 'pullboard spec signoff <ids> [--by <principal>] [--note "what was checked"]');
    const invalid = ids.filter((id) => spec.rows.find((row) => row.id === id)?.status !== 'approved');
    if (invalid.length) throw new Refused('CANNOT_SIGN', `${invalid.join(', ')}: only approved rows in this spec are signed`);
    const proof = specProof(ctx);
    const testFiles = citedTestFiles(ctx.info.root);
    const evidence = ids.map((id) => ({ id, ...rowEvidence(ctx.info.root, id, { ...proof, testFiles }) }));
    const missing = evidence.filter((row) => !row.files.length && !row.verified.length).map((row) => row.id);
    if (missing.length) throw new Refused('NO_EVIDENCE', `${missing.join(', ')} has no evidence; build it or cite its id in a test first`);
    for (const row of evidence) {
      io.say(`evidence for ${row.id}:`);
      for (const file of row.files) io.say(`  test: ${file}`);
      for (const item of row.verified) io.say(`  verified #${item.id}: ${item.note || '(no accepting note)'}`);
    }
    const note = textArg(io, values, 'note') ?? '';
    const by = values.by ?? (hasSignerFile(ctx.info.root) ? defaultPrincipal(ctx.info.root) : '');
    const count = signOff(ctx.info.root, spec, { ids, by, on: new Date().toISOString(), note, commit: headCommit(ctx.info.root) ?? '' });
    io.result?.({ count, by, ids, evidence });
    io.say(`signed ${count} rows as ${by}; commit .pullboard/signoffs.jsonl`);
    return 0;
  }
  throw new Refused('USAGE', 'pullboard spec --json | check | view | show <id> | unmet [--must] | signoff <ids> | signers add | approve <ids> | decline <ids> --reason "why" | apply');
}

/** Read one consent line without waiting for EOF in an interactive terminal [V2]. */
async function firstInputLine(stdin) {
  if (!stdin) return '';
  let text = '';
  for await (const chunk of stdin) {
    text += chunk.toString();
    const newline = text.indexOf('\n');
    if (newline >= 0) return text.slice(0, newline);
    if (text.length > 256) return '';
  }
  return text;
}

/**
 * Read everything git writes on a hook's stdin, or nothing when run by hand.
 *
 * @param {any} stdin
 * @returns {Promise<string>}
 */
async function readStdin(stdin) {
  if (!stdin || stdin.isTTY) return '';
  const chunks = [];
  for await (const chunk of stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString('utf8');
}

/**
 * The hooks git runs. In a repo without pullboard.json they pass, so a stray hook never blocks.
 *
 * @param {any} io
 * @param {any} args
 * @returns {Promise<number>}
 */
async function hookCommand(io, { first, second }) {
  const info = repoInfo(io.cwd);
  let ctx;
  try {
    ctx = context(io);
  } catch (error) {
    if (error instanceof Refused && error.code === 'NO_CONFIG') return 0;
    throw error;
  }
  let problems = [];
  if (first === 'pre-commit') {
    applyFixers(info.root, ctx.config.fix).forEach((note) => io.err(`pullboard pre-commit: ${note}`));
    const agent = info.isMain ? null : withBoard(ctx, (board) => store.agentAt(board, info.root));
    problems = preCommitProblems({ root: info.root, isMain: info.isMain, config: ctx.config, agent, boardFile: ctx.file });
  } else if (first === 'commit-msg') {
    const message = readFileSync(second ?? '', 'utf8');
    problems = commitMsgProblems(message, { rules: ctx.config.commits, spec: loadSpec(info.root, ctx.config) });
  } else if (first === 'pre-push') {
    problems = prePushProblems(info.root, await readStdin(io.stdin));
    if (!problems.length) {
      const gate = await runGate(info.root, ctx.config, { onWait: gateWaitReporter(io) });
      if (gate.isCached) io.say('pre-push: the gate passed on this exact tree; not running it twice');
      if (!gate.isGreen) problems = [`the gate is red; fix it before pushing. ${gateReport(gate)}`];
    }
  } else {
    throw new Refused('USAGE', 'pullboard hook pre-commit | commit-msg <file> | pre-push');
  }
  if (!problems.length) return 0;
  io.err(`pullboard ${first}: blocked\n${problems.map((problem) => `  - ${problem}`).join('\n')}\n${FIX_NOTE}`);
  return 1;
}

/**
 * Run one command. Returns the exit code: 0 done, 1 refused, 2 usage.
 *
 * @param {string[]} argv
 * @param {any} io
 * @returns {Promise<number>}
 */
async function runCommand(argv, io) {
  let parsed;
  try {
    parsed = parseArgs({ args: argv, options: OPTIONS, allowPositionals: true });
  } catch (error) {
    io.refusal?.(new Refused('USAGE', `${error.message}; run pullboard help`));
    io.err(`pullboard: ${error.message}\nRun pullboard help --all for the full list.`);
    return 2;
  }
  const { values, positionals } = parsed;
  io.jsonMode?.(values.json);
  const [command = '', first, second, ...rest] = positionals;
  if ((values.version || command === 'version') && !values.help) {
    io.result?.({ release: VERSION });
    io.say(VERSION);
    return 0;
  }
  const help = selectedHelp(command, first, second, rest, values);
  if (help) {
    if (help.text) return printHelp(io, help.text);
    return unknownCommand(io, help.name);
  }
  const args = { first, second, rest, values };
  try {
    if (values.as === 'person' && !['answer', 'decisions'].includes(command)) {
      throw new Refused('USAGE', '--as person works only with pullboard answer or decisions');
    }
    if (command === 'tour') return tour(io);
    if (command === 'lifecycle') {
      io.result?.({ markdown: lifecycleMarkdown().trimEnd() });
      io.say(lifecycleMarkdown().trimEnd());
      return 0;
    }
    if (command === 'view') return await viewHere(io, values);
    if (command === 'serve') return await serveHere(io, values);
    if (command === 'forget') {
      if (!first || second) throw new Refused('USAGE', 'pullboard forget <path>');
      const root = resolve(io.cwd, first);
      if (!forgetProject(root)) throw new Refused('NO_REPO', `no registered repo at ${root}; see the projects in pullboard view`);
      io.result?.({ root });
      io.say(`forgot ${root}`);
      return 0;
    }
    if (command === 'spec') return await specCommand(io, args);
    if (command === 'prompt') {
      let root = io.cwd;
      try {
        root = repoInfo(io.cwd).root;
      } catch (error) {
        if (!(error instanceof Refused)) throw error;
      }
      const text = promptFor(root, first ?? '').trimEnd();
      io.result?.({ role: first, text });
      io.say(text);
      return 0;
    }
    if (command === 'hook') return await hookCommand(io, args);
    if (command === 'settings') return settingsCommand(io, args);
    if (command === 'relay') {
      if (second || rest.length || (first && !['on', 'off'].includes(first)) || (values.url && first !== 'on')) throw new Refused('USAGE', 'pullboard relay [on|off] [--url <address>]');
      const ctx = context(io);
      if (!first) { await syncRelay(ctx.info.root, io); await executePersonRequests(ctx.info.root, io, main); }
      const result = first === 'on' ? await relayOn(ctx.info.root, values.url, io)
        : first === 'off' ? await relayOff(ctx.info.root, io) : relayStatus(ctx.info.root);
      io.result?.(result);
      io.say(result.linked ? `${result.link}\nrelay: sequence ${result.sequence}; ${result.behind} pending uploads` : (result.notice || 'relay off; the local board is complete'));
      return 0;
    }
    if (command === 'gate') {
      const ctx = context(io);
      const gate = await runGate(ctx.info.root, mainPolicy(ctx.info.root).config, { onWait: gateWaitReporter(io) });
      io.result?.({ green: gate.isGreen, report: gateReport(gate) });
      io.say(gateReport(gate));
      return gate.isGreen ? 0 : 1;
    }
    const commands = { ...setupCommands(io, args), ...readCommands(io, args), ...workCommands(io, args) };
    const run = commands[command];
    if (!run) return unknownCommand(io, command);
    return await run();
  } catch (error) {
    if (error instanceof Refused) {
      io.refusal?.(error);
      io.err(`pullboard: ${error.message}`);
      return 1;
    }
    throw error;
  }
}

/** Run one command and emit its single versioned JSON result when requested (A1). */
export async function main(argv, streams) {
  const io = commandOutput(argv, streams);
  let sync = true;
  try {
    const parsed = parseArgs({ args: argv, options: OPTIONS, allowPositionals: true });
    const command = parsed.positionals[0];
    io.relayCommand = { cliOperation: command === 'done' ? 'submit' : command, cwd: resolve(io.cwd),
      positionals: parsed.positionals.slice(1),
      values: Object.fromEntries(Object.keys(parsed.values).filter(key => key !== 'json').sort().map(key => [key, parsed.values[key]])) };
    sync = Boolean(command) && !parsed.values.help && !parsed.values.version && !['help', 'version', 'hook', 'init', 'relay', 'tour'].includes(command);
  } catch { sync = false; }
  /** A network refusal preserves offline reads; linked mutation dispatch requires an acknowledgement. */
  const retry = async () => {
    try { await syncRelay(io.cwd, io); }
    catch (error) {
      if (!(error instanceof Refused)) throw error;
      if (!['NOT_A_REPO', 'NO_REPO', 'NO_CONFIG', 'CORE_BARE'].includes(error.code)) io.err(`pullboard: ${error.message}`);
    }
  };
  if (sync) {
    await retry();
    try { await executePersonRequests(io.cwd, io, main); }
    catch (error) {
      if (!(error instanceof Refused)) throw error;
      if (!['NOT_A_REPO', 'NO_REPO', 'NO_CONFIG', 'CORE_BARE'].includes(error.code)) io.err('pullboard: ' + error.message);
    }
  }
  const code = await runCommand(argv, io);
  if (sync && code === 0) await retry();
  io.flush(code);
  return code;
}

/** Result-producing command names, including aliases, for API contract coverage (A1). */
export function resultCommands() {
  const args = { values: {}, rest: [] };
  return [...new Set([
    ...Object.keys(setupCommands({}, args)),
    ...Object.keys(readCommands({}, args)),
    ...Object.keys(workCommands({}, args)),
    'help', 'version', 'tour', 'lifecycle', 'view', 'serve', 'forget', 'spec', 'prompt', 'hook', 'gate', 'settings', 'relay',
  ])].sort();
}
