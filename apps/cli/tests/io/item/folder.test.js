/** Opening a new item folder with no spare launches at most 3 git processes and makes the same folder as before [C7,#10821,#5329]. */
import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import { appendFileSync } from 'node:fs';
import { existsSync } from 'node:fs';
import { mkdirSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import { rmSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { dirname } from 'node:path';
import { join } from 'node:path';
import { test } from 'node:test';
import { liveFolderRefusal } from '../../../src/io/item/folder.js';
import { openItemFolder } from '../../../src/io/item/folder.js';
import { parallelCheckout } from '../../../src/io/item/folder.js';
import { itemFolderPath } from '../../../src/io/item/folder.js';
import { removeIdleFolder } from '../../../src/io/item/folder.js';
import { gitPath } from '../../../../../packages/git/index.js';
import { repoInfo } from '../../../../../packages/git/index.js';
import { privateFixtureFiles } from '../../fixtures/child.js';
import { runFixtureGit } from '../../fixtures/child.js';
import { policyRepository } from '../../../../../packages/store/tests/fixtures/submit.js';

const ME = { id: 'core-1', lane: 'core' };
const APIS = ['spawnSync', 'execFileSync', 'execSync', 'spawn', 'execFile', 'exec'];

/** A repository with one commit, and a seat that is a linked worktree of it with no spare beside it. */
function repository(t) {
  const root = privateFixtureFiles('pullboard-item-folder-').root;
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const primary = join(root, 'primary');
  mkdirSync(primary);
  policyRepository(primary);
  const seat = join(root, 'seat');
  runFixtureGit(['worktree', 'add', '-q', '--detach', seat, 'main'], { cwd: primary });
  const info = repoInfo(seat);
  return { primary, seat, ctx: { info, io: {} }, main: runFixtureGit(['rev-parse', 'main'], { cwd: primary }) };
}

/** Run `work` while every git child this process starts is noted; the launches and their arguments come back with the result. */
async function countingGit(work) {
  const real = Object.fromEntries(APIS.map(api => [api, childProcess[api]]));
  const commands = [];
  for (const api of APIS) {
    childProcess[api] = function counted(...args) {
      const command = typeof args[0] === 'string' ? args[0].trim().split(/\s+/u)[0] : '';
      if (command.endsWith('git')) commands.push(args[1]);
      return real[api].apply(this, args);
    };
  }
  syncBuiltinESMExports();
  let result;
  try { result = await work(); } finally {
    for (const api of APIS) childProcess[api] = real[api];
    syncBuiltinESMExports();
  }
  return { launches: commands.length, commands, result };
}

/** What a folder is: its top level, branch, commit and the seat marker its git directory holds. */
function identity(path) {
  return {
    top: runFixtureGit(['rev-parse', '--show-toplevel'], { cwd: path }),
    branch: runFixtureGit(['symbolic-ref', '--short', 'HEAD'], { cwd: path }),
    commit: runFixtureGit(['rev-parse', 'HEAD'], { cwd: path }),
    marker: JSON.parse(readFileSync(gitPath(path, 'pullboard-item.json'), 'utf8')),
  };
}

/** Advance a branch through empty commits so the fixture isolates history from checkout changes. */
function advanceBranch(primary, branch, count) {
  const tree = runFixtureGit(['rev-parse', `${branch}^{tree}`], { cwd: primary });
  const identity = ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.test'];
  let tip = runFixtureGit(['rev-parse', branch], { cwd: primary });
  for (let i = 0; i < count; i++) {
    tip = runFixtureGit([...identity, 'commit-tree', tree, '-p', tip, '-m', `${branch} ${i}`], { cwd: primary });
  }
  runFixtureGit(['update-ref', `refs/heads/${branch}`, tip], { cwd: primary });
  return tip;
}

/** Prepare an existing item worktree whose branch holds its own commit and is behind main. */
async function divergentFolder(t, id, behind) {
  const { primary, ctx } = repository(t);
  const path = await openItemFolder(ctx, ME, id);
  const own = advanceBranch(primary, `core/item-${id}`, 1);
  advanceBranch(primary, 'main', behind);
  return { ctx, path, own, id };
}

test('cli.io-item-folder.claim-skips-main-merge: clause 1: reopening a branch with its own commits skips status and merge, keeps its head and names how far behind main it is [C7,#12577]', async t => {
  const { ctx, path, own, id } = await divergentFolder(t, 21, 1);
  const notes = [];
  const { commands, result } = await countingGit(() =>
    openItemFolder(ctx, ME, id, { renewed: true, onBehind: line => notes.push(line) }));
  assert.equal(result, path);
  assert.deepEqual(commands.filter(args => args?.includes('status') || args?.includes('merge')), [], JSON.stringify(commands));
  assert.equal(runFixtureGit(['rev-parse', 'HEAD'], { cwd: path }), own);
  assert.equal(notes.length, 1);
  assert.match(notes[0], /1 commit behind main/u);
  assert.match(notes[0], /submit merges main/u);
});

/** Time a renewed claim with a monotonic clock, after the fixture has already opened the folder. */
async function reopenMs({ ctx, id }) {
  const start = performance.now();
  await openItemFolder(ctx, ME, id, { renewed: true, onBehind: () => {} });
  return performance.now() - start;
}

test('cli.io-item-folder.claim-cost-flat-with-main-history: clause 2: reopening with 200 commits behind takes at most twice as long as with one, and under one second [C7,#12577]', async t => {
  const near = await divergentFolder(t, 22, 1);
  const far = await divergentFolder(t, 23, 200);
  await reopenMs(near);
  await reopenMs(far);
  const nearTimes = [], farTimes = [];
  for (let i = 0; i < 7; i++) {
    nearTimes.push(await reopenMs(near));
    farTimes.push(await reopenMs(far));
  }
  const nearMs = nearTimes.sort((a, b) => a - b)[3];
  const farMs = farTimes.sort((a, b) => a - b)[3];
  console.log(`# Median item folder reopen: ${nearMs.toFixed(1)} ms at 1 commit behind, ${farMs.toFixed(1)} ms at 200 commits behind`);
  assert.ok(farMs < 1000 && farMs <= 2 * nearMs, `one commit: ${nearMs} ms; 200 commits: ${farMs} ms`);
});

test('cli.io-item-folder.claim-fast-forwards-plain-folder: clause 3: reopening a branch with no commits of its own fast-forwards it to main without a merge commit [C7,#12577]', async t => {
  const { primary, ctx } = repository(t);
  const path = await openItemFolder(ctx, ME, 25);
  const tip = advanceBranch(primary, 'main', 2);
  assert.equal(await openItemFolder(ctx, ME, 25, { renewed: true }), path);
  assert.equal(runFixtureGit(['rev-parse', 'HEAD'], { cwd: path }), tip);
});

test('cli.item-folder.new-folder-git-launches: clause 1: opening a new item folder with no spare launches at most 3 git processes [C7,#10821]', async t => {
  const { ctx } = repository(t);
  const { launches } = await countingGit(() => openItemFolder(ctx, ME, 7));
  console.log(`# git launches opening a new item folder: ${launches}`);
  // The same open timed on two more fresh repositories: the median of three, for the measurement clause.
  const times = [];
  for (const id of [8, 9]) {
    const other = repository(t);
    const start = process.hrtime.bigint();
    await openItemFolder(other.ctx, ME, id);
    times.push(Number(process.hrtime.bigint() - start) / 1e6);
  }
  console.log(`# item folder open ms (two fresh repositories): ${times.map(ms => ms.toFixed(1)).join(', ')}`);
  assert.ok(launches <= 3, `opening the folder launched ${launches} git processes`);
});

test('cli.item-folder.same-folder-new-and-existing-branch: clause 2: the folder path, branch, commit and marker are the same for a new branch and for an existing branch [C7,#10821]', async t => {
  const { ctx, main } = repository(t);
  const fresh = await openItemFolder(ctx, ME, 7);
  assert.equal(fresh, itemFolderPath(ctx.info.root, 7));
  assert.deepEqual(identity(fresh), { top: fresh, branch: 'core/item-7', commit: main, marker: { version: 1, seat: ME.id, item: 7 } });
  runFixtureGit(['branch', 'core/item-8', 'main'], { cwd: ctx.info.root });
  const existing = await openItemFolder(ctx, ME, 8);
  assert.equal(existing, itemFolderPath(ctx.info.root, 8));
  assert.ok(existsSync(existing));
  assert.deepEqual(identity(existing), { top: existing, branch: 'core/item-8', commit: main, marker: { version: 1, seat: ME.id, item: 8 } });
});

/** Make this process's Git read no machine config or inherited selector, so the cases below see only the repository's own files; undone after the test. */
function noMachineConfig(t) {
  const files = privateFixtureFiles('pullboard-item-folder-config-');
  const keys = ['GIT_CONFIG', 'GIT_CONFIG_COUNT', 'GIT_CONFIG_PARAMETERS', 'GIT_CONFIG_SYSTEM', 'GIT_DIR', 'GIT_COMMON_DIR', 'GIT_WORK_TREE', 'GIT_CONFIG_GLOBAL', 'GIT_CONFIG_NOSYSTEM'];
  const saved = Object.fromEntries(keys.map(key => [key, process.env[key]]));
  for (const key of keys) delete process.env[key];
  process.env.GIT_CONFIG_GLOBAL = join(files.root, 'none');
  process.env.GIT_CONFIG_NOSYSTEM = '1';
  t.after(() => {
    for (const [key, value] of Object.entries(saved)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
    rmSync(files.root, { recursive: true, force: true });
  });
}

/** What Git itself says checkout.workers is for a checkout, as the arguments parallelCheckout must return. */
function gitsAnswer(path) {
  const asked = childProcess.spawnSync('git', ['config', '--get', 'checkout.workers'], { cwd: path, encoding: 'utf8' });
  return asked.status === 0 ? [] : ['-c', 'checkout.workers=0'];
}

test('cli.item-folder.checkout-workers-no-launch: clause 1: parallelCheckout launches no git process and returns what git returns, with checkout.workers set, unset, and set in a worktree config [C7,#5329]', async t => {
  noMachineConfig(t);
  const { primary, seat } = repository(t);
  const cases = [['unset', () => {}, ['-c', 'checkout.workers=0']],
    ['set in the repository config', () => runFixtureGit(['config', 'checkout.workers', '2'], { cwd: primary }), []]];
  for (const [name, arrange, expected] of cases) {
    arrange();
    const { launches, result } = await countingGit(() => [parallelCheckout(seat), parallelCheckout(primary)]);
    assert.deepEqual(result, [expected, expected], name);
    assert.deepEqual(result[0], gitsAnswer(seat), `${name}: the same arguments as git`);
    assert.equal(launches, 0, `${name}: launched ${launches} git processes`);
  }
  // A worktree's own config counts only where the repository turns per-worktree config on.
  runFixtureGit(['config', '--unset', 'checkout.workers'], { cwd: primary });
  runFixtureGit(['config', 'extensions.worktreeConfig', 'true'], { cwd: primary });
  runFixtureGit(['config', '--worktree', 'checkout.workers', '3'], { cwd: seat });
  const { launches, result } = await countingGit(() => [parallelCheckout(seat), parallelCheckout(primary)]);
  assert.deepEqual(result, [[], ['-c', 'checkout.workers=0']], 'set in the seat\'s worktree config only');
  assert.deepEqual(result[0], gitsAnswer(seat));
  assert.deepEqual(result[1], gitsAnswer(primary));
  assert.equal(launches, 0, `a worktree config launched ${launches} git processes`);
});

test('cli.item-folder.checkout-workers-include-asks-git: clause 2: a config file with an include directive falls back to git config and matches git [C7,#5329]', async t => {
  noMachineConfig(t);
  const { primary, seat } = repository(t);
  const extra = join(privateFixtureFiles('pullboard-item-folder-include-').root, 'extra');
  t.after(() => rmSync(dirname(extra), { recursive: true, force: true }));
  writeFileSync(extra, '[checkout]\n\tworkers = 5\n');
  appendFileSync(join(primary, '.git', 'config'), `[include]\n\tpath = ${extra}\n`);
  const { launches, result } = await countingGit(() => parallelCheckout(seat));
  assert.deepEqual(result, []);
  assert.deepEqual(result, gitsAnswer(seat), 'the included setting counts, as it does for git');
  assert.ok(launches >= 1, 'an include directive is answered by git');
});

/** Put GIT_CONFIG_COUNT pairs in the environment for one case, then take them out again. */
function configPairs(t, pairs) {
  const keys = ['GIT_CONFIG_COUNT', ...pairs.flatMap((_, index) => [`GIT_CONFIG_KEY_${index}`, `GIT_CONFIG_VALUE_${index}`])];
  process.env.GIT_CONFIG_COUNT = String(pairs.length);
  pairs.forEach(([key, value], index) => { process.env[`GIT_CONFIG_KEY_${index}`] = key; process.env[`GIT_CONFIG_VALUE_${index}`] = value; });
  t.after(() => { for (const key of keys) delete process.env[key]; });
}

test('cli.item-folder.config-count-no-launch: clause 1: parallelCheckout launches no git process when GIT_CONFIG_COUNT carries three pairs that do not name checkout.workers [C7,#5329]', async t => {
  noMachineConfig(t);
  const { primary, seat } = repository(t);
  configPairs(t, [['user.useConfigOnly', 'true'], ['gc.auto', '0'], ['maintenance.auto', 'false']]);
  const { launches, result } = await countingGit(() => [parallelCheckout(seat), parallelCheckout(primary)]);
  assert.deepEqual(result, [['-c', 'checkout.workers=0'], ['-c', 'checkout.workers=0']]);
  assert.deepEqual(result[0], gitsAnswer(seat), 'the same arguments as git');
  assert.equal(launches, 0, `launched ${launches} git processes`);
});

test('cli.item-folder.config-count-sets-workers: clause 2: parallelCheckout returns what git returns when a GIT_CONFIG_KEY_n and GIT_CONFIG_VALUE_n pair sets checkout.workers [C7,#5329]', async t => {
  noMachineConfig(t);
  const { seat } = repository(t);
  configPairs(t, [['gc.auto', '0'], ['Checkout.Workers', '2']]);
  const { launches, result } = await countingGit(() => parallelCheckout(seat));
  assert.deepEqual(result, []);
  assert.deepEqual(result, gitsAnswer(seat), 'the same arguments as git');
  assert.equal(launches, 0, `launched ${launches} git processes`);
});

test('cli.io-item-folder.defers-the-running-folder: clause 2: inside a running command the folder it runs in waits for main to finish while other idle folders go at once; outside a command it goes at once [B5,#10891]', async t => {
  const { ctx } = repository(t);
  const seat = ctx.info.root;
  const running = await openItemFolder(ctx, ME, 7);
  const other = await openItemFolder(ctx, ME, 8);
  const key = Symbol.for('pullboard.deferred-folder-removals');
  const saved = globalThis[key];
  t.after(() => { if (saved === undefined) delete globalThis[key]; else globalThis[key] = saved; });
  globalThis[key] = [];
  assert.equal(removeIdleFolder(running, running, { seat, ref: 'core/item-7', running: [running] }), false, 'the running folder waits');
  assert.ok(existsSync(running), 'the folder the command runs in still stands');
  assert.equal(removeIdleFolder(running, other, { seat, running: [running] }), true, 'another idle folder goes at once');
  assert.equal(existsSync(other), false);
  const pending = globalThis[key];
  delete globalThis[key];
  assert.equal(pending.length, 1, 'one removal waits for main to finish');
  pending[0]();
  assert.equal(existsSync(running), false, 'main\'s last step removes the waiting folder');
  assert.equal(runFixtureGit(['branch', '--list', 'core/item-7'], { cwd: seat }), '', 'and deletes its named branch');
  const outside = await openItemFolder(ctx, ME, 9);
  assert.equal(removeIdleFolder(outside, outside, { seat, running: [outside] }), true, 'outside a command nothing waits');
  assert.equal(existsSync(outside), false);
});

test('cli.item-folder.live-folder-no-launch: clause 1: liveFolderRefusal launches no git process for an item whose folder does not exist and answers as git does for no checkout, one elsewhere, a locked one and a spaced path [C7,#10862]', async t => {
  const { primary, seat, ctx } = repository(t);
  const me = { id: 'seat-x', lane: 'web' };
  const root = dirname(seat);
  runFixtureGit(['worktree', 'add', '-q', '-b', 'web/item-7', join(root, 'elsewhere')], { cwd: primary });
  runFixtureGit(['worktree', 'add', '-q', '-b', 'web/item-8', join(root, 'locked-away')], { cwd: primary });
  runFixtureGit(['worktree', 'lock', join(root, 'locked-away')], { cwd: primary });
  mkdirSync(join(root, 'spaced dir'));
  runFixtureGit(['worktree', 'add', '-q', '-b', 'web/item-9', join(root, 'spaced dir', `${seat.split('/').pop()}-item-9`)], { cwd: primary });
  const answers = [];
  for (const id of [6, 7, 8, 9]) { const refusal = await liveFolderRefusal(ctx, null, me, id); answers.push(refusal && refusal.code); }
  // The no-checkout item answers from Git's files alone; the other three go on to the same checks as before, which may read Git.
  assert.deepEqual(answers, [null, 'ITEM_FOLDER_PROTECTED', 'ITEM_FOLDER_PROTECTED', null], 'no checkout, one elsewhere, a locked one and a spaced path');
  const none = await countingGit(() => liveFolderRefusal(ctx, null, me, 6));
  assert.equal(none.result, null);
  assert.equal(none.launches, 0, `an item with no folder and no checkout launched ${none.launches} git processes`);
});
