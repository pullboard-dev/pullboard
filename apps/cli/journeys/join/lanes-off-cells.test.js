/** With laneMode off, the claimed item's cells replace the lane folders in pre-commit, submit and next, on real Git [C7,#8907]. */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  mkdirSync,
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
import { fixtureAdd } from '../../tests/fixtures/testkit.js';
import { fixtureJoin } from '../../tests/fixtures/testkit.js';
import { fixturePolicy } from '../../tests/fixtures/testkit.js';

const e2e = createE2eHelpers();
after(e2e.cleanup);
const { project } = e2e;

const ALPHA = 'Files:\n- packages/alpha/src/a.js\nTest:\n- the alpha test\n';

/** A project whose committed settings turn laneMode off, with the web seat holding the new settings. */
function lanesOffProject() {
  const box = project('true');
  fixturePolicy(box, { laneMode: 'off' });
  box.git(box.web, 'merge', '-q', '--ff-only', 'main');
  return box;
}

/** File an item in the web lane whose bar names the given brief. */
function file(box, title, brief) {
  const filed = fixtureAdd(box.run, box.repo, 'web', title, '--specs', 'G1', '--criterion', `${title} works`, '--brief', brief, '--check', 'true');
  assert.equal(filed.code, 0, filed.out + filed.err);
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
  const box = lanesOffProject();
  file(box, 'Alpha work', ALPHA);
  assert.equal((await box.inProcess(box.web, 'claim', '1')).code, 0);
  const folder = `${box.web}-item-1`;
  write(folder, 'packages/alpha/src/a.js', 'packages/alpha/tests/a.test.js');
  const committed = commit(box, folder, 'feat(alpha): alpha change [G1]');
  assert.equal(committed.status, 0, committed.stdout + committed.stderr);
  const submitted = await box.inProcess(folder, 'submit', '1', '--json');
  assert.equal(submitted.code, 0, submitted.out + submitted.err);
  assert.equal((await settleSubmit(t, box, JSON.parse(submitted.out))).gate.green, true);
});

test('cli.journeys-join-lanes-off-cells.foreign-cell-refused: clause 2: with laneMode off a commit touching a path outside those cells is refused naming the path [C7,#8907]', async () => {
  const box = lanesOffProject();
  file(box, 'Alpha work', ALPHA);
  assert.equal((await box.inProcess(box.web, 'claim', '1')).code, 0);
  const folder = `${box.web}-item-1`;
  write(folder, 'packages/alpha/src/a.js', 'packages/beta/src/b.js');
  const refused = commit(box, folder, 'feat(alpha): alpha and beta change [G1]');
  assert.notEqual(refused.status, 0, 'pre-commit refuses the foreign cell');
  assert.match(refused.stdout + refused.stderr, /outside the web lane: packages\/beta\/src\/b\.js/u);
});

test('cli.journeys-join-lanes-off-cells.held-cell-not-offered: clause 3: with laneMode off next never hands a second seat an item in a cell the first seat holds [C7,#8907]', async () => {
  const box = lanesOffProject();
  file(box, 'Alpha held', ALPHA);
  file(box, 'Alpha sibling', 'Files:\n- packages/alpha/src/b.js\nTest:\n- the sibling test\n');
  file(box, 'Beta free', 'Files:\n- packages/beta/src/c.js\nTest:\n- the beta test\n');
  assert.equal((await box.inProcess(box.web, 'claim', '1')).code, 0);
  const second = join(box.dir, 'api-1');
  box.git(box.repo, 'worktree', 'add', '-q', second, '-b', 'api/one');
  assert.equal(fixtureJoin(box.run, second, 'api').code, 0);
  const taken = await box.inProcess(second, 'next', '--take', '--json');
  assert.equal(taken.code, 0, taken.out + taken.err);
  assert.equal(JSON.parse(taken.out).item.item_id, 3, 'the item in the free cell, not the one beside the held claim');
});
