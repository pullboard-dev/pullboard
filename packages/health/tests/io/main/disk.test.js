/** @pullboard-test-input source-cell packages/health */
/** A scratch volume under the tool-tree floor is one Stuck finding in the health report [C7]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fixtureBoard } from '../../../../board/tests/fixtures/board.js';
import { healthReport } from '../../../index.js';
import { healthLines } from '../../../index.js';

const LOW = { code: 'TOOL_TREE_DISK_LOW', freeMb: 3400, minFreeMb: 5120, temp: '/scratch/pullboard' };

/** The health report read at the board's clock with the room reading the case gives. */
function report(t, problem) {
  const board = fixtureBoard(t);
  return healthReport({ db: board.db, root: process.cwd(), config: {}, now: board.clock.now(), dispatchHealth: () => ({ findings: [] }), room: () => problem });
}

test('health.io-main-disk.tool-tree-low: clause 1: a TOOL_TREE_DISK_LOW room reading yields one stuck finding naming free MB, the floor and the folder, and the lost main comparison [C7]', t => {
  const found = report(t, LOW).stuck.filter(row => row.cause === 'TOOL_TREE_DISK_LOW');
  assert.equal(found.length, 1);
  assert.match(found[0].why, /3400 MB free in \/scratch\/pullboard/u);
  assert.match(found[0].why, /5120 MB floor/u);
  assert.match(found[0].why, /review packets lose their main comparison/u);
  assert.equal(found[0].detail.freeMb, 3400);
});

test('health.io-main-disk.room-ok: clause 2: a null room reading gives no finding [C7]', t => {
  assert.deepEqual(report(t, null).stuck.filter(row => row.cause === 'TOOL_TREE_DISK_LOW'), []);
});

test('health.io-main-disk.health-lines: clause 3: healthLines prints the TOOL_TREE_DISK_LOW finding the report holds [C7]', t => {
  const lines = healthLines(report(t, LOW));
  assert.ok(lines.some(line => line.includes('scratch space') && line.includes('under the tool-tree floor') && line.includes('3400 MB free')), lines.join('\n'));
});
