import { spawnCaptured } from '../../../sandbox/index.js';
import { withPathMapMoves } from './paths.js';
import { fileURLToPath } from 'node:url';
import { checkReceiptKey } from '../../../git/index.js';
import { sameCommonDir } from '../../../git/index.js';
import { mainCheckout } from '../../../git/index.js';
import { checkCommandDefinition } from '../../../git/index.js';
import { cleanTree } from '../../../git/index.js';
import { readCheckReceipt } from '../../../git/index.js';
import { writeCheckReceipt } from '../../../git/index.js';
import { receiptLine } from '../../../git/index.js';
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
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname } from 'node:path';
import { join } from 'node:path';
import {
  DOCTRINE_FILE,
  LEGACY_DOCTRINE_FILE,
} from '../../../config/index.js';
import {
  cleanGitEnvironment,
  gitChildEnv,
  invalidateGitFacts,
} from '../../../git/index.js';
import { Refused } from '../../../kernel/index.js';
import { createFastPass } from './fast.js';
import { fastCheckScript } from './fast.js';
import { baseCheckouts } from './checkouts.js';
import { lex } from '../../../kernel/index.js';
import { machineHome } from '../../../resources/index.js';
import { gitSpawnSync } from '../../../git/index.js';
import {
  checkFieldFindings,
  parseSpec,
} from '../../../spec/index.js';
import { mkdtempSync } from 'node:fs';
import { scratchBase } from '../../../kernel/light.js';
import { storeName } from './store-names.js';

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
  const result = gitSpawnSync(['--no-replace-objects', 'show', `${revision}:${file}`], { cwd: root, env: cleanGitEnvironment(), encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
  return result.status === 0 ? result.stdout : null;
}

/** Run git for a list of names or a commit id, or null when git refuses. */
function gitOut(root, args) {
  const result = gitSpawnSync(['--no-replace-objects', '-c', 'core.quotepath=false', ...args], { cwd: root, env: cleanGitEnvironment(), encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
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
function* ruleCheckExecution(cwd, command, timeoutMs = DEFAULT_TIMEOUT_MS, gateEnvironment = {}) {
  const key = checkReceiptKey(cwd, { kind: 'doctrine', definition: command, config: { timeoutMs }, code: [fileURLToPath(import.meta.url)] });
  const receipt = readCheckReceipt(cwd, key);
  if (receipt && Array.isArray(receipt.result?.problems) && receipt.result.broken === '') {
    process.stderr.write(`${receiptLine(receipt)}\n`);
    return receipt.result;
  }
  const started = Date.now();
  const result = yield { command: `(\n${command}\n) 2>&1`, options: {
    cwd, env: { ...gitChildEnv(cwd), ...gateEnvironment }, shell: true, stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8',
    timeout: timeoutMs, killSignal: 'SIGKILL', maxBuffer: 64 * 1024 * 1024,
  } };
  invalidateGitFacts();
  const seconds = Math.round((Date.now() - started) / 1000);
  if (result.error) {
    const broken = result.error.code === 'ETIMEDOUT' ? `timed out after ${Math.round(timeoutMs / 1000)}s` : `could not run (${result.error.code ?? 'error'})`;
    return { problems: [], broken, seconds };
  }
  if (result.signal) return { problems: [], broken: `was killed by ${result.signal}`, seconds };
  if (result.status !== 0 && result.status !== 1) return { problems: [], broken: `exited ${result.status}`, seconds };
  const output = `${result.stdout ?? ''}${result.stderr ?? ''}`;
  const counted = { problems: output.split(/\r?\n/u).map((line) => line.trimEnd()).filter((line) => line.trim()), broken: '', seconds };
  writeCheckReceipt(cwd, key, { result: counted });
  return counted;
}

/** Run a rule synchronously without changing the established counted-exit contract. */
export function runRuleCheck(cwd, command, timeoutMs, gateEnvironment) {
  const execution = ruleCheckExecution(cwd, command, timeoutMs, gateEnvironment);
  const step = execution.next();
  return step.done ? step.value : execution.next(spawnSync(step.value.command, step.value.options)).value;
}

/** Await a bounded rule child while preserving exactly the same ratchet result fields. */
export async function runRuleCheckAsync(cwd, command, timeoutMs, gateEnvironment) {
  const execution = ruleCheckExecution(cwd, command, timeoutMs, gateEnvironment);
  const step = execution.next();
  return step.done ? step.value : execution.next(await spawnCaptured(step.value.command, [], step.value.options)).value;
}

/** True when a changed path is one of a rule's watched paths or lies under one. */
function inScope(scope, path) {
  return !scope.length || scope.some((watched) => path === watched || path.startsWith(`${watched}/`));
}

/** True when a problem line starts with the file's repo path, as `path:...` or `./path:...`. */
function namesFile(line, file) {
  return line.startsWith(`${file}:`) || line.startsWith(`./${file}:`);
}

/** True only for a nonempty module of re-exports; comments and literal text cannot hide code. */
function reexportOnly(source) {
  if (source === null) return false;
  const name = '[A-Za-z_$][\\w$]*';
  const binding = `${name}(?:\\s+as\\s+${name})?`;
  const names = `\\{\\s*(?:${binding}(?:\\s*,\\s*${binding})*\\s*,?)?\\s*\\}`;
  const star = `\\*(?:\\s+as\\s+${name})?`;
  return new RegExp(`^\\s*(?:export\\s*(?:${star}|${names})\\s+from\\s+(?:'\\s*'|"\\s*")\\s*;\\s*)+$`, 'u').test(lex(source).code);
}

/**
 * Each moved path, keyed by its new path. Git's default similarity finds renames and copies;
 * a copy counts as a move only when its old body became a re-export-only compatibility shim.
 */
function renamedOrigins(root, base, commit) {
  const parts = (gitOut(root, ['diff', '-z', '--name-status', '--find-renames', '--find-copies', base, commit, '--']) ?? '').split('\0');
  const origins = new Map();
  for (let at = 0; at < parts.length; at += 1) {
    const status = parts[at];
    if (/^R/u.test(status)) { origins.set(parts[at + 2], parts[at + 1]); at += 2; }
    else if (/^C/u.test(status)) {
      const origin = parts[at + 1];
      if (reexportOnly(gitShow(root, commit, origin)) && !reexportOnly(gitShow(root, base, origin))) {
        origins.set(parts[at + 2], origin);
      }
      at += 2;
    }
    else if (status) at += 1;
  }
  return origins;
}

/** A problem line of a renamed file's origin, restated under the file's new path. */
function carryRename(line, origins) {
  for (const [path, origin] of origins) {
    if (namesFile(line, origin)) return line.replace(origin, path);
  }
  return line;
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
 * @param {{ changed?: string[] | null }} [scope] - The paths a change touched; null reports every rule.
 * @returns {{ id: string, text: string, command: string, count: number, committed: number, holds: boolean, state: string, mode: string, runs: string, problems: string[], broken: string }[]}
 */
export function doctrineReport(root, config, { changed = null } = {}) {
  // Given the changed paths, a rule none of them is watched by or feeds its check keeps main's answer and is not run [5814].
  const touches = (rule) => !changed || changed.some((path) => inScope(rule.files, path))
    || (checkCommandDefinition(root, [rule.command]) ?? [{ path: '' }]).some((input) => input.path === '' || changed.some((path) => input.path === `project:${path}`));
  return checkRulesAt(root, 'HEAD', config.practice).filter(touches).map((rule) => {
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

/** True when every submit rule is file-local, so the hold can run in-process over the changed files with no runner. */
export function submitRulesNarrowable(root, mainCommit, practice) {
  return checkRulesAt(root, mainCommit, practice).filter((rule) => rule.runs === 'submit').every((rule) => fastCheckScript(root, rule.command));
}

/** Run a check at an exact commit in a private shared clone, leaving every live worktree alone. */
function* checkAtCommitExecution(root, commit, command, timeoutMs) {
  const directory = mkdtempSync(join(scratchBase(), 'pullboard-doctrine-base-'));
  const checkout = join(directory, 'checkout');
  const env = gitChildEnv(root);
  try {
    const clone = gitSpawnSync(['clone', '--quiet', '--shared', '--no-checkout', '--', root, checkout], { env, stdio: 'ignore' });
    const selected = clone.status === 0 && gitSpawnSync(['-c', 'core.hooksPath=/dev/null', 'checkout', '--quiet', '--detach', commit], { cwd: checkout, env, stdio: 'ignore' });
    if (!selected || selected.status !== 0) return { problems: [], broken: 'could not check out the base commit', seconds: 0 };
    return yield { checkout, command, timeoutMs };
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

/** One private base checkout of a commit for a hold to share; close removes it (#3900). */
function openBaseCheckout(root, commit) {
  const execution = checkAtCommitExecution(root, commit, '', 0), step = execution.next();
  return { checkout: step.done ? null : step.value.checkout, close: () => execution.return() };
}

/** Preserve synchronous base comparisons for existing doctrine commands. */
function runAtCommit(root, commit, command, timeoutMs) {
  const execution = checkAtCommitExecution(root, commit, command, timeoutMs);
  try {
    const step = execution.next();
    return step.done ? step.value : execution.next(runRuleCheck(step.value.checkout, command, timeoutMs)).value;
  } finally { execution.return(); }
}

/**
 * Compose current main into a candidate that lacks it, the way submit composes: a scratch merge that writes only Git
 * objects, never a checkout. Refuses MERGE_CONFLICT only when the two really conflict.
 */
function composeMain(root, tip, commit) {
  const merged = gitSpawnSync(['--no-replace-objects', 'merge-tree', '--write-tree', '--no-messages', tip, commit], { cwd: root, env: cleanGitEnvironment(), encoding: 'utf8' });
  const tree = merged.stdout?.split('\n')[0]?.trim() ?? '';
  if (merged.status === 1) throw new Refused('MERGE_CONFLICT', `the candidate ${commit.slice(0, 12)} conflicts with current main ${tip.slice(0, 12)}; merge main, resolve the conflicts, commit, and submit again`);
  if (merged.status !== 0 || !/^[a-f0-9]{40,64}$/u.test(tree)) throw new Refused('RATCHET_UNCOUNTED', 'cannot compose current main into the candidate for the doctrine hold');
  const composed = (gitOut(root, ['-c', 'user.name=Pullboard doctrine hold', '-c', 'user.email=doctrine@pullboard.invalid',
    'commit-tree', tree, '-p', commit, '-p', tip, '-m', 'Compose current main for the doctrine hold']) ?? '').trim();
  if (!/^[a-f0-9]{40,64}$/u.test(composed)) throw new Refused('RATCHET_UNCOUNTED', 'cannot record the composed candidate for the doctrine hold');
  return composed;
}

/**
 * The main a hold judges against, and the candidate it measures: the primary checkout's commit unless it is behind the
 * handed accepted main, or the hold runs in the primary checkout itself, whose HEAD is the candidate; a candidate that
 * lacks that main is always composed with it, even when the handed main already is current.
 * Why: main lands every few minutes, so a queued gate's main has usually moved; that alone never refuses (#2575).
 */
function currentMain(root, mainCommit, commit) {
  let tip = null;
  try { tip = mainCheckout(root)?.commit ?? null; } catch { /* No primary checkout: the handed main stands. */ }
  const gitDir = (gitOut(root, ['rev-parse', '--path-format=absolute', '--git-dir']) ?? '').trim();
  const commonDir = (gitOut(root, ['rev-parse', '--path-format=absolute', '--git-common-dir']) ?? '').trim();
  if (gitDir && sameCommonDir(gitDir, commonDir)) tip = null;
  const ancestor = (older, newer) => gitOut(root, ['merge-base', '--is-ancestor', older, newer]) !== null;
  const main = tip && !(tip !== mainCommit && ancestor(tip, mainCommit)) ? tip : mainCommit;
  // Whichever main stands, the counted tree is the candidate composed with it, never a candidate missing it.
  return { main, commit: ancestor(main, commit) ? commit : composeMain(root, main, commit) };
}

/** The machine-wide file caching one rule's measured problems at one main tree. */
function mainMeasureFile(tree, command, timeoutMs) {
  const key = createHash('sha256').update(JSON.stringify([1, tree, command, timeoutMs])).digest('hex');
  return join(machineHome(), 'doctrine-main', `${storeName(key)}`);
}

/**
 * Main's measured problems for one rule, run once per main tree and cached machine-wide; a broken run is never cached.
 * Why: the ratchet judges an item against what main holds now, never its frozen base or main's declared count (#2575).
 */
function* measuredMain(root, mainCommit, command, timeoutMs, scope = undefined) {
  const tree = (gitOut(root, ['rev-parse', `${mainCommit}^{tree}`]) ?? '').trim();
  const file = tree ? mainMeasureFile(tree, command, timeoutMs) : null;
  if (file) {
    try {
      const saved = JSON.parse(readFileSync(file, 'utf8'));
      if (Array.isArray(saved.problems) && saved.problems.every(line => typeof line === 'string')) return { problems: saved.problems, broken: '' };
    } catch { /* A missing or damaged entry is a miss. */ }
  }
  // A miss on a file-local rule measures only the changed paths at main, so a moved main never costs a whole-tree run [5814].
  const run = yield { commit: mainCommit, command, timeoutMs, candidate: false, main: true, ...(scope ? { scope } : {}) };
  if (file && !run.broken && !run.partial) {
    try {
      mkdirSync(dirname(file), { recursive: true });
      const temp = `${file}.${process.pid}.tmp`;
      writeFileSync(temp, JSON.stringify({ problems: run.problems }));
      renameSync(temp, file);
    } catch { /* A failed save only costs the next check a rerun. */ }
  }
  return run;
}

/**
 * Hold the doctrine's counts for a submission. Rules, commands and modes come from accepted main;
 * the submitted commit may only lower a count. Each touched rule runs at the clean submitted
 * checkout; its total and each changed file's problems are compared with current main's measured problems, which run
 * once per main commit and are cached machine-wide, never with the item's frozen base or main's declared count.
 * Refuses RATCHET_ROSE with the rule, its counts and the new problem lines.
 *
 * @param {string} root - The clean submitting checkout, at `commit`.
 * @param {{ mainCommit: string, commit: string, practice?: string, timeoutMs?: number, runCheck?: (commit:string, command:string, timeoutMs:number) => ReturnType<typeof runRuleCheck> }} options
 * @returns {ReturnType<typeof doctrineReport>}
 */
function* doctrineHoldExecution(root, { mainCommit, commit, practice = DOCTRINE_FILE, timeoutMs = DEFAULT_TIMEOUT_MS, runCheck }) {
  // Current main is resolved first, so a rule added or changed on main since the frozen base applies.
  const submitted = commit;
  ({ main: mainCommit, commit } = currentMain(root, mainCommit, commit));
  const rules = checkRulesAt(root, mainCommit, practice).filter((rule) => rule.runs === 'submit');
  if (!rules.length) return [];
  const lowered = new Map(checkRulesAt(root, commit, practice).map((rule) => [rule.id, rule.count]));
  const base = (gitOut(root, ['merge-base', mainCommit, commit]) ?? '').trim() || mainCommit;
  const diff = gitOut(root, ['diff', '-z', '--no-renames', '--name-only', base, commit, '--']);
  if (diff === null) throw new Refused('RATCHET_UNCOUNTED', 'cannot determine changed paths for the doctrine hold');
  const changed = diff.split('\0').filter(Boolean);
  const candidateTree = (gitOut(root, ['rev-parse', `${commit}^{tree}`]) ?? '').trim();
  const canFingerprint = cleanTree(root) === candidateTree;
  const origins = withPathMapMoves(renamedOrigins(root, base, commit), root, base, commit, changed); // Git's renames and the cells path map's moves.
  const results = [];
  const refusals = [];
  const uncounted = [];
  for (const rule of rules) {
    if (!changed.some((path) => inScope(rule.files, path))) {
      // Only skip when the check's own inputs can be identified and have not changed.
      // An opaque command is evaluated rather than making assumptions about its dependencies.
      const inputs = canFingerprint ? checkCommandDefinition(root, [rule.command]) : null;
      const globalInputs = [practice, DOCTRINE_FILE, LEGACY_DOCTRINE_FILE, 'pullboard.json', 'package.json'];
      if (inputs && !changed.some(path => globalInputs.includes(path) || inputs.some(input => input.path === `project:${path}`))) continue;
    }
    // Main's measured total is the baseline, never its declared count; an item that lowers its declaration is held below it.
    const declared = lowered.get(rule.id) ?? rule.count;
    // A clean checkout lets a file-local rule look only at the changed paths (and the moved paths' origins).
    const scope = canFingerprint ? changed.filter((path) => inScope(rule.files, path)) : undefined;
    // Main is narrowed too unless the item lowers its declaration, which needs main's whole measured total [5814].
    const mainScope = scope && declared >= rule.count && fastCheckScript(root, rule.command) ? [...new Set([...scope, ...origins.values()])] : undefined;
    const main = rule.mode === 'watch' ? { problems: [], broken: '' } : yield* measuredMain(root, mainCommit, rule.command, timeoutMs, mainScope);
    // A narrowed main holds only the changed paths' problems, so main's declared count stands in for its total: the hold is the change's delta.
    const mainTotal = main.broken || main.partial ? rule.count : main.problems.length;
    const measured = rule.mode === 'watch' ? rule.count : mainTotal;
    const committed = declared < rule.count ? Math.min(declared, measured) : measured;
    // A composed candidate exists only as Git objects, so it runs at its commit like main, never in this checkout.
    const run = yield { commit, command: rule.command, timeoutMs, candidate: commit === submitted, scope };
    const name = `${rule.id} ${rule.text}`;
    if (run.broken) { // A broken check never passes, whatever its mode.
      results.push({ id: rule.id, text: rule.text, command: rule.command, count: 0, committed, holds: false, state: 'uncounted', mode: rule.mode, runs: rule.runs, problems: [], broken: run.broken });
      uncounted.push(`${name} cannot count: its check ${run.broken}`);
      continue;
    }
    const touched = changed.filter((path) => run.problems.some((line) => namesFile(line, path)));
    // A narrowed run saw only changed files, so it always compares them with the base.
    const seen = run.partial ? [...new Set([...scope, ...origins.values()])] : null;
    const ran = run.partial && rule.mode !== 'watch' ? { ...main, problems: main.problems.filter((line) => seen.some((path) => namesFile(line, path))) }
      : touched.length && rule.mode !== 'watch' ? main : { problems: [], broken: '' };
    // A renamed file is compared with its origin: the origin's problems are carried to the new path.
    const before = { ...ran, problems: ran.problems.map((line) => carryRename(line, origins)) };
    // Only changed files can differ from main, so a narrowed count is accepted main's count moved by them; a lowered declaration never lowers the measure.
    const count = run.partial ? Math.max(0, mainTotal + run.problems.length - (before.broken ? 0 : before.problems.length)) : run.problems.length;
    const state = ruleState(rule, count, committed, false);
    results.push({ id: rule.id, text: rule.text, command: rule.command, count, committed,
      holds: state === 'holding' || state === 'watching', state, mode: rule.mode, runs: rule.runs, problems: run.problems, broken: '' });
    if (rule.mode === 'watch') continue;
    if (count > committed && !before.broken) {
      const fresh = newLines(before.problems, run.problems);
      refusals.push(`${name} rose to ${count}, was ${committed}; new problems:\n${(fresh.length ? fresh : run.problems).map((line) => `  ${line}`).join('\n')}`);
      continue;
    }
    if (count > committed) {
      refusals.push(`${name} rose to ${count}, was ${committed}; new problems:\n${run.problems.map((line) => `  ${line}`).join('\n')}`);
      continue;
    }
    if (before.broken) {
      uncounted.push(`${name} cannot count at main ${mainCommit.slice(0, 12)}: its check ${before.broken}`);
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
    const error = new Refused('RATCHET_ROSE', `${refusals.join('\n')}\nthe doctrine holds these counts; fix the new problems, commit, and submit again; only the person's signature raises count:`);
    const tree = gitOut(root, ['rev-parse', `${mainCommit}^{tree}`]);
    if (tree) error.machineryRule = createHash('sha256').update(readFileSync(fileURLToPath(import.meta.url)))
      .update(JSON.stringify([rules, tree])).digest('hex');
    throw error;
  }
  return results;
}


/** Drive the unchanged doctrine ratchet with the synchronous command API. */
export function holdDoctrine(root, options) {
  const execution = doctrineHoldExecution(root, options);
  try {
    let step = execution.next();
    while (!step.done) {
      const request = step.value;
      const run = options.runCheck ? options.runCheck(request.commit, request.command, request.timeoutMs)
        : request.candidate ? runRuleCheck(root, request.command, request.timeoutMs) : runAtCommit(root, request.commit, request.command, request.timeoutMs);
      step = execution.next(run);
    }
    return step.value;
  } finally { execution.return(); }
}

/** Await each actual rule and base comparison without blocking other admitted work or changing ratchet decisions. */
export async function holdDoctrineAsync(root, options) {
  const execution = doctrineHoldExecution(root, options);
  const pass = options.fast ? createFastPass(root) : null, bases = baseCheckouts(runRuleCheckAsync, commit => openBaseCheckout(root, commit)); // One base checkout per commit serves every rule.
  try {
    let step = execution.next();
    while (!step.done) {
      const request = step.value;
      let run = pass ? await pass.answer(request) : null;
      // A narrowed rule is answered in-process over the changed files; the rest follow the established paths.
      if (!run && options.runCheck) {
        // Remote checks share the same per-tree receipts as local rule checks, but only when
        // this clean checkout describes the exact tree requested from the runner.
        const key = checkReceiptKey(root, { kind: 'doctrine', definition: request.command, config: { timeoutMs: request.timeoutMs }, code: [fileURLToPath(import.meta.url)] });
        const requestedTree = (gitOut(root, ['rev-parse', `${request.commit}^{tree}`]) ?? '').trim();
        const matching = key?.tree === requestedTree ? key : null;
        const receipt = readCheckReceipt(root, matching);
        if (receipt && Array.isArray(receipt.result?.problems) && receipt.result.broken === '') {
          process.stderr.write(`${receiptLine(receipt)}\n`);
          run = receipt.result;
        } else {
          run = await options.runCheck(request.commit, request.command, request.timeoutMs);
          if (!run.broken) writeCheckReceipt(root, matching, { result: run });
        }
      } else if (!run) run = request.candidate ? await runRuleCheckAsync(root, request.command, request.timeoutMs) : await bases.run(request.commit, request.command, request.timeoutMs);
      step = execution.next(run);
    }
    return step.value;
  } finally { execution.return(); pass?.close(); bases.close(); }
}

/** Reuse a complete successful hold before admitting any runner work. */
export async function cachedDoctrineHold(root, options, execute) {
  const commands = checkRulesAt(root, options.mainCommit, options.practice).filter(rule => rule.runs === 'submit').map(rule => rule.command);
  const key = checkReceiptKey(root, { kind: 'doctrine-hold', commands, definition: options, config: { timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS }, code: [fileURLToPath(import.meta.url)] });
  const receipt = readCheckReceipt(root, key);
  if (receipt && Array.isArray(receipt.result)) {
    process.stderr.write(`${receiptLine(receipt)}\n`);
    return receipt.result;
  }
  const result = await execute();
  writeCheckReceipt(root, key, { result });
  return result;
}
