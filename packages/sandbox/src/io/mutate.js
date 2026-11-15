/** Seed single-line faults into a throwaway copy of a cell and run the cell's own tests against each, report only; the adapter that runs tests for the mutation check [C7]. */
import { execFile } from 'node:child_process';
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

/** The environment a nested `node --test` needs: the parent's test-runner markers would make it report to the parent. */
function childEnv() {
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  return env;
}

/** Run one child to its end; resolves with its exit code (null when it timed out and was killed), its output and its error text. */
function finish(command, args, options) {
  return new Promise((resolve) => {
    execFile(command, args, { encoding: 'utf8', killSignal: 'SIGKILL', maxBuffer: 64 * 1024 * 1024, ...options }, (error, stdout, stderr) => {
      resolve({ status: error ? (typeof error.code === 'number' ? error.code : null) : 0, stdout, stderr });
    });
  });
}

/** Run one test file in the copy; true when it passed. The child has ended before this resolves, so none is left alive. */
async function passes(dir, file) {
  return (await finish(process.execPath, ['--test', file], { cwd: dir, env: childEnv(), timeout: RUN_TIMEOUT_MS })).status === 0;
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
 * @param {{all?: boolean, base?: string, extra?: string[], sample?: number}} [options] all seeds every line; base is the ref changed lines are read against;
 *   extra are root-relative test files outside the cell (such as a journey) run against each fault too; sample caps the faults seeded per source file, spread evenly
 * @param {{faults: Function, changedLines: Function}} seams the pure fault and diff readers, passed in because a package never imports an app
 * @returns {Promise<{cell: string, base: string, all: boolean, redBefore: string[], tests: {file: string, caught: number, total: number}[], faults: object[], caught: number, missed: number}>}
 */
export async function mutateCell(root, cell, { all = false, base = 'main', extra = [], sample = Infinity } = {}, { faults, changedLines }) {
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
    const redBefore = [];
    for (const file of tests) if (!await passes(copy, file)) redBefore.push(file);
    const tree = join(temp, 'tree');
    const extraRed = [];
    for (const file of extra) if (!await passes(tree, file)) extraRed.push(file);
    redBefore.push(...extraRed);
    const live = tests.filter((file) => !redBefore.includes(file));
    const outside = extra.filter((file) => !extraRed.includes(file));
    const run = (file) => passes(outside.includes(file) ? tree : copy, file);
    const tally = Object.fromEntries([...live, ...outside].map((file) => [file, { file, caught: 0, total: 0 }]));
    const results = [];
    for (const file of sources) {
      const text = readFileSync(join(source, file), 'utf8');
      const set = all ? Array.from({ length: text.split('\n').length }, (_, at) => at + 1) : (lines[file] ?? []);
      for (const fault of spread(faults(text, set), sample)) {
        writeFileSync(join(copy, file), fault.mutated);
        const caughtBy = [];
        try { for (const test of [...live, ...outside]) { tally[test].total += 1; if (!await run(test)) { caughtBy.push(test); tally[test].caught += 1; } } } finally { writeFileSync(join(copy, file), text); }
        results.push({ file, line: fault.line, operator: fault.operator, before: fault.before, after: fault.after, caught: caughtBy.length > 0, caughtBy });
      }
    }
    const caught = results.filter((row) => row.caught).length;
    return { cell: name, base: all ? null : base, all, redBefore, tests: Object.values(tally), faults: results, caught, missed: results.length - caught };
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
}
