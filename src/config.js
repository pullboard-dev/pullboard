/**
 * `pullboard.json`: the gate, the spec file, the lanes and the commit rules. Read once per command,
 * merged over defaults, and checked, so a typo refuses with its field name instead of misbehaving.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Refused } from './refused.js';

export const CONFIG_FILE = 'pullboard.json';
export const COORDINATOR = 'coordinator';

const LANE_NAME_RE = /^[a-z][a-z0-9-]{0,30}$/;
const DURATION_RE = /^(\d+)(m|h|d)$/;
const UNIT_MS = { m: 60_000, h: 3_600_000, d: 86_400_000 };
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
    practice: 'PRACTICE.md',
    gate: '',
    lease: '2h',
    reviewLease: '30m',
    verify: { policy: 'any', family: 'off', reviewRatio: 3 },
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
  return {
    ...base,
    ...raw,
    commits: { ...base.commits, ...(raw.commits ?? {}) },
    protect: { ...base.protect, ...(raw.protect ?? {}) },
    verify: typeof raw.verify === 'string'
      ? { ...base.verify, policy: raw.verify }
      : { ...base.verify, ...(raw.verify ?? {}) },
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
  if (typeof config.practice !== 'string' || !config.practice) problems.push('"practice" names a file');
  if (typeof config.gate !== 'string') problems.push('"gate" is a shell command, like "npm test"');
  if (!['any', COORDINATOR].includes(config.verify?.policy)) {
    problems.push('"verify.policy" is "any" (any other agent) or "coordinator"');
  }
  if (!['off', 'prefer', 'require'].includes(config.verify?.family)) {
    problems.push('"verify.family" is "off", "prefer" or "require"');
  }
  if (!Number.isFinite(config.verify?.reviewRatio) || config.verify.reviewRatio <= 0) {
    problems.push('"verify.reviewRatio" is a positive number, such as 3');
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
  return configFromSource(readFileSync(file, 'utf8'));
}

/** Parse committed coordinator settings with the same defaults and validation as local settings. */
export function configFromSource(source) {
  let raw;
  try { raw = JSON.parse(source); }
  catch { throw new Refused('BAD_CONFIG', 'pullboard.json is not valid JSON; restore the coordinator configuration'); }
  const config = merge(defaults(), raw);
  const problems = configProblems(config);
  if (problems.length) throw new Refused('BAD_CONFIG', `${CONFIG_FILE}: ${problems.join('; ')}`);
  return { ...config, leaseMs: durationMs(config.lease), reviewLeaseMs: durationMs(config.reviewLease, 'reviewLease') };
}
