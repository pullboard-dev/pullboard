/** The CLI's global switches and the command-aware argument parser [C7]. */
import { parseArgs } from 'node:util';
import { Refused } from '../../../../../packages/kernel/light.js';

const OPTIONS = {
  criterion: { type: 'string' },
  claims: { type: 'boolean' },
  files: { type: 'string' },
  'force-size': { type: 'string' },
  'not-duplicate-of': { type: 'string' },
  here: { type: 'string' },
  confirm: { type: 'boolean' },
  reject: { type: 'boolean' },
  'accept-green': { type: 'string' },
  'split-coordinator': { type: 'boolean' },
  'expected-minutes': { type: 'string' },
  readiness: { type: 'string' },
  sensitive: { type: 'boolean' },
  'machine-verified': { type: 'string' },
  'machine-commands-file': { type: 'string' },
  'review-tier': { type: 'string' },
  'review-family': { type: 'string' },
  sandbox: { type: 'boolean' },
  lane: { type: 'string' },
  specs: { type: 'string' },
  parent: { type: 'string' },
  wake: { type: 'string' },
  'lock-lane': { type: 'boolean' },
  'review-limit': { type: 'string' },
  reason: { type: 'string' },
  revises: { type: 'string' },
  row: { type: 'string' },
  status: { type: 'string' },
  cancel: { type: 'string' },
  off: { type: 'boolean' },
  stale: { type: 'boolean' },
  port: { type: 'string' },
  address: { type: 'string' },
  board: { type: 'string' },
  slots: { type: 'string' },
  browser: { type: 'string' },
  'new-browser': { type: 'boolean' },
  only: { type: 'string' },
  node: { type: 'string' },
  root: { type: 'string' },
  toolchain: { type: 'string' },
  project: { type: 'boolean' },
  export: { type: 'string' },
  public: { type: 'boolean' },
  'no-open': { type: 'boolean' },
  'no-next': { type: 'boolean' },
  lan: { type: 'boolean' },
  suggest: { type: 'boolean' },
  'no-permissions': { type: 'boolean' },
  'no-hooks': { type: 'boolean' },
  note: { type: 'string' },
  infra: { type: 'string' },
  precheck: { type: 'boolean' },
  'dry-run-review': { type: 'boolean' },
  preflight: { type: 'boolean' },
  companion: { type: 'string' },
  'note-file': { type: 'string' },
  by: { type: 'string' },
  author: { type: 'string' },
  key: { type: 'string' },
  out: { type: 'string' },
  watch: { type: 'boolean' },
  'runner-only': { type: 'boolean' },
  static: { type: 'boolean' },
  withdraw: { type: 'string' },
  after: { type: 'string' },
  on: { type: 'string' },
  brief: { type: 'string' },
  'brief-file': { type: 'string' },
  private: { type: 'boolean' },
  'coverage-file': { type: 'string' },
  text: { type: 'string' },
  gate: { type: 'string' },
  'gate-receipt': { type: 'string' },
  forced: { type: 'string' },
  'waive-proof': { type: 'string' },
  receipt: { type: 'boolean' },
  aim: { type: 'boolean' },
  doctrine: { type: 'boolean' },
  source: { type: 'string' },
  section: { type: 'string' },
  blueprint: { type: 'string', multiple: true },
  role: { type: 'string' },
  route: { type: 'string' }, level: { type: 'string' },
  field: { type: 'string' },
  family: { type: 'string' }, 'review-family': { type: 'string' },
  model: { type: 'string' },
  issue: { type: 'string' },
  as: { type: 'string' },
  check: { type: 'string' },
  // The watch command's options.
  every: { type: 'string' },
  scale: { type: 'boolean' },
  cycles: { type: 'string' },
  owner: { type: 'string' },
  directory: { type: 'string' },
  once: { type: 'boolean' },
  jobs: { type: 'string' },
  timeout: { type: 'string' },
  sentinel: { type: 'boolean' },
  'health-only': { type: 'boolean' },
  'lapsed-only': { type: 'boolean' },
  health: { type: 'boolean' },
  lag: { type: 'boolean' },
  'main-lag': { type: 'boolean' },
  digest: { type: 'string' },
  // The rigor quality draft's options.
  base: { type: 'string' },
  head: { type: 'string' },
  rule: { type: 'string' },
  budget: { type: 'string' },
  'draft-quality': { type: 'boolean' },
  yes: { type: 'boolean' },
  diagnostics: { type: 'boolean' },
  hosts: { type: 'boolean' },
  landing: { type: 'boolean' },
  adopt: { type: 'boolean' },
  due: { type: 'boolean' },
  affected: { type: 'boolean' },
  'compare-main': { type: 'boolean' },
  'no-file-limit': { type: 'boolean' },
  census: { type: 'boolean' },
  diagnose: { type: 'boolean' },
  'test-run': { type: 'string' },
  waive: { type: 'string' },
  until: { type: 'string' },
  choices: { type: 'string' },
  deadline: { type: 'string' },
  take: { type: 'string' },
  agent: { type: 'string' },
  'agent-light': { type: 'string' },
  'agent-mid': { type: 'string' },
  'agent-strong': { type: 'string' },
  attempts: { type: 'string' },
  'acted-on': { type: 'string' },
  archive: { type: 'string' },
  minutes: { type: 'string' },
  items: { type: 'string' },
  run: { type: 'string' },
  max: { type: 'string' },
  'dry-run': { type: 'boolean' },
  'fail-on-drift': { type: 'boolean' },
  prune: { type: 'boolean' },
  utilization: { type: 'boolean' },
  why: { type: 'boolean' },
  replay: { type: 'boolean' },
  stats: { type: 'boolean' },
  update: { type: 'boolean' },
  before: { type: 'string' },
  overflow: { type: 'string' },
  target: { type: 'string' },
  next: { type: 'string' },
  add: { type: 'string' },
  remove: { type: 'string' },
  swap: { type: 'string' },
  limit: { type: 'string' },
  mode: { type: 'string' },
  demand: { type: 'boolean' },
  transcripts: { type: 'string' },
  checkpoint: { type: 'string' },
  name: { type: 'string' },
  title: { type: 'string' },
  url: { type: 'string' },
  skip: { type: 'string' },
  wait: { type: 'string' },
  verify: { type: 'boolean' },
  build: { type: 'boolean' },
  all: { type: 'boolean' },
  must: { type: 'boolean' },
  json: { type: 'boolean' },
  detail: { type: 'boolean' },
  audit: { type: 'boolean' },
  fields: { type: 'string' },
  history: { type: 'boolean' },
  verbose: { type: 'boolean' },
  since: { type: 'string' },
  window: { type: 'string' },
  days: { type: 'string' },
  against: { type: 'string' },
  compare: { type: 'boolean' },
  policy: { type: 'string' },
  decision: { type: 'boolean' },
  kind: { type: 'string' },
  options: { type: 'string' },
  effects: { type: 'string' },
  news: { type: 'boolean' },
  evidence: { type: 'string' },
  outcome: { type: 'string' },
  item: { type: 'string' },
  for: { type: 'string' },
  kinds: { type: 'string' }, to: { type: 'string' }, work: { type: 'string' }, 'review-wait': { type: 'string' }, review: { type: 'boolean' }, read: { type: 'string' },
  commit: { type: 'string' },
  ref: { type: 'string' },
  supersedes: { type: 'string' },
  answers: { type: 'string' },
  origin: { type: 'string' },
  rationale: { type: 'string' },
  conflict: { type: 'string', multiple: true },
  'withdraw-verdict': { type: 'boolean' },
  cause: { type: 'string' },
  tier: { type: 'string' },
  clause: { type: 'string' },
  'check-timing': { type: 'string' },
  'never-again': { type: 'boolean' },
  'session-end': { type: 'boolean' },
  'draft-splits': { type: 'boolean' },
  implies: { type: 'string' },
  owns: { type: 'string' },
  red: { type: 'string' },
  green: { type: 'string' },
  help: { type: 'boolean', short: 'h' },
  version: { type: 'boolean', short: 'v' },
};

/** Resolve command-specific switches before parsing their ambiguous global string forms. */
export function parseCommandArgs(argv) {
  let command;
  // Runner's --remove is a switch where other commands give it a value, so the command is found under either form.
  choose: for (const wait of [{ type: 'boolean' }, OPTIONS.wait]) {
    for (const take of [{ type: 'boolean' }, OPTIONS.take]) for (const remove of [OPTIONS.remove, { type: 'boolean' }]) {
      try {
        const candidate = parseArgs({ args: argv, options: { ...OPTIONS, ...(argv[0] === 'spec' ? { commit: { type: 'boolean' } } : {}), wait, take, remove }, allowPositionals: true }).positionals[0];
        if (command === undefined) command = candidate;
        if (['add', 'edit', 'submit', 'done', 'test'].includes(candidate) !== (wait.type === 'boolean')) continue;
        if ((candidate === 'next') !== (take.type === 'boolean')) continue;
        command = candidate;
        break choose;
      } catch { /* The final parser supplies the existing actionable usage error. */ }
    }
  }
  const options = { ...OPTIONS,
    ...(command === 'spec' ? { commit: { type: 'boolean' } } : {}),
    ...(['add', 'edit', 'submit', 'done', 'test'].includes(command) ? { wait: { type: 'boolean' } } : {}),
    ...(command === 'next' ? { take: { type: 'boolean' } } : {}),
    ...(['add', 'edit'].includes(command) ? { review: { type: 'string' } } : {}),
  };
  // Flow consumes a history file; show retains its existing boolean --history switch. Runner's --remove is a switch.
  const commandOptions = command === 'flow' ? { ...options, history: { type: 'string' }, apply: { type: 'boolean' } } : command === 'runner' ? { ...options, remove: { type: 'boolean' } } : options;
  const parsed = parseArgs({ args: argv, options: commandOptions, allowPositionals: true });
  foldLevelIntoRoute(parsed.values);
  if (['add', 'edit'].includes(command)) foldReviewIntoReviewTier(parsed.values);
  if (['add', 'edit'].includes(command)) refuseRepeatedFlags(argv, commandOptions);
  return parsed;
}

/** --level is the approved name for --route (U136): stored events keep route, so every reader sees the value as values.route. */
function foldLevelIntoRoute(values) {
  if (values.level === undefined) return;
  if (values.route !== undefined && values.route !== values.level) throw new Refused('USAGE', `--level ${values.level} and --route ${values.route} name the same setting; give one of them`);
  values.route = values.level;
  delete values.level;
}

/**
 * --review standard|strict is the approved name for --review-tier (U136): the stored tier keeps its name, so every reader
 * sees the value as values['review-tier']. Standard is the floor and changes nothing; strict may be raised, never lowered.
 */
function foldReviewIntoReviewTier(values) {
  if (values.review === undefined) return;
  if (!['standard', 'strict'].includes(values.review)) throw new Refused('USAGE', `--review ${values.review}: give standard or strict`);
  if (values['review-tier'] !== undefined && values['review-tier'] !== values.review) throw new Refused('USAGE', `--review ${values.review} and --review-tier ${values['review-tier']} name the same setting; give one of them`);
  if (values.review === 'strict') values['review-tier'] = 'strict';
  delete values.review;
}

/**
 * Refuse a single-value text flag given more than once, so add and edit never keep the last value and silently drop
 * the earlier ones (#3743). A flag declared repeatable keeps every value and is left alone.
 *
 * @param {string[]} argv
 * @param {Record<string, { type: string, multiple?: boolean }>} options
 */
function refuseRepeatedFlags(argv, options) {
  const counts = new Map();
  for (const token of argv) {
    if (token === '--') break;
    const name = /^--([^=]+)(?:=|$)/u.exec(token)?.[1];
    if (name && options[name]?.type === 'string' && !options[name].multiple) counts.set(name, (counts.get(name) ?? 0) + 1);
  }
  for (const [name, count] of counts) {
    if (count > 1) throw Object.assign(new Error(`--${name} was given ${count} times and only one value is kept (REPEATED_FLAG --${name}); give it once, with every clause numbered inside that one value`), { refusalCode: 'REPEATED_FLAG' });
  }
}

/** Whether a parsed command line only prints version or help, which asks Git nothing. */
export function asksGitNothing(argv) {
  try {
    const { values, positionals: [command] } = parseCommandArgs(argv);
    return Boolean(values.help || values.version || command === 'help' || command === 'version');
  } catch { return true; }
}

/** Whether a command line only prints the version, which selects no pinned tool build and asks Git nothing. */
export function asksVersion(argv) {
  try {
    const { values, positionals: [command] } = parseCommandArgs(argv);
    return Boolean((values.version || command === 'version') && !values.help);
  } catch { return false; }
}
