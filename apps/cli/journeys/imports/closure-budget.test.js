/** @pullboard-test-input apps/cli/journeys/imports/count.js */
/** Each hot command loads no more modules than its recorded budget plus headroom; budgets only ratchet down [C7]. */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cpSync } from 'node:fs';
import { existsSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { relative } from 'node:path';
import { after } from 'node:test';
import { before } from 'node:test';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { privateFixtureFiles } from '../../tests/fixtures/child.js';
import { runFixtureChild } from '../../tests/fixtures/child.js';
import { runFixtureSetupGit } from '../../tests/fixtures/child.js';
import { fixtureSettledMachine } from '../../../../packages/gate/tests/fixtures/testkit.js';
import { fixtureCommittedGraph } from '../../../../packages/gate/tests/fixtures/testkit.js';
import { createE2eHelpers } from '../../tests/fixtures/e2e.js';
import { fixtureAdd } from '../../tests/fixtures/testkit.js';
import budgets from './closure-budget.json' with { type: 'json' };

const ROOT = fileURLToPath(new URL('../../../../', import.meta.url));
const PRELOAD = fileURLToPath(new URL('./count.js', import.meta.url));

const e2e = createE2eHelpers();
after(e2e.cleanup);

/**
 * A seeded board with a joined seat holding its one item, so the board is warm and next answers the seat's own work. Commands measure there, never in this checkout:
 * a runner's gate checkout has no shared board, so every command there refused UNMERGED_SCHEMA after a load
 * the real command never pays, and the first command in a fresh board pays the board's creation [#5997].
 */
let seat = null;
before(async () => {
  const box = e2e.project();
  const added = await fixtureAdd(box.runLocal, box.repo, 'web', 'Measure the closure');
  assert.equal(added.code, 0, added.err);
  const claimed = await box.runLocal(box.web, 'claim', '1');
  assert.equal(claimed.code, 0, claimed.err);
  seat = box;
});

/** The headroom a row allows above its ceiling: max(5 modules, 5% of the ceiling rounded up), the 19 Nov ruling, so one added import never reds an unrelated item. */
function headroom(ceiling) {
  return Math.max(5, Math.ceil(ceiling * 5 / 100));
}

// Budget: an over-ceiling message names at most this many added modules, so the failure stays one readable line.
const ADDED_SHOWN = 40;

/** The refs main may go by in a checkout: a builder's seat has main, a runner's checkout may hold only its remote's. */
const MAIN_REFS = ['main', 'origin/main'];

/** The failure a row over its ceiling plus headroom prints, naming the modules the change added against main (null: not measurable). */
function overMessage(command, loaded, budget, added) {
  const named = added === null ? 'the modules it added could not be measured against main'
    : added.length ? `it added ${added.slice(0, ADDED_SHOWN).join(', ')}${added.length > ADDED_SHOWN ? ` and ${added.length - ADDED_SHOWN} more` : ''}` : 'it added no module against main';
  return `pullboard ${command} loaded ${loaded} modules, over its budget of ${budget} plus ${headroom(budget)} headroom; ${named}: import the defining file or load the heavy package at the call, never raise the budget`;
}

/**
 * Copy main's tree at the merge base of HEAD and the first readable ref into `into`/tree through a private index
 * (GIT_INDEX_FILE in `into`), so no ref, index or worktree of `root` changes; null when no merge base can be read.
 */
function baseTreeCopy(root, refs, into) {
  const env = { ...process.env, GIT_INDEX_FILE: join(into, 'index') };
  for (const ref of refs) {
    const base = runFixtureChild('git', ['merge-base', 'HEAD', ref], { cwd: root, encoding: 'utf8' });
    if (base.status !== 0 || !base.stdout.trim()) continue;
    const read = runFixtureChild('git', ['read-tree', base.stdout.trim()], { cwd: root, env, encoding: 'utf8' });
    const copied = read.status === 0 ? runFixtureChild('git', ['checkout-index', '--all', '--force', `--prefix=${join(into, 'tree')}/`], { cwd: root, env, encoding: 'utf8' }) : read;
    if (copied.status === 0) return join(into, 'tree');
  }
  return null;
}

/** The repo-relative files among loaded file URLs that sit under `top`. */
function underTop(urls, top) {
  const files = [...urls].map(url => { try { return fileURLToPath(url.split('?')[0]); } catch { return null; } }).filter(Boolean);
  return new Set(files.filter(file => file.startsWith(top.endsWith('/') ? top : `${top}/`)).map(file => relative(top, file)));
}

/**
 * The repo-relative modules `measure(top)` loads in `root` that it does not load in main's tree at the merge base,
 * sorted; null when main's tree cannot be copied. measure returns the loaded file URLs for the tree at `top`.
 */
function addedAgainstMain(root, refs, measure) {
  const scratch = privateFixtureFiles('closure-base-');
  try {
    const tree = baseTreeCopy(root, refs, scratch.root);
    if (!tree) return null;
    const before = underTop(measure(tree), tree);
    return [...underTop(measure(root), root)].filter(file => !before.has(file)).sort();
  } finally { rmSync(scratch.root, { recursive: true, force: true }); }
}

/** The files a runner machine keeps in its pullboard home: jobs, runtimes and signing keys, and no relay state [#6085]. */
const RUNNER_HOME = ['runner-jobs/job-1.json', 'runner-probes/probe.json', 'runner-runtimes.json', 'runner-signing-0123.pem'];

/** A row named `runner-home <command>` runs its command with runner state added to the seat's pullboard home [#6085]. */
const RUNNER_ROW = /^runner-home /u;

/** A row named `git-hook <command>` runs its command as a git hook does: with GIT_EXEC_PATH set, so the version probe reads the repo's installed hooks [C7]. */
const GIT_HOOK_ROW = /^git-hook /u;

/**
 * The distinct repo files one cold command loads in the seeded seat; refusals count too, since the load is paid before the command decides.
 * With runner true the seat's pullboard home is copied and given a runner's state first, so only the home's shape differs [#6085].
 */
function modulesLoaded(args, runner = false, extraEnv = {}) {
  return commandLoads(args, runner, extraEnv).loaded;
}

/** The one place this file starts a node child: a script under `top` run with the counting preload, so every measurement shares one launch [C7]. */
function countedRun(script, top, args, cwd, env) {
  return spawnSync(process.execPath, ['--import', PRELOAD, join(top, script), ...args], { cwd, encoding: 'utf8', env });
}

/** The distinct repo files one cold command loads, with their file URLs, the command's exit code and output, measured as modulesLoaded measures [C7]. */
function commandLoads(args, runner = false, extraEnv = {}, top = ROOT) {
  const files = privateFixtureFiles('closure-budget-');
  files.write('seen.txt', '');
  const env = { ...seat.env };
  if (runner) {
    files.write('home/.keep', '');
    if (existsSync(seat.env.PULLBOARD_HOME)) cpSync(seat.env.PULLBOARD_HOME, `${files.root}/home`, { recursive: true });
    for (const file of RUNNER_HOME) files.write(`home/${file}`, '{}\n');
    env.PULLBOARD_HOME = `${files.root}/home`;
  }
  Object.assign(env, extraEnv);
  env.PULLBOARD_OWN_CLI = '1';
  env.PULLBOARD_RESIDENT = '0';
  env.PULLBOARD_COUNT_FILE = `${files.root}/seen.txt`;
  const result = countedRun('apps/cli/pullboard.js', top, args.split(' '), seat.web, env);
  const urls = new Set(files.read('seen.txt').toString('utf8').split('\n').filter(Boolean));
  return { loaded: urls.size, urls, status: result.status, stdout: result.stdout, stderr: result.stderr };
}

for (const [command, budget] of Object.entries(budgets)) {
  test(`pullboard ${command} loads at most ${budget} modules plus headroom; a lower count means lower the budget [C7]`, t => {
    const measure = top => RUNNER_ROW.test(command) ? commandLoads(command.replace(RUNNER_ROW, ''), true, {}, top).urls
      : GIT_HOOK_ROW.test(command) ? commandLoads(command.replace(GIT_HOOK_ROW, ''), false, { GIT_EXEC_PATH: '/usr/libexec/git-core' }, top).urls
        : commandLoads(command, false, {}, top).urls;
    const loaded = measure(ROOT).size;
    if (loaded > budget + headroom(budget)) assert.fail(overMessage(command, loaded, budget, addedAgainstMain(ROOT, MAIN_REFS, measure)));
    if (loaded < budget) t.diagnostic(`pullboard ${command} loaded ${loaded}; lower its budget in closure-budget.json to ${loaded}`);
  });
}

test('cli.journeys-imports-closure-budget.a-cold-whoami-under-a-runner: a cold whoami under a runner-shaped home loads no more modules than under a plain home: runner state never starts the relay sync [C7,#6085]', () => {
  const plain = modulesLoaded('whoami');
  const runner = modulesLoaded('whoami', true);
  assert.ok(runner <= plain, `pullboard whoami loaded ${runner} modules under a runner home and ${plain} under a plain home: keep runner state out of syncMayAct`);
});

test('cli.journeys-imports-closure-budget.pullboard-hook-post-commit-exits-0: clause 2: pullboard hook post-commit exits 0 with empty stdout and stderr and loads only the entry file [C7]', () => {
  const run = commandLoads('hook post-commit');
  assert.equal(run.status, 0, run.stderr);
  assert.equal(run.stdout, '');
  assert.equal(run.stderr, '');
  assert.equal(run.loaded, 1);
});

test('cli.journeys-imports-closure-budget.cold-status-trimmed-modules: a cold pullboard status loads none of the drive step machinery a healthy board never needs [C7,#11941]', () => {
  const run = commandLoads('status');
  const dropped = ['once.js', 'diagnose.js', 'reclaim.js'].map(name => `packages/drive/src/io/${name}`);
  const loadedDrops = dropped.filter(file => [...run.urls].some(url => url.endsWith(`/${file}`)));
  assert.deepEqual(loadedDrops, [], `a cold status loaded ${loadedDrops.join(', ')}: the fallback reclaim loads the drive step machinery only when a gate job has lapsed`);
});

test('cli.journeys-imports-closure-budget.cold-list-maintenance-no-gate: clause 2: a cold pullboard list, whose after-command worktree maintenance imports the scheduler and tool/build.js, loads no module of the gate package [C7,#12595]', () => {
  const run = commandLoads('list');
  const gate = new URL('packages/gate/', `file://${ROOT}`).href;
  const loadedGate = [...run.urls].filter(url => url.startsWith(gate));
  assert.ok(run.urls.size > 0, run.stderr);
  assert.deepEqual(loadedGate.slice(0, 5), [], `a cold list loaded ${loadedGate.length} gate modules: apps/cli/src/io/tool/build.js must not import the gate package`);
});

test('cli.journeys-imports-closure-budget.cold-claim-skips-the-spec-module: a cold claim never loads apps/cli/src/io/spec.js: claim imports coordinatorFile from its own file [C7]', () => {
  const run = commandLoads('claim 1');
  const spec = new URL('apps/cli/src/io/spec.js', `file://${ROOT}`).href;
  assert.ok(run.urls.size > 0, run.stderr);
  assert.equal(run.urls.has(spec), false, 'pullboard claim 1 loaded apps/cli/src/io/spec.js: import coordinatorFile from apps/cli/src/io/coordinator-file.js');
});

test('cli.journeys-imports-closure-budget.cold-show-trimmed-modules: a cold pullboard show 1 loads none of the review-retry modules and at most 525 modules in all [C7,#11943]', () => {
  const run = commandLoads('show 1');
  const dropped = ['packages/verify/src/logic/verdict/retry.js', 'packages/merge/index.js', 'packages/merge/src/io/trunk.js', 'packages/merge/src/io/compose.js'];
  const loadedDrops = dropped.filter(file => [...run.urls].some(url => url.endsWith(`/${file}`)));
  assert.equal(run.status, 0, run.stderr);
  assert.match(run.stdout, /^#1 +claimed /u, "a cold show 1 still prints the item line");
  assert.deepEqual(loadedDrops, [], `a cold show loaded ${loadedDrops.join(', ')}: the comparison loads the review-retry composition only when its base run fails`);
  assert.ok(run.urls.size <= 525, `a cold show 1 loaded ${run.urls.size} modules, over the 525 the env adapter slices need: keep the retry composition out of the cold path`);
});

test('cli.journeys-imports-closure-budget.derived-state-on-show-and-list-within-rows: with health.derivedState on, a cold pullboard show 1 and a cold pullboard list each load no more modules than their rows plus headroom [C7,#12608]', () => {
  const home = seat.env.PULLBOARD_MACHINE_HOME;
  fixtureSettledMachine(home, { health: { derivedState: true } });
  try {
    for (const command of ['show 1', 'list']) {
      const run = commandLoads(command);
      assert.equal(run.status, 0, run.stderr);
      assert.ok(run.urls.size <= budgets[command] + headroom(budgets[command]), `a cold pullboard ${command} with health.derivedState on loaded ${run.urls.size} modules, over its row ${budgets[command]} plus ${headroom(budgets[command])} headroom: read derived state through the health light door and verdictTrunk through the verify read door`);
    }
  } finally { fixtureSettledMachine(home); }
});

test('cli.journeys-imports-closure-budget.headroom-is-five-or-five-percent: clause 1: headroom(ceiling) = max(5, ceil(5% of ceiling)), and the over-ceiling message names each module the change added, capped at 40 [C7]', () => {
  assert.deepEqual([1, 5, 100, 101, 227, 530, 1331, 1520].map(headroom), [5, 5, 5, 6, 12, 27, 67, 76]);
  const added = Array.from({ length: 45 }, (_, index) => `packages/x/m${index + 1}.js`);
  const message = overMessage('status', 1400, 1331, added);
  assert.match(message, /loaded 1400 modules, over its budget of 1331 plus 67 headroom/u);
  for (const file of added.slice(0, 40)) assert.ok(message.includes(`${file},`) || message.includes(`${file} and`), `${file} is named`);
  for (const file of added.slice(40)) assert.equal(message.includes(`${file},`) || message.includes(`${file} `), false, `${file} is past the cap`);
  assert.match(message, / and 5 more:/u);
  assert.match(overMessage('list', 300, 265, ['a.js']), /it added a\.js:/u);
  assert.match(overMessage('list', 300, 265, null), /could not be measured against main/u);
});

test('cli.journeys-imports-closure-budget.added-modules-against-main: clause 2: a row measured on main\'s tree copied from the merge base through a private index names the repo-relative modules the change added, and no ref, index or worktree of the checkout changes [C7]', () => {
  const graph = fixtureCommittedGraph('closure-added-');
  const root = graph.root;
  // The graph's own isolation (no global or system config, so no hooks), and no optional index refresh, so reading the state never rewrites the index it compares.
  const git = (...args) => runFixtureSetupGit(args, { cwd: root, env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', GIT_OPTIONAL_LOCKS: '0' } });
  graph.put('entry.js', "import './lib/a.js';\n");
  graph.put('lib/a.js', 'export const a = 1;\n');
  graph.commit();
  git('checkout', '-q', '-b', 'item');
  graph.put('entry.js', "import './lib/a.js';\nimport './lib/b.js';\n");
  graph.put('lib/b.js', 'export const b = 2;\n');
  graph.commit();
  const state = () => ({ refs: git('for-each-ref', '--format=%(refname) %(objectname)'), head: git('symbolic-ref', 'HEAD'), status: git('status', '--porcelain'),
    index: readFileSync(join(root, '.git', 'index')).toString('base64') });
  const before = state();
  const measure = top => {
    const seen = privateFixtureFiles('closure-seen-');
    seen.write('seen.txt', '');
    const run = countedRun('entry.js', top, [], top, { PULLBOARD_COUNT_FILE: join(seen.root, 'seen.txt') });
    assert.equal(run.status, 0, run.stderr);
    return new Set(seen.read('seen.txt').toString('utf8').split('\n').filter(Boolean));
  };
  assert.deepEqual(addedAgainstMain(root, ['main'], measure), ['lib/b.js']);
  assert.deepEqual(state(), before, 'no ref, index or worktree of the checkout changed');
  assert.equal(addedAgainstMain(root, ['no-such-ref'], measure), null, 'no merge base reads as not measurable');
});
