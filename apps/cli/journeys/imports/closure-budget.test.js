/** Each hot command loads no more modules than its recorded budget; budgets only ratchet down [C7]. */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cpSync } from 'node:fs';
import { existsSync } from 'node:fs';
import { after } from 'node:test';
import { before } from 'node:test';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { privateFixtureFiles } from '../../tests/fixtures/child.js';
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

/** The distinct repo files one cold command loads, with their file URLs, the command's exit code and output, measured as modulesLoaded measures [C7]. */
function commandLoads(args, runner = false, extraEnv = {}) {
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
  const result = spawnSync(process.execPath, ['--import', PRELOAD, `${ROOT}apps/cli/pullboard.js`, ...args.split(' ')], { cwd: seat.web, encoding: 'utf8', env });
  const urls = new Set(files.read('seen.txt').toString('utf8').split('\n').filter(Boolean));
  return { loaded: urls.size, urls, status: result.status, stdout: result.stdout, stderr: result.stderr };
}

for (const [command, budget] of Object.entries(budgets)) {
  test(`pullboard ${command} loads at most ${budget} modules; a lower count means lower the budget [C7]`, t => {
    const loaded = RUNNER_ROW.test(command) ? modulesLoaded(command.replace(RUNNER_ROW, ''), true)
      : GIT_HOOK_ROW.test(command) ? modulesLoaded(command.replace(GIT_HOOK_ROW, ''), false, { GIT_EXEC_PATH: '/usr/libexec/git-core' })
        : modulesLoaded(command);
    assert.ok(loaded <= budget, `pullboard ${command} loaded ${loaded} modules, over its budget of ${budget}: import the defining file or load the heavy package at the call, never raise the budget`);
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
