/** Help declarations and command phrases stay independent of CLI/server initialization [N26]. */
import packageData from '../package.json' with { type: 'json' };
import { lifecycleHelp } from './machine.js';

export const VERSION = packageData.version;

const ALL_HELP = `pullboard ${VERSION}: the local-first work board for teams of coding agents.
Nothing ships until a second agent verifies it.

Set up
  pullboard tour                        see it work: a reject and its rework, scripted, in thirty seconds
  pullboard init                        config, SPEC.md, agent instructions, git hooks, board
  pullboard worktree <lane> [--route light] [--family <name>]   make and join a worktree for a new agent
  pullboard join <lane> [--route light] [--family <name>]       register this worktree as an agent
                                        --route sets which work the model can take; --family records its name
  pullboard whoami | lanes | status     who you are, the lanes, the board at a glance
  pullboard takeover                   rebind this checkout when the same agent starts a new session
  pullboard resources                  local resource holders and their FIFO queues
  pullboard settings [gateSlots <n>]    view or set this machine's gate slots (default 2)
  pullboard view [--port N] [--no-open]  every project on this machine in your browser: items, shouts, doctrine,
                                        agents and activity, live; add items, shout and hold lanes from it
  pullboard view --export <dir>         a read-only snapshot with event replay, for any static host
  pullboard serve [--port N]           local API v1: boards, state, moves, requests and live events,
                                        behind the session secret in its printed address
  pullboard relay [on|off|pair|join <code>] [--url <address>]  link, inspect or unlink this board's sealed relay
                                        on signs in through GitHub; the address defaults to https://app.pullboard.dev
                                        pair prints a one-use machine code; join stores it in another clone
  pullboard relay on --all [--url <address>]  link every registered project after one sign-in; pair the phone once
                                        keep this command open until pairing finishes; later projects link on registration
  pullboard relay devices               list paired device ids and their public-key fingerprints
  pullboard relay revoke <device>       stop future key delivery; already received keys remain known
  pullboard relay tokens                list this board's agent token ids, agents and expiry, never credentials
  pullboard relay revoke <token-id>     revoke one token from that list; other agents keep working
  pullboard relay recover --skip <sequence>  person-only recovery of one blocked next relay position
  pullboard resume                      where you are: your claim, branch, uncommitted work, what came back,
                                        unread shouts, what to do next; run it to start any session
  pullboard hooks                       reinstall the git hooks (e.g. after a fresh clone)

Work
  pullboard add <lane> <title> [--criterion "..."] [--specs G1.2,K3] [--after 3,4] [--parent <id>]
                [--brief "..." | --brief-file <file>] [--route light|mid]
                                        --after: claiming waits until those items are verified
                                        --brief: what a cold agent needs; --route light: any model can build it
                [--check "<command>"] [--wait]   the command that proves it; --wait waits for its main baseline
                                        with --criterion and a brief, --check is needed below strong
  pullboard edit <id> [--brief "..." | --brief-file <file>] [--route light|mid|strong] [--criterion "..."] [--check "..."]
                [--wait]                wait for a new check's baseline; otherwise it runs in the background
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
  pullboard skills --update            refresh unchanged Claude Code skills from shipped versions
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
  pullboard release <id> [--note "why"]  hand it back; a review release needs a one-line reason
  pullboard submit <id>                 needs a clean tree, item check and affected tests green at HEAD (alias: done)
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
  pullboard reopen <id> --note "why"    return a submission for criterion correction without a verdict
  pullboard hold <lane> --reason "..."   pause a lane: next there claims nothing and names the reason
  pullboard hold <id> "reason"          hold one item so next skips it
  pullboard hold <lane|id> --off        lift a lane or item hold

Receipts
  pullboard stats [--since <date>]      proof numbers from the event log; --json for sites and tools
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
  pullboard gate [--landing]            run the configured gate; prioritize a trunk landing in the machine queue
  pullboard hook pre-commit|pre-merge-commit|commit-msg|pre-push   git runs these

${lifecycleHelp()}

Reject reasons: TEST_FAILURE, BEHAVIOR_MISMATCH, INSUFFICIENT_EVIDENCE, STALE_HEAD, OTHER.
--json prints one versioned document for every command; refusals include their code and next step.`;

const HELP_NAMES = [
  'tour', 'init', 'worktree', 'join', 'takeover', 'whoami', 'lanes', 'status', 'resources', 'settings', 'view', 'view export',
  'serve', 'relay', 'relay recover', 'resume', 'hooks', 'add', 'edit', 'escalate', 'run', 'list', 'doctor', 'skills', 'show', 'next',
  'check', 'claim', 'release', 'submit', 'done', 'verify', 'fact', 'shout', 'answer', 'pass', 'decisions', 'inbox', 'export', 'import',
  'sweep', 'merged', 'withdraw', 'refreeze', 'reopen', 'hold', 'stats', 'ledger', 'log', 'spec', 'spec check', 'spec view',
  'spec show', 'spec unmet', 'spec signoff', 'spec signers', 'spec signers add', 'forget', 'prompt', 'gate', 'hook',
  'hook pre-commit', 'hook pre-merge-commit', 'hook commit-msg', 'hook pre-push', 'view export', 'version', 'lifecycle', 'help',
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
  status: 'pullboard status', view: 'pullboard view', stats: 'pullboard stats --since 2026-10-08', log: 'pullboard log 12', ledger: 'pullboard ledger',
  roadmap: 'pullboard roadmap', milestone: 'pullboard milestone add "0.7.0" --items 12,13',
  edit: 'pullboard edit 12 --brief "Add the upload page"', release: 'pullboard release 12',
  reopen: 'pullboard reopen 12 --note "correct the frozen criterion"',
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
  hook: { usage: 'pullboard hook pre-commit|pre-merge-commit|commit-msg|pre-push', source: 'hook' },
  'hook pre-commit': { usage: 'pullboard hook pre-commit', source: 'hook' },
  'hook pre-merge-commit': { usage: 'pullboard hook pre-merge-commit', source: 'hook' },
  'hook commit-msg': { usage: 'pullboard hook commit-msg <file>', source: 'hook' },
  'hook pre-push': { usage: 'pullboard hook pre-push', source: 'hook' },
};

const HELP_FLAG_EXPLANATIONS = {
  '--after': 'claiming waits until those items are verified',
  '--brief': 'what a cold agent needs',
  '--check': 'the command that proves it',
  '--family': 'records the family name',
  '--landing': 'prioritizes a trunk landing in the machine gate queue',
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

/** Read literal command words before an argument, flag or optional segment. */
function commandWords(usage) {
  const words = [];
  for (const word of usage.trim().split(/\s+/u)) {
    if (!/^[a-z][a-z0-9-]*(?:\|[a-z][a-z0-9-]*)*$/u.test(word)) break;
    words.push(word);
  }
  return words;
}

/** Expand literal alternatives in a command phrase without including argument values. */
function expandWords(words) {
  let phrases = [''];
  for (const word of words) phrases = phrases.flatMap(prefix => word.split('|').map(choice => (prefix + ' ' + choice).trim()));
  return phrases.filter(Boolean);
}

/** Read one printed usage, including sibling commands and optional literal subcommands. */
function usagePhrases(usage) {
  const row = usage.replace(/^pullboard\s+/u, '').split(/\s{2,}/u, 1)[0];
  const branches = row.split(/\s+\|\s+/u);
  const first = commandWords(branches[0]);
  const shared = branches.length > 1 ? first.slice(0, -1) : [];
  const phrases = [];
  for (const [index, branch] of branches.entries()) {
    const inherited = index && !/^pullboard\s/u.test(branch) ? shared : [];
    const command = branch.replace(/^pullboard\s+/u, '');
    const words = [...inherited, ...commandWords(command)];
    phrases.push(...expandWords(words));
    const optional = command.match(/^(.*?)\[([^\]]+)\]/u);
    if (optional && optional[2].includes('|') && !optional[2].trim().startsWith('-')) {
      const prefix = [...inherited, ...commandWords(optional[1])];
      for (const choice of optional[2].split('|')) phrases.push(...expandWords([...prefix, ...commandWords(choice)]));
    }
  }
  return phrases;
}

/** Derive every printed command phrase and declared alias, with longer phrases before prefixes. */
export function commandPhrases(help = HELP) {
  const phrases = new Set();
  for (const line of help.all.split('\n')) {
    if (line.startsWith('  pullboard ')) for (const phrase of usagePhrases(line.trim())) phrases.add(phrase);
  }
  for (const [name, declaration] of Object.entries(help.commands)) {
    if (/^[a-z][a-z0-9-]*(?: [a-z][a-z0-9-]*)*$/u.test(name)) phrases.add(name);
    for (const usage of declaration.usages) for (const phrase of usagePhrases(usage)) phrases.add(phrase);
  }
  return [...phrases].sort((left, right) => right.length - left.length || left.localeCompare(right));
}
