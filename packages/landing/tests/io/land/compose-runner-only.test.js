/** @pullboard-test-input packages/landing/src/io/step/merge.js */
/** @pullboard-test-input packages/landing/src/io/step/compose.js */
/** @pullboard-test-input packages/landing/src/io/compose.js */
/** With landing.runnerOnlyCompose on, a batch the runner cannot compose is refused and nothing merges on the coordinator; off, the fallback stays [C7,#10246]. */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { runFixtureGit } from '../../../../gate/tests/fixtures/child.js';
import { privateFixtureFiles } from '../../../../gate/tests/fixtures/child.js';
import { fixtureMachineSettings } from '../../../../gate/tests/fixtures/testkit.js';
import { cellRepo } from '../../../../store/tests/fixtures/cell.js';
import { cellItem } from '../../../../store/tests/fixtures/cell.js';
import { openCellBoard } from '../../../../board/tests/fixtures/cell-board.js';
import * as store from '../../../../store/index.js';
import { loadConfig } from '../../../../config/index.js';
import { mergeGroup } from '../../../src/io/step/merge.js';
import { COMPOSE_MERGES } from '../../../src/io/compose.js';
import { COMPOSE_PACK } from '../../../src/io/compose.js';
import { COMPOSE_TIP } from '../../../src/io/compose.js';
import { COMPOSE_WRITES } from '../../../src/io/compose.js';

const git = (root, ...args) => runFixtureGit(args, { cwd: root }).trim();

/**
 * Run mergeGroup on a named batch; returns the outcome and what main looks like. The runner answers nothing unless `answer` is given:
 * a function from the batch (its worktree, base, item commit and item id) to the runner's output lines.
 */
async function landWith(t, settings, { answer, writeBadges = () => [] } = {}) {
  const repo = cellRepo(t, { real: true });
  const { root: dir } = privateFixtureFiles('pullboard-compose-runner-only-');
  const board = openCellBoard(join(dir, 'board.sqlite'));
  t.after(() => { store.closeBoard(board); rmSync(dir, { recursive: true, force: true }); });
  const saved = process.env.PULLBOARD_MACHINE_HOME;
  process.env.PULLBOARD_MACHINE_HOME = join(dir, 'machine-home');
  mkdirSync(process.env.PULLBOARD_MACHINE_HOME, { recursive: true });
  fixtureMachineSettings(process.env.PULLBOARD_MACHINE_HOME, settings);
  t.after(() => { if (saved === undefined) delete process.env.PULLBOARD_MACHINE_HOME; else process.env.PULLBOARD_MACHINE_HOME = saved; });
  const identity = { GIT_AUTHOR_NAME: 'Test Agent', GIT_AUTHOR_EMAIL: 'agent@example.com', GIT_COMMITTER_NAME: 'Test Agent', GIT_COMMITTER_EMAIL: 'agent@example.com' };
  const before = Object.fromEntries(Object.keys(identity).map(key => [key, process.env[key]]));
  Object.assign(process.env, identity);
  t.after(() => { for (const [key, value] of Object.entries(before)) if (value === undefined) delete process.env[key]; else process.env[key] = value; });
  const root = repo.root;
  const base = repo.commit;
  repo.put('web/page.txt', 'page\n');
  const tip = repo.commitAll();
  git(root, 'checkout', '-q', '--detach', base);
  // The scan and derive scripts make the batch ride a runner; their content never runs here.
  repo.put('packages/landing/src/io/scan.js', '// scan\n');
  repo.put('packages/landing/src/io/derive.js', '// derive\n');
  const trunk = repo.commitAll();
  const item = cellItem(board, { lane: 'web', title: 'Add the page', specIds: ['G1'] });
  // The batch builds in its own worktree on the base, as the landing does, while the primary checkout stays on main.
  const batchRoot = join(dir, 'batch');
  git(root, 'worktree', 'add', '-q', '--detach', batchRoot, trunk);
  t.after(() => { rmSync(batchRoot, { recursive: true, force: true }); });
  const said = [];
  const state = {
    board, config: { ...loadConfig(root), staticChecks: 'true' }, say: line => said.push(line), onWait() {}, checkLease: async () => {},
    root,
    guardServices: { runStaticChecks: async () => ({ output: answer ? answer({ root: batchRoot, base: trunk, tip, id: item.item_id }) : '' }) },
    landingPorts: { badgeCounts: () => ({}), writeBadges },
    write: async (_name, [{ batch }]) => batch,
    batch: { id: 'b1', root: batchRoot, base: trunk, external: true, candidates: [{ id: item.item_id, commit: tip }], items: [], conflicts: [], resolutions: [] },
  };
  const reflog = () => git(batchRoot, 'reflog', '--format=%gs', 'HEAD').split('\n').filter(Boolean);
  const reflogBefore = reflog();
  const outcome = await mergeGroup(state, [{ id: item.item_id, commit: tip }]).then(result => ({ result }), error => ({ error }));
  // Newest first: what the call added is the head of the list beyond the entries that were already there.
  const reflogAdded = reflog().slice(0, reflog().length - reflogBefore.length);
  return { ...outcome, said, root: batchRoot, trunk, tip, head: git(batchRoot, 'rev-parse', 'HEAD'), reflogAdded };
}

/** The dead runner: composeOnRunner returns null. */
const landWithDeadRunner = (t, settings) => landWith(t, settings);

test('landing.compose-runner-only.runner-compose-failure-refuses-with-the-setting-on: clause 1: with landing.runnerOnlyCompose on and composeOnRunner returning null, mergeGroup refuses LAND_RUNNER_REQUIRED naming the next step and merges nothing [C7,#10246]', async t => {
  const landed = await landWithDeadRunner(t, { landing: { runnerOnlyCompose: true } });
  assert.equal(landed.error?.code, 'LAND_RUNNER_REQUIRED');
  assert.match(landed.error.message, /runner could not compose/u);
  assert.match(landed.error.message, /fix the runner/u, 'the refusal names the next step');
  assert.equal(landed.head, landed.trunk, 'no merge or commit moved the batch root');
  assert.equal(git(landed.root, 'rev-list', '--count', `${landed.trunk}..HEAD`), '0');
  assert.deepEqual(landed.said, []);
});

test('landing.compose-runner-only.the-setting-off-keeps-the-coordinator-fallback: clause 2: with the setting off, the fallback still merges on the coordinator and says the runner could not compose this batch [C7,#10246]', async t => {
  const landed = await landWithDeadRunner(t, {});
  assert.equal(landed.error, undefined);
  assert.ok(landed.said.includes('the runner could not compose this batch; its items were merged on the coordinator'));
  assert.notEqual(landed.head, landed.trunk, 'the item merged here');
  assert.ok(git(landed.root, 'ls-tree', '-r', '--name-only', 'HEAD').includes('web/page.txt'));
});

/** The runner's compose answer for a batch: the base plus the item merged, as objects already in the batch repository, with the lines composeOnRunner parses. */
function composedAnswer({ root, base, tip, id }) {
  git(root, 'merge', '-q', '--no-ff', '--no-log', tip, '-m', 'Add the page');
  const merge = git(root, 'rev-parse', 'HEAD');
  const pack = execFileSync('git', ['pack-objects', '--revs', '--stdout', '--quiet'], { cwd: root, input: `${merge}\n^${base}\n^${tip}\n`, maxBuffer: 1 << 26 });
  git(root, 'checkout', '-q', '--detach', base);
  return [`${COMPOSE_MERGES}${JSON.stringify([[id, merge]])}`, `${COMPOSE_WRITES}[]`, `${COMPOSE_PACK}${pack.toString('base64')}`, `${COMPOSE_TIP}${merge}`].join('\n');
}

test('landing.compose-runner-only.merges-come-from-the-runner-answer: clause 1: with landing.runnerOnlyCompose on and a runner answering COMPOSE_TIP and COMPOSE_MERGES, mergeGroup returns each item merge exactly as the runner names it [C7,#10940]', async t => {
  let answered = null;
  const landed = await landWith(t, { landing: { runnerOnlyCompose: true } }, { answer: batch => { answered = composedAnswer(batch); return answered; } });
  assert.equal(landed.error, undefined, landed.error?.message);
  const named = JSON.parse(answered.split('\n').find(line => line.startsWith(COMPOSE_MERGES)).slice(COMPOSE_MERGES.length));
  assert.equal(landed.result.items.length, 1);
  assert.deepEqual([landed.result.items[0].id, landed.result.items[0].merge], named[0]);
  assert.equal(landed.result.tip, named[0][1], 'the landing tip is the runner tip');
  assert.deepEqual(landed.said, [], 'the coordinator did not fall back to merging');
});

test('landing.compose-runner-only.no-badge-write-on-the-coordinator: clause 2: with the runner answering, state.landingPorts.writeBadges is never called on the coordinator [C7,#10940]', async t => {
  const calls = [];
  const landed = await landWith(t, { landing: { runnerOnlyCompose: true } }, { answer: composedAnswer, writeBadges: (...args) => { calls.push(args); return []; } });
  assert.equal(landed.error, undefined, landed.error?.message);
  assert.equal(landed.result.items.length, 1);
  assert.deepEqual(calls, [], 'the runner wrote the badges; the coordinator wrote none');
});

test('landing.compose-runner-only.only-checkouts-reach-the-batch-root: clause 1: with landing.runnerOnlyCompose on and a runner answering, every HEAD reflog entry mergeGroup adds to the batch root is a checkout, the last detached at the runner tip, with no merge or commit entry [C7,#10941]', async t => {
  let answered = null;
  // The runner composes in its own worktree, so only mergeGroup's own moves reach the batch root reflog.
  const answer = batch => {
    const runnerRoot = join(batch.root, '..', 'runner');
    git(batch.root, 'worktree', 'add', '-q', '--detach', runnerRoot, batch.base);
    answered = composedAnswer({ ...batch, root: runnerRoot });
    return answered;
  };
  const landed = await landWith(t, { landing: { runnerOnlyCompose: true } }, { answer });
  assert.equal(landed.error, undefined, landed.error?.message);
  const runnerTip = answered.split('\n').find(line => line.startsWith(COMPOSE_TIP)).slice(COMPOSE_TIP.length);
  assert.ok(landed.reflogAdded.length > 0, 'mergeGroup moved HEAD at least once');
  assert.deepEqual(landed.reflogAdded.filter(entry => !entry.startsWith('checkout: moving from ')), [], 'no merge, commit, amend or reset entry was added');
  assert.ok(landed.reflogAdded[0].endsWith(' to ' + runnerTip), 'the last checkout is detached at the runner tip');
  assert.equal(landed.head, runnerTip);
});
