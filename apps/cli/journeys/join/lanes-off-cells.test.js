/** With laneMode off, the claimed item's cells replace the lane folders in pre-commit, submit and next, on real Git [C7,#8907]. */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  mkdirSync,
  readFileSync,
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

const ALPHA = 'Files:\n- packages/alpha/src/a.js\nTest:\n- the alpha test\n';

/**
 * A project whose web lane owns the packages folders while the items are filed, because `pullboard add` still checks a
 * brief against the lane folders; then its committed settings turn laneMode off and the lane back to web/ alone, and the web seat holds them.
 */
function lanesOffProject(...briefs) {
  const box = project('true');
  const lanes = JSON.parse(readFileSync(join(box.repo, 'pullboard.json'), 'utf8')).lanes;
  fixturePolicy(box, { lanes: { ...lanes, web: { ...lanes.web, owns: [...lanes.web.owns, 'packages/'] } } });
  briefs.forEach((brief, index) => fileFixtureItem(box, box.repo, { lane: 'web', title: `Cell item ${index + 1}`, brief, diagnose: false, args: ['--specs', 'G1'] }));
  fixturePolicy(box, { laneMode: 'off', lanes });
  box.git(box.web, 'merge', '-q', '--ff-only', 'main');
  return box;
}

/** Write files in a checkout, creating folders. */
function write(cwd, ...paths) {
  for (const path of paths) { mkdirSync(dirname(join(cwd, path)), { recursive: true }); writeFileSync(join(cwd, path), 'export const value = 1;\n'); }
}

/** Commit through the real hooks and report the refusal instead of throwing. */
function commit(box, cwd, message) {
  box.git(cwd, 'add', '-A');
  return spawnSync('git', ['commit', '-q', '-m', message], { cwd, env: box.env, encoding: 'utf8' });
}

test('cli.journeys-join-lanes-off-cells.own-cells-pass: clause 1: with laneMode off a commit touching only the claimed item\'s cells passes pre-commit and submit [C7,#8907]', async t => {
  const box = lanesOffProject(ALPHA);
  assert.equal((await box.inProcess(box.web, 'claim', '1')).code, 0);
  const folder = `${box.web}-item-1`;
  write(folder, 'packages/alpha/src/a.js', 'packages/alpha/src/extra.js');
  const committed = commit(box, folder, 'feat(alpha): alpha change [G1]');
  assert.equal(committed.status, 0, committed.stdout + committed.stderr);
  const submitted = await box.inProcess(folder, 'submit', '1', '--json');
  assert.equal(submitted.code, 0, submitted.out + submitted.err);
  const settled = await settleSubmit(t, box, JSON.parse(submitted.out));
  assert.equal(settled.gate.green, true, JSON.stringify(settled.gate));
});

test('cli.journeys-join-lanes-off-cells.foreign-cell-refused: clause 2: with laneMode off a commit touching a path outside those cells is refused naming the path [C7,#8907]', async () => {
  const box = lanesOffProject(ALPHA);
  assert.equal((await box.inProcess(box.web, 'claim', '1')).code, 0);
  const folder = `${box.web}-item-1`;
  write(folder, 'packages/alpha/src/a.js', 'packages/beta/src/b.js');
  const refused = commit(box, folder, 'feat(alpha): alpha and beta change [G1]');
  assert.notEqual(refused.status, 0, 'pre-commit refuses the foreign cell');
  assert.match(refused.stdout + refused.stderr, /outside the web lane: packages\/beta\/src\/b\.js/u);
});

test('cli.journeys-join-lanes-off-cells.held-cell-not-offered: clause 3: with laneMode off next never hands a second seat an item in a cell the first seat holds [C7,#8907]', async () => {
  const box = lanesOffProject(ALPHA, 'Files:\n- packages/alpha/src/b.js\nTest:\n- the sibling test\n', 'Files:\n- packages/beta/src/c.js\nTest:\n- the beta test\n');
  assert.equal((await box.inProcess(box.web, 'claim', '1')).code, 0);
  const second = join(box.dir, 'api-1');
  box.git(box.repo, 'worktree', 'add', '-q', second, '-b', 'api/one');
  assert.equal(fixtureJoin(box.run, second, 'api').code, 0);
  const taken = await box.inProcess(second, 'next', '--take', '--json');
  assert.equal(taken.code, 0, taken.out + taken.err);
  assert.equal(JSON.parse(taken.out).item.item_id, 3, 'the item in the free cell, not the one beside the held claim');
});

/** A laneMode off project whose item is filed in the api lane and claimed by the web seat; the api lane owns the packages folders only while the item is filed. */
function crossLaneProject(brief) {
  const box = project('true');
  const lanes = JSON.parse(readFileSync(join(box.repo, 'pullboard.json'), 'utf8')).lanes;
  fixturePolicy(box, { lanes: { ...lanes, api: { ...lanes.api, owns: [...lanes.api.owns, 'packages/'] } } });
  fileFixtureItem(box, box.repo, { lane: 'api', title: 'Cross-lane cell item', brief, diagnose: false, args: ['--specs', 'G1'] });
  fixturePolicy(box, { laneMode: 'off', lanes });
  box.git(box.web, 'merge', '-q', '--ff-only', 'main');
  return box;
}

test('cli.journeys-join-lanes-off-cells.cross-lane-claim-commits: clause 1: with laneMode off a seat registered in web claims an open api item with pullboard claim, commits a change touching only that item\'s cells and the commit passes pre-commit; clause 2: a commit touching a path outside those cells is refused naming the path; clause 3: the real claim command and a real git commit through the installed hook decide, with no stubbed lane guard [C7,#8915]', async () => {
  const box = crossLaneProject(ALPHA);
  const claimed = await box.inProcess(box.web, 'claim', '1');
  assert.equal(claimed.code, 0, claimed.out + claimed.err);
  const folder = `${box.web}-item-1`;
  write(folder, 'packages/alpha/src/a.js', 'packages/alpha/src/extra.js');
  const committed = commit(box, folder, 'feat(alpha): alpha change [G1]');
  assert.equal(committed.status, 0, committed.stdout + committed.stderr);
  write(folder, 'packages/alpha/src/a.js', 'packages/beta/src/b.js');
  const refused = commit(box, folder, 'feat(alpha): alpha and beta change [G1]');
  assert.notEqual(refused.status, 0, 'pre-commit refuses the foreign cell');
  assert.match(refused.stdout + refused.stderr, /packages\/beta\/src\/b\.js/u);
});
