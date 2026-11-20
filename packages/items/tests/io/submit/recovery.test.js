/** The scratch-space floor as a value, and the refusal that reads it [C7,#11788]. */
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { privateFixtureFiles } from '../../../../gate/tests/fixtures/child.js';
import {
  assertToolTreeRoom,
  toolTreeRoomProblem,
} from '../../../index.js';

const GIB = 1024 ** 3;

test('items.submit-recovery.room-problem-low: clause 1: toolTreeRoomProblem returns TOOL_TREE_DISK_LOW with freeMb, minFreeMb and temp when statfs reports less than minFree, and removes no folder [C7,#11788]', () => {
  const scratch = privateFixtureFiles('pullboard-room-low-');
  scratch.write('pullboard-handoff-tools-old/marker', 'old');
  const problem = toolTreeRoomProblem({ temp: scratch.root, minFree: 5 * GIB, statfs: () => ({ bavail: 3 * 1024, bsize: 1024 ** 2 }) });
  assert.deepEqual(problem, { code: 'TOOL_TREE_DISK_LOW', freeMb: 3072, minFreeMb: 5120, temp: scratch.root });
  assert.equal(existsSync(join(scratch.root, 'pullboard-handoff-tools-old')), true, 'the reading removes no folder');
});

test('items.submit-recovery.room-problem-none: clause 2: at or above minFree, or when statfs throws, toolTreeRoomProblem returns null [C7,#11788]', () => {
  const at = toolTreeRoomProblem({ temp: 'x', minFree: 5 * GIB, statfs: () => ({ bavail: 5 * 1024, bsize: 1024 ** 2 }) });
  assert.equal(at, null);
  const above = toolTreeRoomProblem({ temp: 'x', minFree: 5 * GIB, statfs: () => ({ bavail: 9 * 1024, bsize: 1024 ** 2 }) });
  assert.equal(above, null);
  const broken = toolTreeRoomProblem({ temp: 'x', minFree: 5 * GIB, statfs: () => { throw new Error('no volume'); } });
  assert.equal(broken, null);
});

test('items.submit-recovery.assert-uses-problem: clause 3: assertToolTreeRoom throws the TOOL_TREE_DISK_LOW refusal from the problem value, and passes when there is room [C7,#11788]', () => {
  const scratch = privateFixtureFiles('pullboard-room-assert-');
  assert.throws(() => assertToolTreeRoom({ temp: scratch.root, minFree: Number.MAX_SAFE_INTEGER }), (error) => {
    assert.equal(error.code, 'TOOL_TREE_DISK_LOW');
    assert.match(error.message, /only \d+ MB free in /u);
    assert.ok(error.message.includes('older than 60 minutes, so free space or retry once running jobs finish'));
    assert.ok(error.message.includes(scratch.root));
    return true;
  });
  assert.doesNotThrow(() => assertToolTreeRoom({ temp: scratch.root, minFree: 0 }));
});
