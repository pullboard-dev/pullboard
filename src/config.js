/**
 * `pullboard.json`: the gate, the spec file, the lanes and the commit rules. Read once per command,
 * merged over defaults, and checked, so a typo refuses with its field name instead of misbehaving.
 */
import {
  existsSync,
  readFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { Refused } from './refused.js';
import { registryGuardsProblem } from './registry-guards.js';

export const CONFIG_FILE = 'pullboard.json';
export const COORDINATOR = 'coordinator';
export const DOCTRINE_FILE = 'DOCTRINE.md';
export const LEGACY_DOCTRINE_FILE = 'PRACTICE.md';

const LANE_NAME_RE = /^[a-z][a-z0-9-]{0,30}$/;
const DURATION_RE = /^(\d+)(m|h|d)$/;
const UNIT_MS = { m: 60_000, h: 3_600_000, d: 86_400_000 };
const CHECK_TIMEOUT_RE = /^(\d+)(ms|s|m|h|d)$/;
const CHECK_TIMEOUT_MS = { ms: 1, s: 1_000, m: 60_000, h: 3_600_000, d: 86_400_000 };
const MAX_CHECK_TIMEOUT_MS = 2_147_483_647;
const COMMIT_TYPES = [
  'feat',
  'fix',
  'docs',
  'test',
  'refactor',
  'perf',
  'build',
  'ci',
  'chore',
  'style',
  'revert',
];

/**
 * Every setting a repo gets without saying otherwise.
 *
 * @returns {object}
 */
export function defaults() {
  return {
    spec: 'SPEC.md',
    practice: DOCTRINE_FILE,
    gate: '',
    submit: { requireInfraNote: false },
    testEconomics: { costOfEscape: 3600, costOfWaiting: 1, costOfFalseRed: 300 },
    itemSizeBudget: 100,
    submitInvariants: [],
    registryGuards: [],
    staticChecks: '',
    lease: '2h',
    claims: { releaseGone: false },
    reviewLease: '30m',
    worktrees: 'beside',
    verify: { policy: 'any', family: 'off', reviewRatio: 3 },
    // Explicit vendor spellings: canonical family -> declared alias names. Never inferred from a model [#1762].
    families: {},
    // Off by default: next and claim print an item's code map slice only when map.slice is true [1203].
    map: { slice: false },
    agents: { names: 'suffix' },
    inbox: { tokenBudget: 8192 },
    check: { install: '', timeout: '5m' },
    claim: { reopenFirstRefusalMinutes: 0, barTestFiles: ['**/*.test.js', '**/*.test.mjs', '**/*.test.cjs', '**/*.spec.js', '**/*.spec.mjs', '**/*.spec.cjs'] },
    lanes: {},
    products: {},
    shared: [],
    fix: [],
    commits: {
      types: [...COMMIT_TYPES],
      maxHeader: 72,
      requireIds: ['feat', 'fix'],
      banned: [],
      noEmoji: false,
      noCoAuthor: false,
      // Refuse a submit whose new commits name this machine; false only warns (C1).
      noHostName: false,
    },
    protect: {
      blocked: ['.env', '.env.*', '*.env', '.envrc'],
      allowed: ['.env.example'],
      secrets: true,
    },
  };
}

/**
 * Milliseconds in a duration like `90m`, `2h` or `1d`.
 *
 * @param {string} text
 * @param {string} [setting] - The setting it came from, for the refusal.
 * @returns {number}
 */
export function durationMs(text, setting = 'lease') {
  const match = DURATION_RE.exec(String(text));
  if (!match) throw new Refused('BAD_CONFIG', `${setting} "${text}" is not a duration like 90m, 2h or 1d`);
  return Number(match[1]) * UNIT_MS[/** @type {'m'|'h'|'d'} */ (match[2])];
}

/**
 * The config with each nested group merged field by field, so a repo can set one commit rule
 * without restating the rest.
 *
 * @param {object} base
 * @param {object} raw
 * @returns {object}
 */
function merge(base, raw) {
  const spec = raw.spec && typeof raw.spec === 'object' && !Array.isArray(raw.spec) ? raw.spec : null;
  if (spec && Object.keys(spec).some(key => !['file', 'agentApproval'].includes(key))) throw new Refused('BAD_CONFIG', '"spec" has only "file" and "agentApproval"');
  return {
    ...base,
    ...raw,
    testEconomics: raw.testEconomics === undefined ? base.testEconomics
      : raw.testEconomics && typeof raw.testEconomics === 'object' && !Array.isArray(raw.testEconomics)
        ? { ...base.testEconomics, ...raw.testEconomics } : raw.testEconomics,
    spec: spec ? spec.file : raw.spec === undefined ? base.spec : raw.spec,
    specAgentApproval: spec?.agentApproval === undefined ? 'flag' : spec.agentApproval,
    commits: { ...base.commits, ...(raw.commits ?? {}) },
    protect: { ...base.protect, ...(raw.protect ?? {}) },
    map: raw.map && typeof raw.map === 'object' && !Array.isArray(raw.map) ? { ...base.map, ...raw.map } : base.map,
    verify: typeof raw.verify === 'string'
      ? { ...base.verify, policy: raw.verify }
      : { ...base.verify, ...(raw.verify ?? {}) },
    inbox: raw.inbox === undefined ? base.inbox
      : raw.inbox && typeof raw.inbox === 'object' && !Array.isArray(raw.inbox)
        ? { ...base.inbox, ...raw.inbox } : raw.inbox,
    agents: raw.agents === undefined ? base.agents
      : raw.agents && typeof raw.agents === 'object' && !Array.isArray(raw.agents)
        ? { ...base.agents, ...raw.agents }
        : raw.agents,
    claims: raw.claims && typeof raw.claims === 'object' && !Array.isArray(raw.claims)
      ? { ...base.claims, ...raw.claims } : raw.claims === undefined ? base.claims : raw.claims,
    claim: raw.claim === undefined ? base.claim
      : raw.claim && typeof raw.claim === 'object' && !Array.isArray(raw.claim)
        ? { ...base.claim, ...raw.claim }
        : raw.claim,
    check: raw.check === undefined ? base.check
      : raw.check && typeof raw.check === 'object' && !Array.isArray(raw.check)
        ? { ...base.check, ...raw.check }
        : raw.check,
    submit: raw.submit === undefined ? base.submit
      : raw.submit && typeof raw.submit === 'object' && !Array.isArray(raw.submit)
        ? { ...base.submit, ...raw.submit }
        : raw.submit,
  };
}

/**
 * True for an array whose every element is a string.
 *
 * @param {unknown} value
 * @returns {boolean}
 */
const isStringList = (value) =>
  Array.isArray(value) && value.every((entry) => typeof entry === 'string');

/**
 * Problems in one lane's declaration.
 *
 * @param {string} name
 * @param {any} lane
 * @returns {string[]}
 */
function laneProblems(name, lane) {
  if (!LANE_NAME_RE.test(name) || name === 'all' || name === COORDINATOR) {
    return [`lane "${name}": names are lowercase words; "all" and "coordinator" are taken`];
  }
  const problems = [];
  if (!isStringList(lane?.owns)) problems.push(`lane "${name}": "owns" is a list of path prefixes`);
  if (lane?.specs !== undefined && !isStringList(lane.specs)) {
    problems.push(`lane "${name}": "specs" is a list of spec ids or prefixes`);
  }
  if (lane?.starts !== undefined && typeof lane.starts !== 'string') {
    problems.push(`lane "${name}": "starts" is text`);
  }
  return problems;
}

/**
 * Every problem in a merged config, empty when it is sound.
 *
 * @param {any} config
 * @returns {string[]}
 */
export function configProblems(config) {
  const problems = [];
  const costs = config.testEconomics;
  if (!costs || typeof costs !== 'object' || Array.isArray(costs)
    || Object.keys(costs).some(key => !['costOfEscape', 'costOfWaiting', 'costOfFalseRed'].includes(key))
    || !['costOfEscape', 'costOfWaiting', 'costOfFalseRed'].every(key => Number.isFinite(costs[key]) && costs[key] >= 0)) {
    problems.push('"testEconomics" has nonnegative finite costOfEscape, costOfWaiting and costOfFalseRed numbers (seconds of equivalent waiting); it controls reported value and published submit/landing placement');
  }
  if (config.pushReceiptCheck !== undefined && (!config.pushReceiptCheck || typeof config.pushReceiptCheck !== 'object'
    || Array.isArray(config.pushReceiptCheck) || Object.keys(config.pushReceiptCheck).some(key => key !== 'smoke')
    || typeof config.pushReceiptCheck.smoke !== 'string' || !config.pushReceiptCheck.smoke.trim())) {
    problems.push('"pushReceiptCheck" has only an explicit nonempty "smoke" command; this config does not activate the replacement hook');
  }
  if (config.publish !== undefined && (!config.publish || typeof config.publish !== 'object' || Array.isArray(config.publish)
    || Object.keys(config.publish).some(key => key !== 'pullRequest') || ![undefined, false, 'release', 'item'].includes(config.publish.pullRequest))) {
    problems.push('"publish.pullRequest" is false (default), "release" for one PR per release, or "item" for one PR per item');
  }
  for (const field of ['project', 'name']) {
    if (config[field] === undefined) continue;
    const value = config[field];
    if (typeof value !== 'string' || !value.trim() || value.trim() !== value || /[\u0000-\u001f\u007f-\u009f]/u.test(value)) {
      problems.push(`"${field}" is a trimmed, nonempty string without control characters`);
    } else if (field === 'name' && /[#,]/u.test(value)) {
      problems.push('"name" cannot contain "#" or ","');
    }
  }
  if (typeof config.spec !== 'string' || !config.spec) problems.push('"spec" names a file');
  if (config.specAgentApproval !== undefined && !['flag', 'allow', 'refuse'].includes(config.specAgentApproval)) problems.push('"spec.agentApproval" is flag, allow or refuse');
  if (typeof config.practice !== 'string' || !config.practice) problems.push('"practice" names the doctrine file');
  if (typeof config.gate !== 'string') problems.push('"gate" is a shell command, like "npm test"');
  if (config.flakes !== undefined && (!config.flakes || typeof config.flakes !== 'object' || Array.isArray(config.flakes)
      || ['rerun', 'quarantine'].some(key => config.flakes[key] !== undefined && typeof config.flakes[key] !== 'boolean')
      || Object.keys(config.flakes).some(key => !['rerun', 'quarantine'].includes(key)))) problems.push('"flakes" has only the optional booleans "rerun" and "quarantine", each off by default');
  if (config.rigor !== undefined && (!config.rigor || typeof config.rigor !== 'object' || Array.isArray(config.rigor)
      || config.rigor.budget !== undefined && (!Number.isSafeInteger(config.rigor.budget) || config.rigor.budget < 0)
      || Object.keys(config.rigor).some(key => key !== 'budget'))) problems.push('"rigor" has only the optional whole number "budget", the lines of non-test code one change may add; 400 by default');
  if (config.relay !== undefined && (!config.relay || typeof config.relay !== 'object' || Array.isArray(config.relay)
      || config.relay.outbox !== undefined && typeof config.relay.outbox !== 'boolean'
      || config.relay.board !== undefined && (typeof config.relay.board !== 'string' || !/^[0-9a-f]{32}$/u.test(config.relay.board))
      || Object.keys(config.relay).some(key => !['outbox', 'board'].includes(key)))) problems.push('"relay" has only the optional boolean "outbox", on by default with false as the opt-out, and "board", the linked board id relay on writes');
  if (config.approvers !== undefined && (!Array.isArray(config.approvers) || config.approvers.length > 50 || new Set(config.approvers).size !== config.approvers.length
      || config.approvers.some((login) => typeof login !== 'string' || !/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/u.test(login)))) problems.push('"approvers" lists the GitHub logins who act as the person on a linked board, at most fifty; leave it out for today\'s behaviour');
  if (!['inside', 'beside'].includes(config.worktrees)) problems.push('"worktrees" is "inside" or "beside"');
  if (!config.inbox || typeof config.inbox !== 'object' || Array.isArray(config.inbox)
    || Object.keys(config.inbox).some(key => key !== 'tokenBudget')
    || !Number.isSafeInteger(config.inbox.tokenBudget) || config.inbox.tokenBudget < 1024) {
    problems.push('"inbox.tokenBudget" is a whole number of at least 1024 UTF-8 bytes; 8192 by default');
  }
  if (!Number.isSafeInteger(config.itemSizeBudget) || config.itemSizeBudget < 1) {
    problems.push('"itemSizeBudget" is a positive whole number of changed lines; 100 by default');
  }
  if (config.submitGate !== undefined && config.submitGate !== 'landing') {
    problems.push('"submitGate" is "landing" when the full suite should be deferred until landing');
  }
  if (config.submitDeferAbove !== undefined && (!Number.isSafeInteger(config.submitDeferAbove) || config.submitDeferAbove < 1 || config.submitGate !== 'landing')) {
    problems.push('"submitDeferAbove" is a whole number, 1 or more, with "submitGate": "landing": a submit whose affected selection names more test files runs only its check, static checks and submitInvariants, and the landing gate runs the selection; leave it out to run every selected file at submit');
  }
  if (config.landingShards !== undefined && (!Number.isSafeInteger(config.landingShards) || config.landingShards < 1 || config.landingShards > 64)) {
    problems.push('"landingShards" is a whole number from 1 to 64: how many shards the landing gate splits its test files into');
  }
  if (typeof config.staticChecks !== 'string') problems.push('"staticChecks" is an optional project static-check command');
  if (config.landing !== undefined && (typeof config.landing !== 'object' || config.landing === null || Array.isArray(config.landing)
    || Object.keys(config.landing).some(key => !['publish', 'environment', 'timeout', 'cadence', 'parallel', 'requireReceipts', 'pauseOnRed'].includes(key)) || ![undefined, 'separate'].includes(config.landing.publish))) {
    problems.push('"landing" has optional environment: { platform, arch, node }, "timeout" and "cadence" durations, "parallel": true for concurrent candidate gates, and "publish": "separate" to land locally and push through pullboard publish');
  } else if (config.landing?.environment !== undefined && environmentProblem(config.landing.environment)) {
    problems.push(`"landing.environment" ${environmentProblem(config.landing.environment)}`);
  }
  if (config.landing?.parallel !== undefined && typeof config.landing.parallel !== 'boolean') problems.push('"landing.parallel" is a boolean; omit it or use false to keep serial landing');
  if (config.landing?.requireReceipts !== undefined && typeof config.landing.requireReceipts !== 'boolean') problems.push('"landing.requireReceipts" is a boolean; omit it or use false to preserve legacy landing records');
  if (config.landing?.pauseOnRed !== undefined && typeof config.landing.pauseOnRed !== 'boolean') problems.push('"landing.pauseOnRed" is a boolean, off by default; true pauses landing after an unproven red publish full suite');
  const cadenceError = cadenceProblem(config.landing?.cadence);
  if (cadenceError) problems.push(cadenceError);
  for (const key of ['timeout']) {
    const value = config.landing?.[key];
    const match = typeof value === 'string' ? CHECK_TIMEOUT_RE.exec(value) : null;
    const ms = match ? Number(match[1]) * CHECK_TIMEOUT_MS[match[2]] : NaN;
    if (value !== undefined && (!Number.isFinite(ms) || ms <= 0 || ms > MAX_CHECK_TIMEOUT_MS)) problems.push(`"landing.${key}" is a positive duration no longer than 2,147,483,647ms, like "2s"`);
  }
  if (config.positiveControl !== undefined && (typeof config.positiveControl !== 'string' || !config.positiveControl.trim())) {
    problems.push('"positiveControl" is a nonempty command for a known-good case the gate must pass, like "node --test test/known-good.test.js"');
  }
  if (config.affectedTests !== undefined && (typeof config.affectedTests !== 'string' || !config.affectedTests.trim())) {
    problems.push('"affectedTests" is a nonempty command prefix used to run selected test files');
  }
  const registryProblem = registryGuardsProblem(config.registryGuards);
  if (registryProblem) problems.push(registryProblem);
  else if (config.registryGuards.length && (typeof config.affectedTests !== 'string' || !config.affectedTests.trim())) problems.push('"registryGuards" requires the project "affectedTests" runner');
  if (!isStringList(config.submitInvariants) || config.submitInvariants.some(path =>
    !path || path.trim() !== path || /[\u0000-\u001f\u007f-\u009f\\]/u.test(path)
      || path.startsWith('/') || /^[a-z]:/iu.test(path) || path.split('/').some(part => !part || part === '..' || part === '.'))) {
    problems.push('"submitInvariants" is a list of literal repository-relative test file paths');
  } else if (config.submitInvariants.length && (typeof config.affectedTests !== 'string' || !config.affectedTests.trim())) {
    problems.push('"submitInvariants" requires an "affectedTests" command prefix for the project test runner');
  }
  if (!['any', COORDINATOR].includes(config.verify?.policy)) {
    problems.push('"verify.policy" is "any" (any other agent) or "coordinator"');
  }
  if (!['off', 'prefer', 'require'].includes(config.verify?.family)) {
    problems.push('"verify.family" is "off", "prefer" or "require"');
  }
  if (!config.families || typeof config.families !== 'object' || Array.isArray(config.families)
    || Object.entries(config.families).some(([name, aliases]) => !name.trim() || name.length > 80
      || !Array.isArray(aliases) || aliases.some(alias => typeof alias !== 'string' || !alias.trim() || alias.length > 80))) {
    problems.push('"families" maps each canonical vendor family to a list of declared alias names');
  } else {
    // One spelling names one family: an alias listed under two canonical families is refused, never guessed.
    const owners = new Map();
    for (const [canonical, aliases] of Object.entries(config.families)) {
      for (const name of [canonical, ...aliases]) {
        const key = name.trim().toLowerCase(), owner = canonical.trim().toLowerCase();
        if (owners.has(key) && owners.get(key) !== owner) problems.push(`family alias "${name}" maps to both "${owners.get(key)}" and "${owner}"`);
        owners.set(key, owner);
      }
    }
  }
  if (typeof config.check !== 'object' || config.check === null || Array.isArray(config.check)) {
    problems.push('"check" is an object with optional "install" and "timeout" fields');
  }
  if (!config.submit || typeof config.submit !== 'object' || Array.isArray(config.submit)
      || Object.keys(config.submit).some(key => key !== 'requireInfraNote') || typeof config.submit.requireInfraNote !== 'boolean') {
    problems.push('"submit" is an object with a boolean "requireInfraNote" setting');
  }
  // Absent, a check already green on main is only a warning, as on boards made before the setting.
  if (config.checks !== undefined && (typeof config.checks !== 'object' || config.checks === null || Array.isArray(config.checks)
    || Object.keys(config.checks).some((key) => key !== 'provesNothing') || !['hold', 'warn'].includes(config.checks.provesNothing))) {
    problems.push('"checks" is { "provesNothing": "hold" or "warn" }: "hold" refuses claim and submit while an item\'s check already passes on main');
  }
  if (!config.claims || typeof config.claims !== 'object' || Array.isArray(config.claims)
    || Object.keys(config.claims).some(key => key !== 'releaseGone') || typeof config.claims.releaseGone !== 'boolean') {
    problems.push('claims.releaseGone is a boolean; false preserves ordinary claim leases');
  }
  if (!config.claim || typeof config.claim !== 'object' || Array.isArray(config.claim)
    || !Number.isSafeInteger(config.claim.reopenFirstRefusalMinutes) || config.claim.reopenFirstRefusalMinutes < 0
    || config.claim.reopenFirstRefusalMinutes > Math.floor(8_640_000_000_000_000 / 60_000)) {
    problems.push('"claim.reopenFirstRefusalMinutes" is a non-negative whole number of minutes within the supported date range; 0 disables it');
  }
  if (!Array.isArray(config.claim?.barTestFiles) || !config.claim.barTestFiles.length || config.claim.barTestFiles.some(pattern => typeof pattern !== 'string' || !pattern || /[\[\]{}\\:\p{Cc}]/u.test(pattern) || pattern.startsWith('/') || pattern.split('/').includes('..'))) problems.push('claim.barTestFiles is a nonempty list of project test-path globs using *, ** or ?');
  if (typeof config.check?.install !== 'string') problems.push('"check.install" is an install command string');
  const timeout = typeof config.check?.timeout === 'string' ? CHECK_TIMEOUT_RE.exec(config.check.timeout) : null;
  const timeoutMs = timeout ? Number(timeout[1]) * CHECK_TIMEOUT_MS[timeout[2]] : NaN;
  if (!timeout || timeoutMs <= 0 || !Number.isFinite(timeoutMs) || timeoutMs > MAX_CHECK_TIMEOUT_MS) {
    problems.push('"check.timeout" is a positive duration no longer than 2,147,483,647ms, like "5m"');
  }
  if (config.verify?.unrelatedTrunkMoves !== undefined && typeof config.verify.unrelatedTrunkMoves !== 'boolean') {
    problems.push('"verify.unrelatedTrunkMoves" is true or false');
  }
  if (config.map?.slice !== undefined && typeof config.map.slice !== 'boolean') {
    problems.push('"map.slice" is true or false');
  }
  if (!Number.isFinite(config.verify?.reviewRatio) || config.verify.reviewRatio <= 0) {
    problems.push('"verify.reviewRatio" is a positive number, such as 3');
  }
  if (typeof config.agents !== 'object' || config.agents === null || Array.isArray(config.agents)) {
    problems.push('"agents" is an object with a names option');
  } else if (!['suffix', 'prefix'].includes(config.agents.names)) {
    problems.push('"agents.names" is "suffix" or "prefix"');
  }
  if (!isStringList(config.shared)) problems.push('"shared" is a list of path prefixes');
  const isFixer = (fixer) => typeof fixer?.run === 'string' && fixer.run.trim() && (fixer.files === undefined || isStringList(fixer.files));
  if (!Array.isArray(config.fix) || !config.fix.every(isFixer)) {
    problems.push('"fix" is a list of { "run": "<command that fixes the files it is given>", "files": ["*.ts"] }');
  }
  if (typeof config.lanes !== 'object' || config.lanes === null || Array.isArray(config.lanes)) {
    problems.push('"lanes" maps lane names to { owns, specs, starts }');
  } else {
    for (const [name, lane] of Object.entries(config.lanes)) problems.push(...laneProblems(name, lane));
  }
  const products = config.products;
  if (typeof products !== 'object' || products === null || Array.isArray(products)) {
    problems.push('"products" maps product names to lists of spec ids or section letters, like { "CLI": ["B", "N26"] }');
  } else {
    for (const [name, entries] of Object.entries(products)) {
      if (!name.trim() || !isStringList(entries) || !entries.length) problems.push(`product "${name}": a list of spec ids or section letters, like ["B", "N26"]`);
    }
  }
  if (!isStringList(config.commits.types)) problems.push('"commits.types" is a list of words');
  if (!isStringList(config.commits.requireIds)) problems.push('"commits.requireIds" is a list of types');
  if (!isStringList(config.commits.banned)) problems.push('"commits.banned" is a list of words');
  if (typeof config.commits.noHostName !== 'boolean') problems.push('"commits.noHostName" is true or false: whether a submit naming this machine is refused');
  if (!isStringList(config.protect.blocked) || !isStringList(config.protect.allowed)) {
    problems.push('"protect.blocked" and "protect.allowed" are lists of file patterns');
  }
  return problems;
}

/**
 * The repo's config, merged over the defaults and checked.
 *
 * @param {string} root
 * @returns {any}
 */
export function loadConfig(root) {
  const file = join(root, CONFIG_FILE);
  if (!existsSync(file)) {
    throw new Refused('NO_CONFIG', `no ${CONFIG_FILE} in ${root}; run: pullboard init`);
  }
  const config = configFromSource(readFileSync(file, 'utf8'));
  return { ...config, practice: doctrineFile(root, config.practice) };
}

/** Resolve the doctrine's current name while preserving legacy and explicitly configured paths. */
export function doctrineFile(root, name = DOCTRINE_FILE) {
  if (![DOCTRINE_FILE, LEGACY_DOCTRINE_FILE].includes(name)) return name;
  const current = existsSync(join(root, DOCTRINE_FILE));
  const legacy = existsSync(join(root, LEGACY_DOCTRINE_FILE));
  if (current && legacy) {
    throw new Refused('BAD_CONFIG', `${DOCTRINE_FILE} and ${LEGACY_DOCTRINE_FILE} both define the repo doctrine; restore one doctrine file: merge their rules into ${DOCTRINE_FILE} and remove ${LEGACY_DOCTRINE_FILE}`);
  }
  return current ? DOCTRINE_FILE : legacy ? LEGACY_DOCTRINE_FILE : name;
}

/** The ceiling for a frozen check: a configured landing.timeout when set, else check.timeout (#1760). */
export function frozenCheckCeilingMs(config) { return config.landing?.timeoutMs ?? config.check.timeoutMs; }

/** Parse committed coordinator settings with the same defaults and validation as local settings. */
export function configFromSource(source) {
  let raw;
  try { raw = JSON.parse(source); }
  catch { throw new Refused('BAD_CONFIG', 'pullboard.json is not valid JSON; restore the coordinator configuration'); }
  const config = merge(defaults(), raw);
  const problems = configProblems(config);
  if (problems.length) throw new Refused('BAD_CONFIG', `${CONFIG_FILE}: ${problems.join('; ')}`);
  const timeout = CHECK_TIMEOUT_RE.exec(config.check.timeout);
  return {
    ...config,
    check: { ...config.check, timeoutMs: Number(timeout[1]) * CHECK_TIMEOUT_MS[timeout[2]] },
    ...(config.landing ? { landing: { ...config.landing, ...Object.fromEntries(['timeout', 'cadence'].filter(key => config.landing[key] !== undefined).map(key => { const value = CHECK_TIMEOUT_RE.exec(key === 'cadence' && typeof config.landing[key] === 'object' ? config.landing[key].every : config.landing[key]); return [`${key}Ms`, Number(value[1]) * CHECK_TIMEOUT_MS[value[2]]]; })) } } : {}),
    leaseMs: durationMs(config.lease),
    reviewLeaseMs: durationMs(config.reviewLease, 'reviewLease'),
  };
}

/** Validate bounded identity without substituting this host for an unknown old receipt. */
export function environmentProblem(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).length !== 3 || !['platform', 'arch', 'node'].every(key => Object.hasOwn(value, key))) return 'needs platform, arch and node';
  if (!['platform', 'arch'].every(key => typeof value[key] === 'string' && /^[a-z0-9_]{1,32}$/u.test(value[key]))) return 'platform and arch are bounded system identifiers';
  if (typeof value.node !== 'string' || value.node.length > 80 || !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/u.test(value.node)) return 'node names one exact Node version';
  return '';
}

const DURATION = /^(\d+)(ms|s|m|h|d)$/u;
const UNITS = { ms: 1, s: 1_000, m: 60_000, h: 3_600_000, d: 86_400_000 };

/** Parse the existing bounded duration syntax without changing its timeout-compatible range. */
export function cadenceMilliseconds(value) {
  const match = typeof value === 'string' && DURATION.exec(value);
  const ms = match ? Number(match[1]) * UNITS[match[2]] : NaN;
  return Number.isFinite(ms) && ms > 0 && ms <= 2_147_483_647 ? ms : null;
}

/** Validate only the new object form; unknown keys cannot silently create a scheduling policy. */
function cadenceProblem(value) {
  if (value === undefined || cadenceMilliseconds(value) !== null) return null;
  if (value && typeof value === 'object' && !Array.isArray(value)
    && Object.keys(value).every(key => ['every', 'accepted'].includes(key))
    && cadenceMilliseconds(value.every) !== null && Number.isSafeInteger(value.accepted) && value.accepted > 0) return null;
  return '"landing.cadence" is a positive duration, or {every: "10m", accepted: 5} with a positive whole accepted count';
}

/** The shipped view port and optional process override [N26]. */
export const DEFAULT_VIEW_PORT = 4890;

/** Resolve an omitted --port; explicit command-line ports take precedence over this setting. */
export function defaultViewPort(env = process.env) {
  const value = env.PULLBOARD_VIEW_PORT;
  if (value === undefined) return DEFAULT_VIEW_PORT;
  if (!/^\d+$/u.test(value) || Number(value) > 65535) {
    throw new Refused('USAGE', 'PULLBOARD_VIEW_PORT is a number from 0 to 65535; unset it to use the default port');
  }
  return Number(value);
}
