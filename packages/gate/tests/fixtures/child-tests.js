/** Shared helper for a child `node --test` run: it strips the runner's context and refuses a run that saw no tests [V4]. */
import { spawnSync } from 'node:child_process';
import {
  existsSync,
  readFileSync,
  readdirSync,
  rmSync,
} from 'node:fs';
import { join } from 'node:path';
import { privateFixtureFiles } from './child.js';
import { runFixtureChildAsync } from './child.js';
import { GRANDFATHERED_DIRECT_SPAWNERS } from './child-tests-grandfathered.js';

export { GRANDFATHERED_DIRECT_SPAWNERS };

/** This helper's own path from the repository root: the one file allowed to spawn `node --test` directly. */
export const HELPER_PATH = 'packages/gate/tests/fixtures/child-tests.js';

/** A call that starts a process and names the `--test` flag in its own argument list. A line that opens a quote before the call writes fixture text for another process, so it is not a spawn here. */
const DIRECT_SPAWN = /^[^'"`\n]*\b(?:spawnSync|spawn|execFileSync|execFile|runFixtureChild)\s*\((?:(?!;\n)[\s\S]){0,400}?['"]--test['"]/mu;

/** Report whether a source file spawns `node --test` itself instead of through runChildTests. */
export function spawnsTestsDirectly(source) {
  const all = new RegExp(DIRECT_SPAWN.source, 'gmu');
  for (const hit of source.matchAll(all)) {
    // An odd count of backticks before the call means it sits inside a template literal: fixture text, not a spawn.
    if ((source.slice(0, hit.index).match(/(?<!\\)`/gu) ?? []).length % 2 === 0) return true;
  }
  return false;
}

/** Walk one folder for test-tree sources: files under a `tests` or `journeys` folder, or named `*.test.js`. */
function walk(root, dir, inTests, found) {
  for (const entry of readdirSync(join(root, dir), { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
    const path = `${dir}/${entry.name}`;
    if (entry.isDirectory()) walk(root, path, inTests || entry.name === 'tests' || entry.name === 'journeys', found);
    else if (/\.(?:js|mjs)$/u.test(entry.name) && (inTests || /\.test\.(?:js|mjs)$/u.test(entry.name))
      && path !== HELPER_PATH && spawnsTestsDirectly(readFileSync(join(root, path), 'utf8'))) found.push(path);
  }
  return found;
}

/** List the test-tree files (relative to root) under apps/ and packages/ that spawn `node --test` directly, sorted. */
export function directTestSpawners(root) {
  const found = [];
  for (const top of ['apps', 'packages']) if (existsSync(join(root, top))) walk(root, top, false, found);
  return found.sort();
}

/**
 * List the files under root that spawn `node --test` directly and are not on the grandfather list: the lint's refusals.
 *
 * @param {string} root - Repository root.
 * @param {readonly string[]} [grandfathered] - Files exempt from the lint.
 * @returns {string[]} Refused files, sorted.
 */
export function refusedDirectSpawners(root, grandfathered = GRANDFATHERED_DIRECT_SPAWNERS) {
  return directTestSpawners(root).filter(path => !grandfathered.includes(path));
}

/**
 * Run `node --test` on files in a child with NODE_TEST_CONTEXT removed. Why: a child that inherits the runner's
 * context silently runs zero tests, so a green or red result there says nothing about the files (#2451, #2521).
 *
 * @param {string[]} files - Test files for the child.
 * @param {{cwd?: string, env?: Record<string,string|undefined>, args?: string[], timeout?: number, maxBuffer?: number}} [options]
 * @returns {{status: number|null, tests: number, pass: number, fail: number, stdout: string, stderr: string}}
 */
export function runChildTests(files, { cwd = process.cwd(), env = process.env, args = [], timeout, maxBuffer = 32 * 1024 * 1024 } = {}) {
  const { clean, dir, tapFile, argv } = childTestsPlan(files, env, args);
  const child = spawnSync(process.execPath, argv, { cwd, env: clean, encoding: 'utf8', maxBuffer, ...(timeout ? { timeout } : {}) });
  return childTestsResult(files, child, dir, tapFile);
}

/**
 * The same child run as runChildTests without blocking this process, so a test can run one file two ways at once (#8265).
 * Why: the parity sample runs every journey in a real process and in-process; side by side they cost the slower run, not the sum.
 *
 * @param {string[]} files - Test files for the child.
 * @param {{cwd?: string, env?: Record<string,string|undefined>, args?: string[]}} [options]
 * @returns {Promise<{status: number|null, tests: number, pass: number, fail: number, stdout: string, stderr: string}>}
 */
export async function runChildTestsAsync(files, { cwd = process.cwd(), env = process.env, args = [] } = {}) {
  const { clean, dir, tapFile, argv } = childTestsPlan(files, env, args);
  const child = await runFixtureChildAsync(process.execPath, argv, { cwd, env: clean, encoding: 'utf8' });
  return childTestsResult(files, { status: child.status, stdout: child.stdout, stderr: child.stderr }, dir, tapFile);
}

/** The child's environment (runner context removed), private tap folder and argv. */
function childTestsPlan(files, env, args) {
  const clean = { ...env };
  delete clean.NODE_TEST_CONTEXT;
  const dir = privateFixtureFiles('pullboard-child-tap-').root;
  const tapFile = join(dir, 'tap.txt');
  return { clean, dir, tapFile, argv: ['--test', '--test-reporter=tap', `--test-reporter-destination=${tapFile}`, '--test-reporter=spec', '--test-reporter-destination=stdout', ...args, ...files] };
}

/** Read a finished child's tap file into the shared result, refusing a run that saw no tests. */
function childTestsResult(files, child, dir, tapFile) {
  const tap = existsSync(tapFile) ? readFileSync(tapFile, 'utf8') : '';
  rmSync(dir, { recursive: true, force: true });
  // Node reports a file that defines no test as one result named after the file; that is not a test that ran.
  const cases = [...tap.matchAll(/^(not )?ok \d+ - (.+)$/gmu)].filter(row => !/\.(?:c|m)?js$/u.test(row[2].trim()));
  const result = { status: child.status, tests: cases.length, pass: cases.filter(row => !row[1]).length, fail: cases.filter(row => row[1]).length, stdout: child.stdout, stderr: child.stderr };
  // A file that fails to load reports a failing file-level row and a non-zero status: that failure is visible, not a silent nothing.
  const loadFailed = child.status !== 0 && /^not ok \d+ - .+\.(?:c|m)?js$/mu.test(tap);
  if (result.tests === 0 && !loadFailed) throw new Error(`the child test run reported zero tests for ${files.join(' ')}; it ran nothing (status ${child.status}). ${child.stderr.slice(0, 300)}`);
  return result;
}
