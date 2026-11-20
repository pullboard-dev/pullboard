/** Captured whole-file obligations share one signed, frozen project command [V2,V4]. */
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { briefFiles } from '../../../../items/index.js';
import { git } from '../../../../git/index.js';
import { Refused } from '../../../../kernel/index.js';
import { fileSystemAdapter } from '../../../../fs/index.js';

const fs = fileSystemAdapter();

const HASH = /^[a-f0-9]{64}$/u;
const COMMIT = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u;
/** Match the coordinator's literal test-path glob, without evaluating shell syntax. */
export function barTestPath(path, patterns) {
  return patterns.some(pattern => {
    const source = pattern.split(/(\*\*\/|\*\*|\*|\?)/u).map(part => part === '**/' ? '(?:.*/)?' : part === '**' ? '.*'
      : part === '*' ? '[^/]*' : part === '?' ? '[^/]' : part.replace(/[.+^$()|[\]{}\\]/gu, '\\$&')).join('');
    return new RegExp(`^${source}$`, 'u').test(path);
  });
}
/** Only literal project-relative paths become arguments to the accepted project runner. */
function projectPath(path) { return typeof path === 'string' && path.length > 0 && !/[:\\\p{Cc}]/u.test(path) && path.split('/').every(part => part && part !== '.' && part !== '..'); }
/** Measurements retain their source, runtime and whole-file provenance; the peer judges adequacy. */
function observation(value, selection) {
  return value && Number.isFinite(value.durationMs) && value.durationMs >= 0 && value.selection === selection
    && typeof value.ref === 'string' && value.ref.trim() && value.ref.length <= 4096 && HASH.test(value.sha256)
    && COMMIT.test(value.source) && typeof value.runtime === 'string' && value.runtime.trim()
    && ['pass', 'timeout', 'fail'].includes(value.outcome);
}
/** Validate captured evidence without opening a replica's files or running a command during replay. */
export function normalizeBarCoverage(value, item) {
  const bad = detail => { throw new Refused('BAR_COVERAGE', `${detail}; supply --coverage-file with recorded whole-file evidence before pullboard bar sign ${item.item_id}`); };
  if (!value || value.version !== 1 || !COMMIT.test(value.sourceMain) || value.sourceCheck !== item.item_check
    || !HASH.test(value.policyKey) || !Number.isSafeInteger(value.timeoutMs) || value.timeoutMs <= 0 || typeof value.runner !== 'string'
    || !Array.isArray(value.required) || value.required.some(path => !projectPath(path)) || !Array.isArray(value.files)) bad('the coverage plan must bind accepted main, its timeout, test paths and the original named check');
  const required = [...new Set(value.required)].sort();
  const files = value.files.map(file => {
    if (!file || !required.includes(file.path) || !['whole','landing'].includes(file.mode) || !observation(file.evidence, 'whole-file')) bad('each existing brief test needs a whole-file observation and whole/landing mode');
    if (file.mode === 'whole' && file.evidence.outcome !== 'pass') bad(`${file.path} has no completed green whole-file duration`);
    if (file.mode === 'landing' && (!Array.isArray(file.namedCases) || !file.namedCases.length || file.namedCases.some(name => typeof name !== 'string' || !name.trim())
      || !item.item_check.includes(file.path) || !String(item.item_brief).includes(file.path) || !/landing/iu.test(item.item_brief))) bad(`${file.path} needs explicit landing coverage and named cases retained in its original check`);
    return { path: file.path, mode: file.mode, evidence: { ...file.evidence }, ...(file.mode === 'landing' ? { namedCases: [...file.namedCases] } : {}) };
  }).sort((a,b) => a.path.localeCompare(b.path));
  if (files.length !== required.length || new Set(files.map(file => file.path)).size !== required.length) bad('the coverage rows must name each required file exactly once');
  if (files.length && (!observation(value.named, 'named-check') || value.named.outcome !== 'pass' && value.named.outcome !== 'fail')) bad('the original named command needs a recorded duration');
  if (files.length && (!Number.isFinite(value.installMs) || value.installMs < 0 || value.installMs && !observation(value.install, 'install'))) bad('the plan needs the accepted install duration (zero only when no install is configured)');
  const fixed = files.length ? value.named.durationMs + value.installMs : 0;
  if (files.some(file => file.mode === 'landing' && file.evidence.durationMs + fixed <= value.timeoutMs)) bad('a landing exception needs a recorded whole-file duration exceeding the available review budget');
  const totalMs = fixed + files.filter(file => file.mode === 'whole').reduce((sum,file) => sum + file.evidence.durationMs, 0);
  if (totalMs > value.timeoutMs) bad('the recorded named, install and whole-file durations together exceed the unchanged review timeout');
  if (files.some(file => file.mode === 'whole') && !value.runner.trim()) bad('configure the project affectedTests command; Pullboard never substitutes its own test runner');
  return { version: 1, sourceMain: value.sourceMain, policyKey: value.policyKey, sourceCheck: value.sourceCheck, timeoutMs: value.timeoutMs,
    runner: value.runner, required, files, totalMs, ...(files.length ? { named: { ...value.named }, installMs: value.installMs, ...(value.install ? { install: { ...value.install } } : {}) } : {}) };
}
/** Bind inventory and accepted execution settings, allowing unrelated main changes without resigning. */
function coverageInputs(root, item, policy, inventory) {
  const committed = inventory ?? new Set(git(root, ['ls-tree', '-r', '--name-only', '-z', policy.commit]).split('\0').filter(Boolean));
  const required = [...new Set(briefFiles(item.item_brief).filter(path => committed.has(path) && barTestPath(path, policy.config.claim.barTestFiles)))].sort();
  const policyKey = createHash('sha256').update(JSON.stringify({ required, runner: policy.config.affectedTests ?? '',
    install: policy.config.check.install, timeoutMs: policy.config.check.timeoutMs, patterns: policy.config.claim.barTestFiles })).digest('hex');
  return { required, policyKey };
}
/** Revalidate the signed inventory and runner at the frozen policy, never silently replan its proof. */
export function barCoverageForPolicy(root, item, plan, policy) {
  if (coverageInputs(root, item, policy).policyKey !== plan.policyKey) {
    throw new Refused('BAR_NOT_READY', `#${item.item_id}'s accepted test inventory, runner, install or timeout changed after signing; another session must read the new policy and run pullboard bar sign ${item.item_id} with current coverage`);
  }
  return plan;
}
/** Resolve existing brief test paths at accepted main; the project explicitly configures non-Node globs. */
export function prepareBarCoverage(root, item, policy, file) {
  const { required, policyKey } = coverageInputs(root, item, policy);
  let supplied = {};
  if (file) {
    const path = resolve(root, file);
    try {
      if (fs.stat(path).size > 262144) throw new Error('oversize');
      supplied = JSON.parse(fs.readFile(path, 'utf8'));
    } catch { throw new Refused('BAR_COVERAGE', 'the coverage file must be readable JSON no larger than 256 KiB; correct --coverage-file'); }
  }
  if (required.length && !file) throw new Refused('BAR_COVERAGE', `record whole-file timing evidence for ${required.join(', ')} in --coverage-file; an unknown duration is not a slow-file exception`);
  if (policy.config.check.install && required.length && (!observation(supplied.install, 'install') || supplied.installMs !== supplied.install.durationMs)) throw new Refused('BAR_COVERAGE', 'the accepted install command needs its own recorded duration in --coverage-file');
  if (!policy.config.check.install) supplied.installMs = 0;
  return normalizeBarCoverage({ ...supplied, version: 1, sourceMain: policy.commit, sourceCheck: item.item_check,
    timeoutMs: policy.config.check.timeoutMs, policyKey, runner: policy.config.affectedTests ?? '', required, files: supplied.files ?? [] }, item);
}
/** Digest every captured input so a signature cannot be transplanted to another coverage plan. */
export function barCoverageDigest(plan) { return createHash('sha256').update(JSON.stringify(plan)).digest('hex'); }
/** Group the original shell check intact, then use only the accepted project's own runner for whole files. */
export function barCoverageCommand(sourceCheck, plan) {
  const paths = plan.files.filter(file => file.mode === 'whole').map(file => `'./${file.path.replaceAll("'", "'\\''")}'`);
  return paths.length ? `(\n${sourceCheck}\n) && (\n${plan.runner} ${paths.join(' ')}\n)` : sourceCheck;
}

/** Build sealed phone previews with one accepted inventory read; missing measured evidence remains missing. */
export function previewBarCoverage(root, entries, policy) {
  const inventory = new Set(git(root, ['ls-tree', '-r', '--name-only', '-z', policy.commit]).split('\0').filter(Boolean));
  return entries.map(({ item, coverage }) => {
    const { required, policyKey } = coverageInputs(root, item, policy, inventory);
    if (coverage) {
      const plan = normalizeBarCoverage(coverage, item);
      if (plan.policyKey === policyKey && plan.sourceCheck === item.item_check) return plan;
    }
    if (required.length) return null;
    return normalizeBarCoverage({ version: 1, sourceMain: policy.commit, sourceCheck: item.item_check, policyKey,
      timeoutMs: policy.config.check.timeoutMs, runner: policy.config.affectedTests ?? '', required: [], files: [] }, item);
  });
}
