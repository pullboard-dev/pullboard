/** Seed single-line faults into a throwaway copy of a cell and run the cell's own tests against each, report only; the adapter that runs tests for the mutation check [C7]. */
import { cpSync } from 'node:fs';
import { mkdirSync } from 'node:fs';
import { mkdtempSync } from 'node:fs';
import { readdirSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import { rmSync } from 'node:fs';
import { statSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { relative } from 'node:path';
import { Refused } from '../../../kernel/index.js';
import { scratchBase } from '../../../kernel/light.js';
import { spawnCaptured } from './captured.js';
import { environmentAdapter } from '../../../env/index.js';

/** Hang ceiling for one test file run against one fault; a fault that makes a test loop forever is a caught fault. */
const RUN_TIMEOUT_MS = 60_000;

/** Every file under a folder, as paths relative to it, skipping node_modules and .git. */
function walk(dir, base = dir) {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === '.git') continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(full, base));
    else if (entry.isFile()) out.push(relative(base, full).split('\\').join('/'));
  }
  return out.sort();
}

/** Whether a cell-relative path is a test file. */
const isTest = (file) => /\.test\.(?:js|mjs)$/u.test(file);

/** Whether a cell-relative path is source a fault may be seeded into: a non-test .js or .mjs file. */
const isSource = (file) => /\.(?:js|mjs)$/u.test(file) && !isTest(file);

/**
 * The environment a nested `node --test` needs: the parent's test-runner markers would make it report to the parent.
 * Why the browser markers go too: a runner job that did not declare a browser marks itself slot none and puts a guard in
 * NODE_OPTIONS, so every Chrome journey it started failed BROWSER_UNDECLARED before any fault was seeded (#8137). The child
 * is its own test file, and the mutation run starts one at a time, so it takes no marker from a parent that held no lease.
 *
 * @param {NodeJS.ProcessEnv} [from] the parent environment
 * @returns {NodeJS.ProcessEnv}
 */
export function childEnv(from = environmentAdapter().all()) {
  const env = { ...from };
  delete env.NODE_TEST_CONTEXT;
  if (env.PULLBOARD_TEST_BROWSER_SLOT === 'none') {
    delete env.PULLBOARD_TEST_BROWSER_SLOT;
    delete env.PULLBOARD_TEST_FILE;
    const kept = String(env.NODE_OPTIONS ?? '').split(/\s+/u).filter((word) => word && !/browser\/guard\.js$/u.test(word));
    if (kept.length) env.NODE_OPTIONS = kept.join(' ');
    else delete env.NODE_OPTIONS;
  }
  return env;
}

/**
 * Run one child to its end; resolves with its exit code (null when it timed out, was stopped or was killed), its output and its error text.
 * spawnCaptured gives the child its own process group and kills that group when the child ends, times out, is stopped by `signal`, or this process exits (reapGroup).
 */
async function finish(command, args, { timeout = 0, signal, encoding, ...options } = {}) {
  try {
    const ran = await spawnCaptured(command, args, { ...options, timeout, signal, maxBuffer: 64 * 1024 * 1024, killSignal: 'SIGKILL', reapGroup: true });
    return { status: ran.error || ran.status === null ? null : ran.status, stdout: ran.stdout, stderr: ran.stderr };
  } catch { return { status: null, stdout: '', stderr: '' }; }
}

/** Run one test file in the copy; true when it passed. The child has ended before this resolves, so none is left alive. */
async function passes(dir, file, signal = null) {
  const ran = await finish(process.execPath, ['--test', file], { cwd: dir, env: childEnv(), timeout: RUN_TIMEOUT_MS, signal });
  // A stopped run is neither caught nor missed: it ends here instead of counting the killed child as a failing test.
  if (signal?.aborted) throw new Refused('STOPPED', 'the mutation run was stopped', 'run pullboard mutate again when ready');
  return ran.status === 0;
}

/**
 * Put HEAD's tree in a folder so a cell's imports outside its own folder resolve; the cell itself is overlaid from the working tree by the caller.
 * Why git archive and not a worktree: it writes nothing under the checkout's .git. A checkout without commits gets an empty folder and the cell-only copy.
 */
async function exportHead(root, into) {
  mkdirSync(into, { recursive: true });
  const tar = join(into, '..', 'head.tar');
  const made = await finish('git', ['archive', '--format=tar', '-o', tar, 'HEAD'], { cwd: root });
  if (made.status !== 0) return;
  await finish('tar', ['-xf', tar, '-C', into], {});
  rmSync(tar, { force: true });
}

/**
 * The lines changed against the base per cell-relative source file, from `git diff -U0`.
 * Why git and not a copy: a mutation check should only ask whether tests cover what this change touched.
 */
async function changedSourceLines(root, cell, base, changedLines) {
  const ran = await finish('git', ['diff', '-U0', base, '--', cell], { cwd: root });
  if (ran.status !== 0) throw new Refused('NO_BASE', `git diff against ${base} failed: ${(ran.stderr || '').trim().split('\n')[0]}`, 'run it in a git checkout that has the base branch, or pass --all to seed every line');
  const prefix = `${cell}/`;
  const found = {};
  for (const [file, lines] of Object.entries(changedLines(ran.stdout))) if (file.startsWith(prefix)) found[file.slice(prefix.length)] = lines;
  return found;
}

/** At most `count` items of a list, evenly spread so a sample covers the whole file and not just its top. */
function spread(list, count) {
  if (list.length <= count) return list;
  return Array.from({ length: count }, (_, at) => list[Math.floor((at * list.length) / count)]);
}

/**
 * Seed each fault of a cell into a throwaway copy, run the cell's test files against it, and say which faults each caught.
 * Why a copy: the working tree is never written, so an interrupted run cannot leave a fault behind; the copy is removed
 * in every case. A test file that fails unmutated is red-before and left out, as it would "catch" every fault.
 *
 * @param {string} root git checkout root
 * @param {string} cell cell folder relative to root
 * @param {{all?: boolean, base?: string, extra?: string[], sample?: number, reach?: Record<string, string[]>}} [options] all seeds every line; base is the ref changed lines are read against;
 *   extra are root-relative test files outside the cell (such as a journey) run against each fault too; sample caps the faults seeded per source file, spread evenly;
 *   reach maps a root-relative test file to the root-relative files its imports reach, and a fault then runs only the tests that reach the seeded file;
 *   signal is an AbortSignal: when it aborts, every running test child is killed and the run refuses STOPPED, with the copy removed;
   note gets a line per phase and per test run with its seconds, for a run that must be watched;
 *   deadline is an epoch time checked before every test run: no new fault is started after it, and a fault it cuts short is dropped and counted in `skipped`, never as caught or missed;
 *   maxTests caps the cell tests run against one fault (those named for the seeded file first, then those reaching the fewest files); a fault that still escapes them is run by the journey, which can only lower a cell's score without it, so a cap never turns a convert into a hold; such faults are counted in `capped`;
 *   extraLast runs the extra files only against a fault no reaching cell test caught, and re-runs the cell's other tests on a fault only an extra file caught,
 *   so every fault's catch-or-miss by the extra files beside the cell's tests is the same as running everything, at the cost of a few runs
 * @param {{faults: Function, changedLines: Function}} seams the pure fault and diff readers, passed in because a package never imports an app
 * @returns {Promise<{cell: string, base: string, all: boolean, redBefore: string[], tests: {file: string, caught: number, total: number}[], faults: object[], caught: number, missed: number}>}
 */
export async function mutateCell(root, cell, { all = false, base = 'main', extra = [], sample = Infinity, reach = null, extraLast = false, note = () => {}, deadline = null, maxTests = Infinity, signal = null } = {}, { faults, changedLines }) {
  const name = String(cell).replace(/\\/gu, '/').replace(/^\.\//u, '').replace(/\/+$/u, '');
  const source = join(root, name);
  let stat = null;
  try { stat = statSync(source); } catch { /* reported below */ }
  if (!name || name.startsWith('..') || !stat?.isDirectory()) throw new Refused('NO_CELL', `${cell} is not a folder inside this checkout`, 'pullboard mutate <cell folder, e.g. packages/search> [--all]');
  const files = walk(source);
  const sources = files.filter(isSource);
  const tests = files.filter(isTest);
  if (!tests.length) throw new Refused('NO_TESTS', `${name} has no *.test.js files to run against a fault`, 'pass a cell folder that holds its own tests');
  const lines = all ? null : await changedSourceLines(root, name, base, changedLines);
  const temp = mkdtempSync(join(scratchBase(), 'pullboard-mutate-'));
  try {
    const copy = join(temp, 'tree', name);
    await exportHead(root, join(temp, 'tree'));
    rmSync(copy, { recursive: true, force: true });
    cpSync(source, copy, { recursive: true, filter: (from) => !/(?:^|[\\/])(?:node_modules|\.git)$/u.test(from) });
    const plan = sources.map((file) => {
      const text = readFileSync(join(source, file), 'utf8');
      const set = all ? Array.from({ length: text.split('\n').length }, (_, at) => at + 1) : (lines[file] ?? []);
      return { file, text, faults: spread(faults(text, set), sample) };
    });
    const reaches = reach ? new Map(Object.entries(reach).map(([test, list]) => [test, new Set(list)])) : null;
    /** Whether a test's imports reach a seeded source; a test with no reach data is assumed to, so it still runs. */
    const outsideOf = new Set(extra);
    const covers = (test, target) => {
      if (extraLast && outsideOf.has(test)) return true;
      const set = reaches?.get(outsideOf.has(test) ? test : `${name}/${test}`);
      return !set || set.has(`${name}/${target}`);
    };
    const seeded = plan.filter((row) => row.faults.length).map((row) => row.file);
    const needed = (test) => !reaches || seeded.some((file) => covers(test, file));
    const redBefore = [];
    const tree = join(temp, 'tree');
    const outsideSet = new Set(extra);
    const dirOf = (file) => (outsideSet.has(file) ? tree : copy);
    /** Whether a file passes on the unmutated copy, run once and only when it first fails against a fault; a red one catches every fault and is left out. */
    const baselines = new Map();
    const healthy = (file) => {
      if (!baselines.has(file)) {
        baselines.set(file, (async () => {
          const at = Date.now();
          const ok = await passes(dirOf(file), file, signal);
          note(`  ${ok ? 'passed' : 'failed'} unmutated ${file} in ${((Date.now() - at) / 1000).toFixed(1)}s`);
          if (!ok) redBefore.push(file);
          return ok;
        })());
      }
      return baselines.get(file);
    };
    const candidates = [...tests.filter(needed), ...(extraLast ? [] : extra.filter(needed))];
    const tally = Object.fromEntries([...new Set([...candidates, ...extra])].map((file) => [file, { file, caught: 0, total: 0 }]));
    note(`${name}: ${tests.length} tests, ${plan.reduce((sum, row) => sum + row.faults.length, 0)} faults seeded in ${seeded.length} files; ${candidates.length} tests can reach one`);
    /** Run tests against one seeded fault, one at a time, and return those that failed on it and pass unmutated. */
    const attempt = async (file, text, fault, list) => {
      const failed = [];
      writeFileSync(join(copy, file), fault.mutated);
      try {
        for (const test of list) {
          if (deadline && Date.now() > deadline) return null;
          const at = Date.now();
          const ok = await passes(dirOf(test), test, signal);
          tally[test].total += 1;
          note(`  ${name} ${ok ? 'passed' : 'failed'} ${test} in ${((Date.now() - at) / 1000).toFixed(1)}s`);
          if (!ok) failed.push(test);
        }
      } finally { writeFileSync(join(copy, file), text); }
      const caughtBy = [];
      for (const test of failed) if (await healthy(test)) { caughtBy.push(test); tally[test].caught += 1; }
      return caughtBy;
    };
    const results = [];
    // Faults are taken round-robin over the source files so a deadline leaves a spread sample, not the first files only.
    // Files few tests reach go first and hub files (reached by most tests) last, so a deadline cuts the slow faults and not the cheap ones.
    const fan = new Map(plan.map((row) => [row.file, candidates.filter((test) => covers(test, row.file)).length]));
    const ordered = [...plan].sort((a, b) => fan.get(a.file) - fan.get(b.file));
    const queue = [];
    for (let at = 0; ordered.some((row) => at < row.faults.length); at++) for (const row of ordered) if (at < row.faults.length) queue.push({ row, fault: row.faults[at] });
    /** At most `limit` tests, those named for the seeded file first, then those reaching the fewest files (the fewest hops away). */
    const nearest = (list, file, limit) => {
      if (list.length <= limit) return list;
      const stem = file.replace(/^.*\//u, '').replace(/\.m?js$/u, '');
      const rank = (test) => [test.includes(`/${stem}.test.`) || test.startsWith(`${stem}.test.`) ? 0 : 1, reaches?.get(`${name}/${test}`)?.size ?? Infinity];
      return [...list].sort((a, b) => { const [x, y] = [rank(a), rank(b)]; return x[0] - y[0] || x[1] - y[1] || (a < b ? -1 : 1); }).slice(0, limit);
    };
    let skipped = 0;
    let capped = 0;
    for (const { row: { file, text }, fault } of queue) {
      if (deadline && Date.now() > deadline) { skipped += 1; continue; }
      const reachable = candidates.filter((test) => covers(test, file));
      const reaching = nearest(reachable, file, maxTests);
      if (reaching.length < reachable.length) capped += 1;
      const caughtBy = await attempt(file, text, fault, reaching);
      if (!caughtBy) { skipped += 1; continue; }
      if (extraLast && !caughtBy.length) {
        const found = await attempt(file, text, fault, extra);
        if (!found) { skipped += 1; continue; }
        caughtBy.push(...found);
        if (found.length) {
          const others = await attempt(file, text, fault, candidates.filter((test) => !reaching.includes(test) && !outsideSet.has(test) && !(reachable.includes(test) && maxTests < reachable.length)));
          if (!others) { skipped += 1; continue; }
          caughtBy.push(...others);
        }
      }
      results.push({ file, line: fault.line, operator: fault.operator, before: fault.before, after: fault.after, caught: caughtBy.length > 0, caughtBy });
    }
    const caught = results.filter((row) => row.caught).length;
    return { cell: name, base: all ? null : base, all, redBefore, tests: Object.values(tally).filter((row) => row.total > 0 && !redBefore.includes(row.file)), faults: results, caught, missed: results.length - caught, skipped, capped };
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
}
