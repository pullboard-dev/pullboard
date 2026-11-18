/** With laneMode off, a seat from another lane commits the cells of the item it claimed through the real pre-commit hook [C7,#8915]. */
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
import { fileFixtureItem } from '../../tests/fixtures/testkit.js';
import { fixtureJoin } from '../../tests/fixtures/testkit.js';
import { fixturePolicy } from '../../tests/fixtures/testkit.js';

const e2e = createE2eHelpers();
after(e2e.cleanup);
const { project } = e2e;

const ALPHA = 'Files:\n- packages/alpha/src/a.js\nTest:\n- the alpha test\n';
const DIAGNOSIS = 'Files: packages/alpha/src/a.js Change: export the alpha value Test case: the alpha value is exported';

test('cli.journeys-hooks-cross-lane.claimed-cells-pass: clause 1: with laneMode off a commit touching only the cells of a claimed item from another lane passes pre-commit [C7,#8915]', async () => {
  const box = project('true');
  const lanes = JSON.parse(readFileSync(join(box.repo, 'pullboard.json'), 'utf8')).lanes;
  fixturePolicy(box, { lanes: { ...lanes, web: { ...lanes.web, owns: [...lanes.web.owns, 'packages/'] } } });
  fileFixtureItem(box, box.repo, { lane: 'web', title: 'Cell item 1', brief: ALPHA, diagnosis: DIAGNOSIS, args: ['--specs', 'G1'] });
  fixturePolicy(box, { laneMode: 'off', lanes });
  const seat = join(box.dir, 'api-1');
  box.git(box.repo, 'worktree', 'add', '-q', seat, '-b', 'api/one');
  assert.equal(fixtureJoin(box.run, seat, 'api', '--route', 'light').code, 0);
  const taken = await box.inProcess(seat, 'next', '--build', '--json');
  assert.equal(taken.code, 0, taken.out + taken.err);
  assert.equal(JSON.parse(taken.out).item.item_id, 1, 'the api seat claims the web-lane item');
  const folder = seat + '-item-1';
  mkdirSync(dirname(join(folder, 'packages/alpha/src/a.js')), { recursive: true });
  writeFileSync(join(folder, 'packages/alpha/src/a.js'), 'export const value = 1;\n');
  box.git(folder, 'add', '-A');
  const committed = spawnSync('git', ['commit', '-q', '-m', 'feat(alpha): alpha change [G1]'], { cwd: folder, env: box.env, encoding: 'utf8' });
  assert.equal(committed.status, 0, committed.stdout + committed.stderr);
});
