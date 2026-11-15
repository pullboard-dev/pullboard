/** A fixture board whose machine and runner caches can be wiped, to prove no cache is a second source of truth [C7]. */
import {
  mkdirSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { createE2eHelpers } from './e2e.js';
import { fileFixtureItem } from './testkit.js';
import {
  preQueueReuse,
  testActionKeys,
} from '../../../../packages/gate/index.js';
import { cachedMainComparison } from '../../../../packages/landing/index.js';

const TEST_FILE = 'web/cache.test.js';

/** Every regular file under a folder, as sorted paths relative to it; a missing folder holds none. */
export function filesUnder(folder, prefix = '') {
  let entries;
  try { entries = readdirSync(join(folder, prefix), { withFileTypes: true }); } catch { return []; }
  return entries.flatMap(entry => {
    const path = prefix ? `${prefix}/${entry.name}` : entry.name;
    return entry.isDirectory() ? filesUnder(folder, path) : [path];
  }).sort();
}

/**
 * Build a real repository with a joined web seat, one filed item and a committed test file, plus a runner root with
 * cache folders, and fill both cache homes with files.
 */
export function cacheWipeBoard() {
  const helpers = createE2eHelpers();
  const box = helpers.project();
  mkdirSync(join(box.repo, 'web'), { recursive: true });
  // A complete ES-module import graph needs a module-typed root package and no CommonJS.
  writeFileSync(join(box.repo, 'package.json'), '{"type":"module"}\n');
  writeFileSync(join(box.repo, TEST_FILE), "import { test } from 'node:test';\ntest('the fixture proves one case [G1]', () => {});\n");
  box.git(box.repo, 'add', '-A');
  box.git(box.repo, 'commit', '-q', '-m', 'test: add the cache fixture');
  const item = fileFixtureItem(box, box.repo, { lane: 'web', title: 'Cache wipe fixture item', wait: true });
  const runnerRoot = join(box.dir, 'runner-root');
  const machineHome = box.env.PULLBOARD_MACHINE_HOME;
  for (const folder of [join(machineHome, 'cache'), join(machineHome, 'main-facts'), join(runnerRoot, 'repos'), join(runnerRoot, 'cache', 'resource-pool')]) {
    mkdirSync(folder, { recursive: true, mode: 0o700 });
    writeFileSync(join(folder, 'entry.json'), JSON.stringify({ folder, filled: true }), { mode: 0o600 });
  }
  return { ...box, helpers, item, machineHome, runnerRoot, testFile: TEST_FILE };
}

/** Which test files the gate would run at a commit and the input key it files each under; no recorded green exists, so all run. */
async function gateSelection(board, head) {
  const env = { ...board.env, PULLBOARD_TEST_RESULT_STORE: undefined };
  delete env.PULLBOARD_TEST_RESULT_STORE;
  const keys = await testActionKeys(board.repo, { commit: head, files: [board.testFile], env, maintain: false });
  const reuse = await preQueueReuse(board.repo, head, [board.testFile], 'c'.repeat(64), { env });
  return { inputKey: keys.get(board.testFile)?.inputKey ?? null, reused: [...reuse.reused.keys()], run: reuse.run };
}

/**
 * A `show --json` answer without the filing baseline check, which a runner settles later (pending, then green) and which
 * no cache holds: only the answer that stays still while caches change is compared.
 */
function steady(out) {
  /** Drop the baseline check's field and its recorded move wherever they sit in the answer. */
  const strip = value => Array.isArray(value) ? value.filter(row => row?.kind !== 'check-baseline').map(strip)
    : value && typeof value === 'object' ? Object.fromEntries(Object.entries(value).filter(([key]) => !/^(?:item_check_baseline|checkBaseline)$/u.test(key)).map(([key, row]) => [key, strip(row)])) : value;
  try { return JSON.stringify(strip(JSON.parse(out))); } catch { return out; }
}

/** The three answers a board gives that must not depend on any cache: show, gate selection and main-red status. */
export async function boardAnswers(board) {
  const shown = board.run(board.repo, 'show', String(board.item.item_id), '--json');
  const explained = board.run(board.repo, 'red', 'explain', board.testFile, '--json');
  const head = board.git(board.repo, 'rev-parse', 'HEAD').trim();
  return {
    show: { code: shown.code, out: steady(shown.out) },
    selection: await gateSelection(board, head),
    mainRed: { explain: { code: explained.code, out: explained.out }, comparison: cachedMainComparison(board.repo, head, [board.testFile]) },
  };
}

/** Delete every file under the machine home and the runner root's cache folders; the folders themselves stay. */
export function wipeCaches(board) {
  for (const folder of [board.machineHome, join(board.runnerRoot, 'repos'), join(board.runnerRoot, 'cache')]) {
    for (const path of filesUnder(folder)) rmSync(join(folder, path), { force: true });
  }
}

/** The cache files that currently exist, for the test to prove it wiped something real. */
export function cacheFiles(board) {
  return [board.machineHome, join(board.runnerRoot, 'repos'), join(board.runnerRoot, 'cache')].flatMap(folder => filesUnder(folder).map(path => join(folder, path)));
}
