/** Health names the week capacity worsened and the files that drove it, and a flat week names nothing [C7,R1,R2]. */
import assert from 'node:assert/strict';
import { join } from 'node:path';
import {
  after,
  test,
} from 'node:test';
import { seedCapacityWeeks } from '../../../../packages/store/tests/fixtures/cell.js';
import { createE2eHelpers } from '../../tests/fixtures/e2e.js';

const e2e = createE2eHelpers();
after(e2e.cleanup);

const WEEK_ONE = { week: '2026-W44', at: '2026-10-30T12:00:00.000Z', conflictPressure: 0.02, hoursInFlight: 4, cellsPerItem: 2, files: [{ file: 'packages/kernel/old.js', pressure: 0.01 }] };

/** Seed the weeks on the project's board, then read what health says about capacity. */
async function capacityFinding(weeks) {
  const box = e2e.project();
  seedCapacityWeeks(join(box.repo, '.git', 'pullboard', 'board.sqlite'), weeks);
  const health = await box.runLocal(box.repo, 'health', '--json');
  const report = JSON.parse(health.out);
  return [...report.stuck, ...report.waiting].find(entry => entry.cause === 'CAPACITY_WORSENED');
}

test('clause 1: two seeded weeks where pressure rises make health name that week and its files [C7,R1,R2]', async () => {
  const finding = await capacityFinding([WEEK_ONE,
    { week: '2026-W45', at: '2026-11-06T12:00:00.000Z', conflictPressure: 0.05, hoursInFlight: 4, cellsPerItem: 2,
      files: [{ file: 'packages/store/src/io/board.js', pressure: 0.03 }, { file: 'apps/cli/src/io/commands/join.js', pressure: 0.01 }] }]);
  assert.ok(finding, 'health reports the worsened week');
  assert.match(finding.why, /2026-W45/u);
  assert.match(finding.why, /conflict pressure rose from 0\.02 to 0\.05/u);
  assert.match(finding.why, /packages\/store\/src\/io\/board\.js/u);
  assert.match(finding.why, /apps\/cli\/src\/io\/commands\/join\.js/u);
});

test('clause 2: a flat week names nothing [C7,R1,R2]', async () => {
  const finding = await capacityFinding([WEEK_ONE, { ...WEEK_ONE, week: '2026-W45', at: '2026-11-06T12:00:00.000Z' }]);
  assert.equal(finding, undefined, 'no capacity finding when nothing rose');
});
