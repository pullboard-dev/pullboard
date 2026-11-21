/** With laneMode off a laneless light seat builds a view item then a core item, and the claim sequencer keeps a second seat out of a held cell, on real Git [C7,#2830]. */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { dirname } from 'node:path';
import { join } from 'node:path';
import {
  after,
  test,
} from 'node:test';
import { createE2eHelpers } from '../../tests/fixtures/e2e.js';
import { settleSubmit } from '../../tests/fixtures/submit/settle.js';
import { fileFixtureItem } from '../../tests/fixtures/testkit.js';
import { fixtureJoin } from '../../tests/fixtures/testkit.js';
import { fixturePolicy } from '../../tests/fixtures/testkit.js';

const e2e = createE2eHelpers();
after(e2e.cleanup);
const { project } = e2e;

const LIGHT_MODEL = 'fixture-light';
const VIEW = 'Files:\n- apps/view/src/page.js\nChange:\n- add the export\nTest:\n- the view test asserts it\nOut of scope: anything else\n';
const VIEW_SIBLING = 'Files:\n- apps/view/src/other.js\nChange:\n- add the export\nTest:\n- the view sibling test asserts it\nOut of scope: anything else\n';
const CORE = 'Files:\n- packages/core/src/thing.js\nChange:\n- add the export\nTest:\n- the core test asserts it\nOut of scope: anything else\n';

/**
 * A project whose web lane owns the apps and packages folders while the light items are filed, because `pullboard add` still
 * checks a brief against the lane folders; then its committed settings turn laneMode off and the lanes back as they were.
 */
function lanesOffProject(...briefs) {
  return cellProject('off', ...briefs);
}

/** The same project with laneMode as given; with lanes on, the web lane keeps owning the apps and packages folders so its seats may claim the items. */
function cellProject(laneMode, ...briefs) {
  const box = project('true');
  const lanes = JSON.parse(readFileSync(join(box.repo, 'pullboard.json'), 'utf8')).lanes;
  fixturePolicy(box, { lanes: { ...lanes, web: { ...lanes.web, owns: [...lanes.web.owns, 'apps/', 'packages/'] } } });
  briefs.forEach((brief, index) => fileFixtureItem(box, box.repo, { lane: 'web', title: `Cell item ${index + 1}`, brief, route: 'mid', args: ['--specs', 'G1'] }));
  if (laneMode === 'off') fixturePolicy(box, { laneMode, lanes });
  return box;
}

/** A fresh worktree that joins with no lane on the light route. */
function lanelessLightSeat(box, name) {
  const path = join(box.dir, name);
  box.git(box.repo, 'worktree', 'add', '-q', path, '-b', `light/${name}`);
  const joined = fixtureJoin(box.run, path, '--route', 'light', '--model', LIGHT_MODEL, '--json');
  assert.equal(joined.code, 0, joined.out + joined.err);
  assert.equal(JSON.parse(joined.out).route, 'light');
  return path;
}

/** Write a file in a checkout, creating folders. */
function write(cwd, path) {
  mkdirSync(dirname(join(cwd, path)), { recursive: true });
  writeFileSync(join(cwd, path), 'export const value = 1;\n');
}

/** Commit through the real hooks and report the refusal instead of throwing. */
function commit(box, cwd, message) {
  box.git(cwd, 'add', '-A');
  return spawnSync('git', ['commit', '-q', '-m', message], { cwd, env: box.env, encoding: 'utf8' });
}

/** Claim an item from a seat, change one file in its item folder, commit through the hooks, submit and wait for a green gate. */
async function buildItem(t, box, seat, id, path) {
  const claimed = await box.inProcess(seat, 'claim', String(id));
  assert.equal(claimed.code, 0, claimed.out + claimed.err);
  const folder = `${seat}-item-${id}`;
  write(folder, path);
  const committed = commit(box, folder, `feat(cell): change ${path} [G1]`);
  assert.equal(committed.status, 0, committed.stdout + committed.stderr);
  const submitted = await box.inProcess(folder, 'submit', String(id), '--json');
  assert.equal(submitted.code, 0, submitted.out + submitted.err);
  const settled = await settleSubmit(t, box, JSON.parse(submitted.out));
  assert.equal(settled.gate.green, true, JSON.stringify(settled.gate));
}

test('cli.journeys-join-lanes-off.laneless-light-view-then-core: clause 3: a laneless light seat claims and submits a view item and then a core item [C7,#2830]', async t => {
  const box = lanesOffProject(VIEW, CORE);
  const seat = lanelessLightSeat(box, 'light-1');
  await buildItem(t, box, seat, 1, 'apps/view/src/page.js');
  await buildItem(t, box, seat, 2, 'packages/core/src/thing.js');
});

test('cli.journeys-join-lanes-off.held-cell-claim-sequencer: clause 2: a second laneless seat is never handed an item in a cell the first seat holds [C7,#2830]', async () => {
  const box = lanesOffProject(VIEW, VIEW_SIBLING, CORE);
  const first = lanelessLightSeat(box, 'light-1');
  const claimed = await box.inProcess(first, 'claim', '1');
  assert.equal(claimed.code, 0, claimed.out + claimed.err);
  const second = lanelessLightSeat(box, 'light-2');
  const taken = await box.inProcess(second, 'next', '--take', '--json');
  assert.equal(taken.code, 0, taken.out + taken.err);
  assert.equal(JSON.parse(taken.out).item.item_id, 3, 'the core item in the free cell, never the view item beside the held claim');
});

test('cli.journeys-join-lanes-off.explicit-claim-held-cell-refused: clause 2: with laneMode off, an explicit claim of an item in a cell another seat holds is refused naming the cell and the holder [C7,#2830]', async () => {
  const box = lanesOffProject(VIEW, VIEW_SIBLING, CORE);
  const first = lanelessLightSeat(box, 'light-1');
  const claimed = await box.inProcess(first, 'claim', '1');
  assert.equal(claimed.code, 0, claimed.out + claimed.err);
  const second = lanelessLightSeat(box, 'light-2');
  const refused = await box.inProcess(second, 'claim', '2');
  assert.notEqual(refused.code, 0, 'the second writer in the apps/view cell is refused');
  assert.match(refused.out + refused.err, /HELD[\s\S]*apps\/view cell[\s\S]*holds through #1/u);
  const free = await box.inProcess(second, 'claim', '3');
  assert.equal(free.code, 0, free.out + free.err);
});

test('cli.journeys-join-lanes-off.lanes-on-claim-unchanged: clause 2: with lanes on, a second seat\'s claim in a held cell is still allowed with its warning [C7,#2830]', async () => {
  const box = cellProject('on', VIEW, VIEW);
  const first = join(box.dir, 'web-first');
  const second = join(box.dir, 'web-second');
  for (const path of [first, second]) {
    box.git(box.repo, 'worktree', 'add', '-q', path, '-b', `web/${path.split('-').pop()}`);
    assert.equal(fixtureJoin(box.run, path, 'web').code, 0);
  }
  assert.equal((await box.inProcess(first, 'claim', '1')).code, 0);
  const again = await box.inProcess(second, 'claim', '2');
  assert.equal(again.code, 0, again.out + again.err);
  assert.doesNotMatch(again.out + again.err, /apps\/view cell/u);
  assert.match(again.out + again.err, /waits for #1/u);
});

test('cli.journeys-join-lanes-off.out-of-cell-commit-refused: clause 2: with laneMode off, pre-commit checks the claimed item\'s cells, so its own cell passes and a file in another cell is refused naming the path [C7,#2830]', async () => {
  const box = lanesOffProject(VIEW, CORE);
  const seat = lanelessLightSeat(box, 'light-1');
  assert.equal((await box.inProcess(seat, 'claim', '1')).code, 0);
  const folder = `${seat}-item-1`;
  write(folder, 'apps/view/src/page.js');
  write(folder, 'packages/core/src/thing.js');
  const refused = commit(box, folder, 'feat(cell): view and core change [G1]');
  assert.notEqual(refused.status, 0, 'pre-commit refuses the core cell for a view item');
  assert.match(refused.stdout + refused.stderr, /packages\/core\/src\/thing\.js/u);
  rmSync(join(folder, 'packages/core/src/thing.js'));
  const own = commit(box, folder, 'feat(cell): view change [G1]');
  assert.equal(own.status, 0, own.stdout + own.stderr);
});
