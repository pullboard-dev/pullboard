/**
 * Doctrine checks with a count that only falls (D1, D3). A rule row may carry
 * `| gate: check <command> | count: N`, and `| files: <paths>` to narrow it; the command prints one
 * line per problem and exits 0 or 1. Submit holds every touched rule's count at or below its
 * committed count and refuses a changed file that gains a problem. Rules come only from committed
 * doctrine: accepted main's at submit, HEAD's for `pullboard doctrine check`, never a working-tree
 * edit.
 */
import { spawnSync } from 'node:child_process';
import {
  mkdtempSync,
  rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  DOCTRINE_FILE,
  LEGACY_DOCTRINE_FILE,
} from './config.js';
import {
  cleanGitEnvironment,
  gitChildEnv,
  invalidateGitFacts,
} from './git.js';
import { Refused } from './refused.js';
import {
  checkFieldFindings,
  parseSpec,
} from './spec.js';

const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000;

/**
 * A row's check rule, or null when the row carries no well-formed check. Malformed check fields
 * are lint errors in `pullboard spec check`; here they simply carry no rule.
 *
 * @param {any} row
 * @returns {{ id: string, text: string, status: string, command: string, count: number, runs: string, mode: string, files: string[] } | null}
 */
export function checkRule(row) {
  if (!/^check\s/u.test(row?.gate ?? '') || checkFieldFindings(row).length) return null;
  return { id: row.id, text: row.text, status: row.status, command: row.gate.slice('check'.length).trim(),
    count: Number(row.count), runs: row.runs ?? 'submit', mode: row.mode ?? 'hold', files: ruleFiles(row.files) };
}

/** A row's `files:` paths, comma or space separated, without `./` or a trailing slash; none is the whole repo. */
export function ruleFiles(value) {
  return [...new Set(String(value ?? '').split(/[\s,]+/u).map((path) => path.replace(/^\.\//u, '').replace(/\/+$/u, '')).filter(Boolean))];
}

/**
 * How an approved row's new version loosens its check, or '' when it does not. Lowering count:
 * is free; anything that lets more problems through needs the person's signature.
 *
 * @param {any} before - The committed row.
 * @param {any} after - The staged row with the same id.
 * @returns {string}
 */
export function checkLoosening(before, after) {
  const old = checkRule(before);
  if (!old) return '';
  // Only approved rows are enforced, so any other status takes the check out of force.
  if (before.status === 'approved' && after.status !== 'approved') return `takes its check out of force (${after.status})`;
  const next = checkRule(after);
  if (!next) return 'drops its check';
  if (next.command !== old.command) return 'changes its check command';
  if (next.count > old.count) return `raises count: from ${old.count} to ${next.count}`;
  if (old.mode === 'hold' && next.mode === 'watch') return 'sets mode: watch';
  if (old.runs === 'submit' && next.runs === 'nightly') return 'moves its check to runs: nightly';
  // files: narrows a rule: adding it to a whole-repo rule, or dropping a path, covers less.
  if ((!old.files.length && next.files.length) || old.files.some((path) => !next.files.includes(path))) return 'narrows its files:';
  return '';
}

/** Read one file's committed bytes at a revision, or null when the revision lacks it. */
function gitShow(root, revision, file) {
  const result = spawnSync('git', ['--no-replace-objects', 'show', `${revision}:${file}`], { cwd: root, env: cleanGitEnvironment(), encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
  return result.status === 0 ? result.stdout : null;
}

/** Run git for a list of names or a commit id, or null when git refuses. */
function gitOut(root, args) {
  const result = spawnSync('git', ['--no-replace-objects', '-c', 'core.quotepath=false', ...args], { cwd: root, env: cleanGitEnvironment(), encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
  return result.status === 0 ? result.stdout : null;
}

/**
 * The approved check rules in the doctrine committed at a revision, following the conventional
 * DOCTRINE.md / PRACTICE.md rename so a renamed file keeps its rules.
 *
 * @param {string} root
 * @param {string} revision
 * @param {string} [name] - The configured doctrine file.
 * @returns {ReturnType<typeof checkRule>[]}
 */
export function checkRulesAt(root, revision, name = DOCTRINE_FILE) {
  let source = gitShow(root, revision, name);
  if (source === null && [DOCTRINE_FILE, LEGACY_DOCTRINE_FILE].includes(name)) {
    source = gitShow(root, revision, name === DOCTRINE_FILE ? LEGACY_DOCTRINE_FILE : DOCTRINE_FILE);
  }
  if (source === null) return [];
  let parsed;
  try { parsed = parseSpec(source, { strictGrammarVersion: false }); } catch { return []; }
  return parsed.rows.filter((row) => row.status === 'approved').map(checkRule).filter(Boolean);
}

/**
 * Run one check where it stands and keep each non-empty output line as a problem. Exit 0 or 1 is
 * counted (`grep` exits 1 when it finds nothing); any other exit, a signal or a timeout cannot
 * count, so its error lines never pass for problems.
 *
 * @param {string} cwd
 * @param {string} command
 * @param {number} timeoutMs
 * @param {NodeJS.ProcessEnv} [gateEnvironment] Child markers supplied by an actual acquired gate lease.
 * @returns {{ problems: string[], broken: string, seconds: number }}
 */
export function runRuleCheck(cwd, command, timeoutMs = DEFAULT_TIMEOUT_MS, gateEnvironment = {}) {
  const started = Date.now();
  const result = spawnSync(`(\n${command}\n) 2>&1`, {
    cwd, env: { ...gitChildEnv(cwd), ...gateEnvironment }, shell: true, stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8',
    timeout: timeoutMs, killSignal: 'SIGKILL', maxBuffer: 64 * 1024 * 1024,
  });
  invalidateGitFacts();
  const seconds = Math.round((Date.now() - started) / 1000);
  if (result.error) {
    const broken = result.error.code === 'ETIMEDOUT' ? `timed out after ${Math.round(timeoutMs / 1000)}s` : `could not run (${result.error.code ?? 'error'})`;
    return { problems: [], broken, seconds };
  }
  if (result.signal) return { problems: [], broken: `was killed by ${result.signal}`, seconds };
  if (result.status !== 0 && result.status !== 1) return { problems: [], broken: `exited ${result.status}`, seconds };
  const output = `${result.stdout ?? ''}${result.stderr ?? ''}`;
  return { problems: output.split(/\r?\n/u).map((line) => line.trimEnd()).filter((line) => line.trim()), broken: '', seconds };
}

/** True when a changed path is one of a rule's watched paths or lies under one. */
function inScope(scope, path) {
  return !scope.length || scope.some((watched) => path === watched || path.startsWith(`${watched}/`));
}

/** True when a problem line starts with the file's repo path, as `path:...` or `./path:...`. */
function namesFile(line, file) {
  return line.startsWith(`${file}:`) || line.startsWith(`./${file}:`);
}

/** A problem line without its line number, so a moved problem is not counted as new. */
function problemKey(line) {
  return line.replace(/:\d+:/u, '::').trim();
}

/** The lines in `after` beyond those in `before`, compared without line numbers. */
function newLines(before, after) {
  const left = new Map();
  for (const line of before) left.set(problemKey(line), (left.get(problemKey(line)) ?? 0) + 1);
  return after.filter((line) => {
    const key = problemKey(line);
    const remaining = left.get(key) ?? 0;
    if (remaining > 0) { left.set(key, remaining - 1); return false; }
    return true;
  });
}

/**
 * One rule's line, as `pullboard doctrine check` and submit print it:
 * `D9 No silent catch · 9, was 12 · holding`.
 *
 * @param {{ id: string, text: string, count: number, committed: number, state: string, broken?: string }} result
 * @returns {string}
 */
export function ruleLine(result) {
  const counts = result.broken ? `cannot count: its check ${result.broken}, was ${result.committed}` : `${result.count}, was ${result.committed}`;
  return `${result.id} ${result.text} · ${counts} · ${result.state}`;
}

/** Name how a rule stands: a check that cannot count never holds; watching never refuses a count. */
function ruleState(rule, count, committed, broken) {
  if (broken) return 'uncounted';
  if (rule.mode === 'watch') return 'watching';
  return count <= committed ? 'holding' : 'rose';
}

/**
 * Count every committed rule's problems in this checkout (`pullboard doctrine check`). Rules come
 * from HEAD's committed doctrine; the command runs over the working tree, so a builder sees the
 * count its next commit would carry.
 *
 * @param {string} root
 * @param {{ practice?: string, check?: { timeoutMs?: number } }} config
 * @returns {{ id: string, text: string, command: string, count: number, committed: number, holds: boolean, state: string, mode: string, runs: string, problems: string[], broken: string }[]}
 */
export function doctrineReport(root, config) {
  return checkRulesAt(root, 'HEAD', config.practice).map((rule) => {
    const run = runRuleCheck(root, rule.command, config.check?.timeoutMs);
    const count = run.problems.length;
    const state = ruleState(rule, count, rule.count, run.broken);
    return { id: rule.id, text: rule.text, command: rule.command, count, committed: rule.count,
      holds: state === 'holding' || state === 'watching', state, mode: rule.mode, runs: rule.runs, problems: run.problems, broken: run.broken };
  });
}

/** True when the accepted main doctrine has a rule submit must run; a repo without one skips it all. */
export function hasSubmitRules(root, mainCommit, practice) {
  return checkRulesAt(root, mainCommit, practice).some((rule) => rule.runs === 'submit');
}

/** Run a check at an exact commit in a private shared clone, leaving every live worktree alone. */
function runAtCommit(root, commit, command, timeoutMs) {
  const directory = mkdtempSync(join(tmpdir(), 'pullboard-doctrine-base-'));
  const checkout = join(directory, 'checkout');
  const env = gitChildEnv(root);
  try {
    const clone = spawnSync('git', ['clone', '--quiet', '--shared', '--no-checkout', '--', root, checkout], { env, stdio: 'ignore' });
    const selected = clone.status === 0 && spawnSync('git', ['-c', 'core.hooksPath=/dev/null', 'checkout', '--quiet', '--detach', commit], { cwd: checkout, env, stdio: 'ignore' });
    if (!selected || selected.status !== 0) return { problems: [], broken: 'could not check out the base commit', seconds: 0 };
    return runRuleCheck(checkout, command, timeoutMs);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

/**
 * Hold the doctrine's counts for a submission. Rules, commands and modes come from accepted main;
 * the submitted commit may only lower a count. Each touched rule runs at the clean submitted
 * checkout; a changed file's problems are compared with the merge base only when it has any.
 * Refuses RATCHET_ROSE with the rule, its counts and the new problem lines.
 *
 * @param {string} root - The clean submitting checkout, at `commit`.
 * @param {{ mainCommit: string, commit: string, practice?: string, timeoutMs?: number }} options
 * @returns {ReturnType<typeof doctrineReport>}
 */
export function holdDoctrine(root, { mainCommit, commit, practice = DOCTRINE_FILE, timeoutMs = DEFAULT_TIMEOUT_MS }) {
  const rules = checkRulesAt(root, mainCommit, practice).filter((rule) => rule.runs === 'submit');
  if (!rules.length) return [];
  const lowered = new Map(checkRulesAt(root, commit, practice).map((rule) => [rule.id, rule.count]));
  const base = (gitOut(root, ['merge-base', mainCommit, commit]) ?? '').trim() || mainCommit;
  const changed = (gitOut(root, ['diff', '-z', '--no-renames', '--name-only', base, commit, '--']) ?? '').split('\0').filter(Boolean);
  const results = [];
  const refusals = [];
  const uncounted = [];
  for (const rule of rules) {
    if (!changed.some((path) => inScope(rule.files, path))) continue;
    const committed = Math.min(rule.count, lowered.get(rule.id) ?? rule.count);
    const run = runRuleCheck(root, rule.command, timeoutMs);
    const count = run.problems.length;
    const state = ruleState(rule, count, committed, run.broken);
    const result = { id: rule.id, text: rule.text, command: rule.command, count, committed,
      holds: state === 'holding' || state === 'watching', state, mode: rule.mode, runs: rule.runs, problems: run.problems, broken: run.broken };
    results.push(result);
    const name = `${rule.id} ${rule.text}`;
    // A broken check never passes, whatever its mode.
    if (run.broken) {
      uncounted.push(`${name} cannot count: its check ${run.broken}`);
      continue;
    }
    if (rule.mode === 'watch') continue;
    const touched = changed.filter((path) => run.problems.some((line) => namesFile(line, path)));
    const before = touched.length ? runAtCommit(root, base, rule.command, timeoutMs) : { problems: [], broken: '' };
    if (count > committed) {
      const fresh = newLines(before.broken ? [] : before.problems, run.problems);
      refusals.push(`${name} rose to ${count}, was ${committed}; new problems:\n${(fresh.length ? fresh : run.problems).map((line) => `  ${line}`).join('\n')}`);
      continue;
    }
    if (before.broken) {
      uncounted.push(`${name} cannot count at the base ${base.slice(0, 12)}: its check ${before.broken}`);
      continue;
    }
    for (const path of touched) {
      const now = run.problems.filter((line) => namesFile(line, path));
      const then = before.problems.filter((line) => namesFile(line, path));
      if (now.length <= then.length) continue;
      const gained = now.length - then.length;
      const fresh = newLines(then, now);
      refusals.push(`${name}: ${path} gains ${gained} problem${gained === 1 ? '' : 's'}, had ${then.length}:\n${(fresh.length ? fresh : now).map((line) => `  ${line}`).join('\n')}`);
    }
  }
  if (uncounted.length) {
    throw new Refused('RATCHET_UNCOUNTED', `${uncounted.join('\n')}\na check exits 0 or 1 within its timeout; fix the check, or ask the coordinator to, then submit again`);
  }
  if (refusals.length) {
    throw new Refused('RATCHET_ROSE', `${refusals.join('\n')}\nthe doctrine holds these counts; fix the new problems, commit, and submit again; only the person's signature raises count:`);
  }
  return results;
}
