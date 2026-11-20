/** Help declarations and command phrases stay independent of CLI/server initialization [N26]. */
import { VERSION } from '../../../../packages/config/index.js';
import { ALL_HELP } from './help/sections.js';
import { RELEASE_REASON_LINES } from './help/work.js';
import { WHY_EXPLANATION } from './why.js';
import { WHY_FLAG } from './why.js';
import { cleanFlag } from './help/flag-meanings.js';
import { describeFlag } from './help/flag-meanings.js';
export { VERSION };


const HELP_GROUPS = [
  ['Start', ['tour', 'init', 'worktree']],
  ['Work', ['add', 'list', 'claim']],
  ['Review', ['submit', 'next', 'verify']],
  ['See', ['status', 'view', 'log']],
];

// The add example runs as pasted on a board init just made, which has no web lane and no G1 row (#721).
const ADD_EXAMPLE = ['pullboard lane add web --owns src/web', 'pullboard spec draft "A person can upload a page"',
  'pullboard add web "Upload page" --specs G1'].join('\n');

const HELP_EXAMPLES = {
  // Real words, so a pasted example does what it says; each runs on a fresh board in help/examples.test.js (#7755).
  shout: 'pullboard shout all "Main is green; pull before you start"',
  withdraw: 'pullboard withdraw 12 "duplicate of #9"',
  search: 'pullboard search "upload page"',
  test: 'pullboard test --affected',
  trace: 'pullboard trace 12 --since 2h',
  sweep: 'pullboard sweep --run "npx eslint ." --check "npx eslint {file}" --dry-run',
  blueprint: 'pullboard blueprint add web-app',
  settings: 'pullboard settings gateSlots 2',
  'settings line': `pullboard settings line reviewsFirst on --reason "reviews are waiting" --window '{"windowMinutes":60}'`,
  'spec approve': 'pullboard spec approve G1',
  'spec decline': 'pullboard spec decline G1 --reason "The requirement needs revision"',
  'sentinel propose': 'pullboard sentinel propose "Run the checks" --check "npm test" --every hourly --owner web',
  tour: 'pullboard tour', init: 'pullboard init --blueprint web-app', worktree: 'pullboard worktree web --model "my-model"',
  join: 'pullboard join web --model "my-model"', resume: 'pullboard resume',
  intake: 'pullboard intake https://github.com/owner/repo/pull/7 --criterion "behavior" --check "npm test"',
  patch: 'pullboard patch list 12',
  companion: 'pullboard companion 12 api "Provide the API" --key api-part',
  slice: 'pullboard slice 12 "Build the view" --files web/view.js',
  add: ADD_EXAMPLE, move: 'pullboard move ~web#3 --to web', list: 'pullboard list web', show: 'pullboard show 12',
  claim: 'pullboard claim 12', ship: 'pullboard ship --note "Checks passed"', submit: 'pullboard submit 12', 'next --verify': 'pullboard next --verify',
  fact: 'pullboard fact 12 measurement "The check passes in 8 seconds"',
  why: 'pullboard why 12',
  flakes: 'pullboard flakes', 'flakes rerun': 'pullboard flakes rerun on', 'flakes quarantine': 'pullboard flakes quarantine on',
  verify: 'pullboard verify 12 accept --note "removed the fix; the test failed"',
  request: 'pullboard request hold 12 --cause routing-assignment --note "Wait for the prerequisite"',
  watch: 'pullboard watch --to web', answer: 'pullboard answer 12 "done"', pass: 'pullboard pass 12 "please decide"',
  status: 'pullboard status', view: 'pullboard view', digest: 'pullboard digest --out briefing.md', mcp: 'pullboard mcp', flow: 'pullboard flow replay --json', stats: 'pullboard stats --since 2026-10-08', log: 'pullboard log 12', ledger: 'pullboard ledger',
  relay: 'pullboard relay on --all', 'relay recover': 'pullboard relay recover --skip 12', sync: 'pullboard sync',
  'lane add': 'pullboard lane add web --owns apps/web/', lane: 'pullboard lane add web --owns apps/web/',
  queue: 'pullboard queue', coordinate: 'pullboard coordinate', split: 'pullboard split 12', moves: 'pullboard moves', roadmap: 'pullboard roadmap', rigor: 'pullboard rigor', 'rigor quality': 'pullboard rigor quality --rule silent-catch', 'rigor draft': 'pullboard rigor draft "refusal:MERGE_LOST" "Merges keep every hunk" --check "node bin/checks/merges.js" --red 0123456 --green 89abcde', milestone: 'pullboard milestone add "0.7.0"',
  'milestone order': 'pullboard milestone order "0.7.0" 13,12 --reason "the release notes need it first"',
  'milestone pin': 'pullboard milestone pin "0.7.0" 13 --reason "the release notes need it first"',
  'milestone sink': 'pullboard milestone sink "0.7.0" 12 --reason "waits on a design answer"',
  'milestone lift': 'pullboard milestone lift "0.7.0" 12,13',
  runner: 'pullboard runner add you@build-host --slots 2 --browser 1', 'runner add': 'pullboard runner add you@build-host --slots 2 --browser 1',
  edit: 'pullboard edit 12 --brief "Add the upload page"', release: 'pullboard release 12 --reason BLOCKED',
  land: 'pullboard land',
  map: 'pullboard map',
  publish: 'pullboard publish',
  handoff: 'pullboard handoff --take 12',
  health: 'pullboard health',
  reopen: 'pullboard reopen 12 --note "correct the frozen criterion"',
  escalate: 'pullboard escalate 12 --note "needs a manual step"', next: 'pullboard next',
  run: 'pullboard run --agent "node agent.js"', 'view export': 'pullboard view --export ./site',
  'spec check': 'pullboard spec check',
  doctrine: 'pullboard doctrine check', 'doctrine check': 'pullboard doctrine check',
  'spec view': 'pullboard spec view', 'spec show': 'pullboard spec show G1',
  'spec draft': 'pullboard spec draft "Describe the first requirement"', 'blueprint starters': 'pullboard blueprint starters web-app',
  'blueprint add': 'pullboard blueprint add web-app', 'blueprint save': 'pullboard blueprint save',
  'blueprint fit': 'pullboard blueprint fit web-app G1 keep --reason "the repository already meets this row"',
  'spec fit': 'pullboard spec fit',
  'spec unmet': 'pullboard spec unmet', 'spec signoff': 'pullboard spec signoff G1',
  'spec signers add': 'pullboard spec signers add', help: 'pullboard help claim', version: 'pullboard --version',
};

const HELP_ALIASES = {
  help: { usage: 'pullboard help', source: null },
  version: { usage: 'pullboard version', source: null },
  whoami: { usage: 'pullboard whoami', source: 'whoami' },
  lanes: { usage: 'pullboard lanes', source: 'whoami' },
  agents: { usage: 'pullboard agents', source: 'whoami' },
  lane: { usage: 'pullboard lane add <name> --owns <path>[,<path>]', source: 'lane add' },
  status: { usage: 'pullboard status [--all]', source: 'whoami' },
  done: { usage: 'pullboard done <id> [--wait]', source: 'submit <id>' },
  inbox: { usage: 'pullboard inbox', source: null, extraFlags: ['--acted-on <interrupt-ids>', '--archive <shout-ids>'] },
  'check accept': { usage: 'pullboard check accept <id>', source: 'check accept' },
  relay: { source: 'relay', every: true },
  lifecycle: { usage: 'pullboard lifecycle', source: null },
  escalate: { usage: 'pullboard escalate <id> --note "..." [--note-file <file>]', source: 'escalate <id> --note "what was tried and how it failed"', extraFlags: ['--note-file <file>'] },
  'view export': { usage: 'pullboard view --export <dir> [--public]', source: 'view' },
  blueprint: { usage: 'pullboard blueprint add <name or file>, then a seat runs pullboard blueprint fit <name or file> <row id or #item> keep|adapt|drop|answer, then the person runs pullboard spec fit approve <batch>', source: 'blueprint add' },
  'blueprint add': { usage: 'pullboard blueprint add <name or file> [--blueprint <name or file>]...', source: 'blueprint add' },
  'blueprint fit': { usage: 'pullboard blueprint fit <name or file> <row id or #item> keep|adapt|drop|answer [--text "..."] [--reason "why"]', source: null, onlyFlags: ['--text', '--reason'] },
  'spec fit': { usage: 'pullboard spec fit [approve <batch>] | fit edit <row id or #item> keep|adapt|drop|answer [--text "..."] [--reason "why"]', source: null, onlyFlags: ['--text', '--reason'] },
  'spec check': { usage: 'pullboard spec check', source: 'spec check' },
  'spec view': { usage: 'pullboard spec view [--out file]', source: 'spec view' },
  'spec show': { usage: 'pullboard spec show <id>', source: 'spec show', onlyFlags: [] },
  'spec approve': { usage: 'pullboard spec approve <ids>', source: 'spec approve', onlyFlags: [] },
  'spec decline': { usage: 'pullboard spec decline <ids> --reason "why"', source: 'spec approve', onlyFlags: ['--reason'] },
  'spec unmet': { usage: 'pullboard spec unmet [--must]', source: 'spec show', onlyFlags: ['--must'] },
  'spec signoff': { usage: 'pullboard spec signoff <ids> [--by <principal>] [--note "..."] [--note-file <file>]', source: 'spec show', onlyFlags: ['--by', '--note', '--note-file'], extraFlags: ['--note-file <file>'] },
  'spec signers': { usage: 'pullboard spec signers add [--key <path>] [--by <principal>]', source: 'spec signers add' },
  'spec signers add': { usage: 'pullboard spec signers add [--key <path>] [--by <principal>]', source: 'spec signers add' },
  doctrine: { usage: 'pullboard doctrine check', source: 'doctrine check' },
  hook: { usage: 'pullboard hook SessionStart|Stop|SessionEnd|pre-commit|pre-merge-commit|commit-msg|pre-push', source: 'hook' },
  'gate set': { usage: 'pullboard gate set "<command>"', source: 'gate set' },
  'hook pre-commit': { usage: 'pullboard hook pre-commit', source: 'hook' },
  'hook pre-merge-commit': { usage: 'pullboard hook pre-merge-commit', source: 'hook' },
  'hook commit-msg': { usage: 'pullboard hook commit-msg <file>', source: 'hook' },
  'hook pre-push': { usage: 'pullboard hook pre-push', source: 'hook' },
};

export const HELP_FLAG_EXPLANATIONS = {
  '--stuck': 'next: release the one build claim this seat holds as BLOCKED with this reason, then answer as next does',
  '--take': 'next: take one eligible item in this seat; handoff: take the named existing hand-off',
  '--after': 'ids or repo#id; claiming waits for verified items on their own boards',
  '--blueprint': 'start from a bundled blueprint or a JSON file; repeat it for one product, one architecture and any practice blueprints',
  '--brief': 'what a cold agent needs',
  '--check': 'the command that proves it',
  '--needs': 'the abilities an agent needs to build it, browser and gui, comma separated; an empty string clears them',
  '--readiness': 'the command that tells whether the item is ready to start; an empty string clears it',
  '--expected-minutes': 'positive expected build minutes, or unknown to clear the estimate',
  '--check-timing': 'coordinator-only true|false, frozen exclusive timing admission for the check',
  '--conflict': 'one conflicting file, exactly as Git names it; repeat it for each file',
  '--doctrine': 'proposes a doctrine ruling; only the person can approve it',
  '--family': 'records the family name',
  '--model': 'identifies the agent model; required unless PULLBOARD_MODEL is set',
  '--implies': 'each named item gets a fact citing this decision',
  '--landing': 'prioritizes a trunk landing in the machine gate queue',
  '--json': 'prints one versioned document',
  '--why': WHY_EXPLANATION,
  '--note': 'what was checked stays with the receipt',
  '--note-file': 'keeps quotes, $ and backticks intact',
  '--private': 'keeps an added item in this device-local repo board, or selects that board for move IDs',
  '--level': 'sets which work the model can take',
  '--route': 'sets which work the model can take',
  '--source': 'where the person gave the ruling; required with --doctrine',
};

/** Lines a command's own help adds after its example. */
const HELP_NOTES = {
  release: RELEASE_REASON_LINES,
  serve: [
    'This is the board API (JSON, behind the session secret in its printed address); it serves no page.',
    'To see the board in a browser, run pullboard view.',
  ],
  status: [
    'Counts include live, idle and gone identities; plain text lists only live and idle seats.',
    '--all includes gone seats. JSON retains the full identity history and presence counts.',
  ],
  resume: [
    'Ordinary resume reads the current work card and recorded health without running diagnostics or watches.',
    'Use --diagnostics explicitly for setup, hooks, dirty files and stale-work checks.',
  ],
  'sentinel run': [
    'Schedule this command with cron on a server or a scheduled CI job that already has ordinary board access.',
    'For example: 0 * * * * cd /path/to/project && pullboard sentinel run',
    'Each run prepares committed local trunk; resume and the background view never execute watch commands.',
    'It also refreshes work-health findings; resume shows only the indexed findings and their recorded time.',
  ],
  watch: [
    'Claude Code: run pullboard watch --to <your id> under the Monitor tool, and each event line wakes the seat.',
    'Any other harness: run it as a long-running command and treat each stdout line as an event.',
  ],
};

/** Build command-specific help rows from the preserved full list so its syntax stays authoritative. */
function commandHelpRows(fullHelp, commandNames) {
  const lines = fullHelp.split('\n');
  const rows = [];
  for (let index = 0; index < lines.length; index += 1) {
    if (!lines[index].startsWith('  pullboard ')) continue;
    const details = [lines[index].trim()];
    for (let next = index + 1; next < lines.length && lines[next].startsWith(' ') && lines[next].trim() && !lines[next].startsWith('  pullboard '); next += 1) details.push(lines[next].trim());
    rows.push({ usage: lines[index].trim().slice('pullboard '.length).split(/\s{2,}/, 1)[0].trim(), details });
  }
  const names = [...new Set([
    ...commandNames,
    ...Object.keys(HELP_ALIASES),
    ...Object.keys(HELP_EXAMPLES).filter((name) => /^[a-z][a-z0-9-]*(?: [a-z][a-z0-9-]*)*$/u.test(name)),
    ...rows.map((row) => commandWords(row.usage)[0]).filter(Boolean),
    // Every printed subcommand phrase (milestone items, relay devices) is a name too, so its help exists [N2].
    ...lines.filter((line) => line.startsWith('  pullboard ')).flatMap((line) => usagePhrases(line.trim())).filter((phrase) => phrase.includes(' ')),
  ])];
  const entries = Object.fromEntries(names.map((name) => {
    const parts = name.split(' ');
    const alias = HELP_ALIASES[name];
    const matches = alias?.source ? rows.filter((row) => row.usage === alias.source || row.usage.startsWith(`${alias.source} `)) : alias ? [] : rows.filter((row) => {
      const tokens = row.usage.split(/\s+/u);
      if (!parts.every((part, index) => tokens[index] === part)) return false;
      const next = tokens[parts.length];
      return !next || next.startsWith('--') || next.startsWith('<') || next.startsWith('[') || next === '|';
    });
    const usages = alias && !alias.every ? [alias.usage] : matches.length ? [...new Set(matches.map((row) => `pullboard ${row.usage}`))] : [`pullboard ${name}`];
    const foundFlags = [...matches.flatMap((row) => row.details.flatMap((line) => line.match(/--[a-z][a-z-]*(?:\s+(?:<[^>]+>|"[^"]*"|\[(?!-)[^\]]+\]|[A-Za-z][A-Za-z0-9|_-]*))?/gu) ?? [])), ...(alias?.extraFlags ?? []), '--json', '--help', WHY_FLAG, ...(name === 'help' ? ['--all'] : [])];
    const flagMap = new Map();
    for (const flag of foundFlags) {
      const key = flag.split(/\s/u, 1)[0];
      if (alias?.onlyFlags && !alias.onlyFlags.includes(key) && !['--json', '--help', '--why'].includes(key)) continue;
      if (!flagMap.has(key) || flagMap.get(key).length < flag.length) flagMap.set(key, flag);
    }
    const flags = [...flagMap.values()].map((flag) => {
      const explanation = HELP_FLAG_EXPLANATIONS[flag.split(/\s/u, 1)[0]];
      return explanation ? `${cleanFlag(flag)} — ${explanation}` : describeFlag(name, flag);
    });
    const example = exampleFor(name, usages[0]);
    return [name, Object.freeze({ usages, flags, example, notes: HELP_NOTES[name] ?? [] })];
  }));
  return { ...entries, ...settingFormHelp(entries) };
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

/** The settings forms settingsCommand dispatches with a value; each gets its own help, from this list (N2). */
export const SETTING_FORMS = Object.freeze(['gateSlots', 'browserSlots', 'gate.shortSlots', 'gate.runnersFirst', 'gate.measuredSlots', 'gate.loadAwareDispatch', 'gate.runnerBusyCeiling', 'gate.runnersOnly', 'gate.runnerWaitMs', 'workers.budget', 'landing.pool', 'inspection.clauses', 'runnerRates', 'budget.dailyUsd', 'budget.totalUsd', 'scratch', 'gate.diskFloorMB', 'gate.memoryFloorMB', 'gate.queue.agingMinutes', 'gate.queue.reviewsFirst', 'gate.queue.currentReleaseFirst', 'gate.browserFreeChecks', 'gate.browserByLaunch', 'health.sentinel', 'view.background', 'relay.offerAtInit']);

/** How each plain-valued settings form takes its value, and an example of it; the values are checked by the config cell (PERSON_SET). */
const PERSON_SET_USAGE = Object.freeze({ usd: ['<dollars>|off', '25'], folder: ['<folder>|off', '/Volumes/scratch'], mb: ['<n>|off', '4096'], minutes: ['<n>|off', '30'], switch: ['on|off', 'on'] });
const PERSON_SET_KIND = Object.freeze({ 'budget.dailyUsd': 'usd', 'budget.totalUsd': 'usd', scratch: 'folder', 'gate.diskFloorMB': 'mb', 'gate.memoryFloorMB': 'mb', 'gate.queue.agingMinutes': 'minutes', 'gate.queue.reviewsFirst': 'switch', 'gate.queue.currentReleaseFirst': 'switch', 'gate.browserFreeChecks': 'switch', 'gate.browserByLaunch': 'switch', 'health.sentinel': 'switch', 'view.background': 'switch', 'relay.offerAtInit': 'switch' });

/** Help for each settings form the printed usage did not already name, so each form is covered (N2). */
function settingFormHelp(commands) {
  return Object.fromEntries(SETTING_FORMS.filter((form) => !commands[`settings ${form}`]).map((form) => [`settings ${form}`, Object.freeze({
    usages: [`pullboard settings ${form} ${PERSON_SET_KIND[form] ? PERSON_SET_USAGE[PERSON_SET_KIND[form]][0] : ['landing.pool', 'gate.runnersOnly', 'gate.measuredSlots', 'gate.loadAwareDispatch', 'inspection.clauses'].includes(form) ? 'on|off' : form === 'workers.budget' ? '<spend>/day|week' : form === 'runnerRates' ? '<runner> <price> <months> <watts> <kwhPrice>' : '<n>'}`], flags: [`${WHY_FLAG} — ${WHY_EXPLANATION}`],
    example: `pullboard settings ${form} ${PERSON_SET_KIND[form] ? PERSON_SET_USAGE[PERSON_SET_KIND[form]][1] : ['landing.pool', 'gate.runnersOnly', 'gate.measuredSlots', 'gate.loadAwareDispatch', 'inspection.clauses'].includes(form) ? 'on' : form === 'workers.budget' ? '40/day' : form === 'runnerRates' ? 'build-host.local 1200 36 85 0.14' : '2'}`, notes: [],
  })]));
}

/**
 * Build help from the actual command declarations, preserving the printed overview and full list.
 *
 * @param {string[]} [commandNames]
 * @returns {Readonly<object>}
 */
export function buildHelp(commandNames = []) {
  return Object.freeze({
    overview: overviewHelp(HELP_GROUPS),
    firstRun: overviewHelp(HELP_GROUPS, true),
    all: ALL_HELP,
    groups: HELP_GROUPS,
    commands: Object.freeze(commandHelpRows(ALL_HELP, commandNames)),
  });
}

/** Browser consumers read pure help declarations without initializing the CLI or server. */
export const HELP = buildHelp();

/** Replace help placeholders with ordinary values so every command receives a usable example. */
function exampleFor(name, usage) {
  if (HELP_EXAMPLES[name]) return HELP_EXAMPLES[name];
  return usage.split(/\s+\|\s+/u, 1)[0]
    .replace(/\s+\[[^\]]+\]/gu, '')
    .replace(/<lane>/gu, 'web')
    .replace(/<title>/gu, '"Example"')
    .replace(/<id>/gu, '12')
    .replace(/<file>/gu, 'board.json')
    .replace(/<path>/gu, 'src/cli.js')
    .replace(/<commit>/gu, '0123456')
    .replace(/<principal>/gu, 'person@example.invalid')
    .replace(/<[^>]+>/gu, 'value')
    .replace(/\|[^\s|]+/gu, '');
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
    phrases.add(name);
    for (const usage of declaration.usages) for (const phrase of usagePhrases(usage)) phrases.add(phrase);
  }
  return [...phrases].sort((left, right) => right.length - left.length || left.localeCompare(right));
}

/** The command catalog the cockpit renderer re-exports, computed here after HELP so no import cycle reads it early. */
export const PULLBOARD_COMMANDS = Object.freeze(commandPhrases().sort((left, right) => right.split(' ').length - left.split(' ').length));
