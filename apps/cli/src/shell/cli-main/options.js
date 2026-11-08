/** The CLI's global switches and the command-aware argument parser [C7]. */
import { parseArgs } from 'node:util';

const OPTIONS = {
  criterion: { type: 'string' },
  files: { type: 'string' },
  'force-size': { type: 'string' },
  'expected-minutes': { type: 'string' },
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
  reason: { type: 'string' },
  revises: { type: 'string' },
  status: { type: 'string' },
  off: { type: 'boolean' },
  stale: { type: 'boolean' },
  port: { type: 'string' },
  slots: { type: 'string' },
  browser: { type: 'string' },
  'new-browser': { type: 'boolean' },
  node: { type: 'string' },
  root: { type: 'string' },
  project: { type: 'boolean' },
  export: { type: 'string' },
  public: { type: 'boolean' },
  'no-open': { type: 'boolean' },
  'no-next': { type: 'boolean' },
  lan: { type: 'boolean' },
  'no-permissions': { type: 'boolean' },
  'no-hooks': { type: 'boolean' },
  note: { type: 'string' },
  infra: { type: 'string' },
  precheck: { type: 'boolean' },
  preflight: { type: 'boolean' },
  companion: { type: 'string' },
  'note-file': { type: 'string' },
  by: { type: 'string' },
  author: { type: 'string' },
  key: { type: 'string' },
  out: { type: 'string' },
  watch: { type: 'boolean' },
  'runner-only': { type: 'boolean' },
  after: { type: 'string' },
  on: { type: 'string' },
  brief: { type: 'string' },
  'brief-file': { type: 'string' },
  private: { type: 'boolean' },
  'coverage-file': { type: 'string' },
  text: { type: 'string' },
  gate: { type: 'string' },
  'gate-receipt': { type: 'string' },
  receipt: { type: 'boolean' },
  aim: { type: 'boolean' },
  doctrine: { type: 'boolean' },
  source: { type: 'string' },
  section: { type: 'string' },
  blueprint: { type: 'string', multiple: true },
  route: { type: 'string' },
  family: { type: 'string' }, 'review-family': { type: 'string' },
  model: { type: 'string' },
  as: { type: 'string' },
  check: { type: 'string' },
  // The watch command's options.
  every: { type: 'string' },
  scale: { type: 'boolean' },
  cycles: { type: 'string' },
  owner: { type: 'string' },
  directory: { type: 'string' },
  timeout: { type: 'string' },
  sentinel: { type: 'boolean' },
  'health-only': { type: 'boolean' },
  digest: { type: 'string' },
  // The rigor quality draft's options.
  base: { type: 'string' },
  head: { type: 'string' },
  rule: { type: 'string' },
  budget: { type: 'string' },
  'draft-quality': { type: 'boolean' },
  yes: { type: 'boolean' },
  diagnostics: { type: 'boolean' },
  landing: { type: 'boolean' },
  adopt: { type: 'boolean' },
  due: { type: 'boolean' },
  affected: { type: 'boolean' },
  'compare-main': { type: 'boolean' },
  waive: { type: 'string' },
  until: { type: 'string' },
  take: { type: 'string' },
  agent: { type: 'string' },
  'agent-light': { type: 'string' },
  'agent-mid': { type: 'string' },
  'agent-strong': { type: 'string' },
  attempts: { type: 'string' },
  'acted-on': { type: 'string' },
  minutes: { type: 'string' },
  items: { type: 'string' },
  run: { type: 'string' },
  max: { type: 'string' },
  'dry-run': { type: 'boolean' },
  why: { type: 'boolean' },
  replay: { type: 'boolean' },
  update: { type: 'boolean' },
  before: { type: 'string' },
  overflow: { type: 'string' },
  target: { type: 'string' },
  next: { type: 'string' },
  add: { type: 'string' },
  remove: { type: 'string' },
  swap: { type: 'string' },
  limit: { type: 'string' },
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
  fields: { type: 'string' },
  history: { type: 'boolean' },
  verbose: { type: 'boolean' },
  since: { type: 'string' },
  window: { type: 'string' },
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
  choose: for (const wait of [{ type: 'boolean' }, OPTIONS.wait]) {
    for (const take of [{ type: 'boolean' }, OPTIONS.take]) {
      try {
        const candidate = parseArgs({ args: argv, options: { ...OPTIONS, wait, take }, allowPositionals: true }).positionals[0];
        if (command === undefined) command = candidate;
        if (['add', 'edit', 'submit', 'done'].includes(candidate) !== (wait.type === 'boolean')) continue;
        if ((candidate === 'next') !== (take.type === 'boolean')) continue;
        command = candidate;
        break choose;
      } catch { /* The final parser supplies the existing actionable usage error. */ }
    }
  }
  const options = { ...OPTIONS,
    ...(['add', 'edit', 'submit', 'done'].includes(command) ? { wait: { type: 'boolean' } } : {}),
    ...(command === 'next' ? { take: { type: 'boolean' } } : {}),
  };
  // Flow consumes a history file; show retains its existing boolean --history switch.
  const commandOptions = command === 'flow' ? { ...options, history: { type: 'string' } } : options;
  const parsed = parseArgs({ args: argv, options: commandOptions, allowPositionals: true });
  if (['add', 'edit'].includes(command)) refuseRepeatedFlags(argv, commandOptions);
  return parsed;
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
