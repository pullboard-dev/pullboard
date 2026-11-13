/** Verify does its slow steps before the board write opens, and the holds log can record every hold [C7,P4,B2]. */
import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import { after } from 'node:test';
import { test } from 'node:test';
import { privateFixtureFiles } from '../../tests/fixtures/child.js';
import { boardHoldPercentiles } from '../../../../packages/store/index.js';
import { boardHoldStats } from '../../../../packages/store/index.js';
import { recordBoardHold } from '../../../../packages/store/src/io/board/hold/log.js';
import { prepareVerdictEvidence } from '../../../../packages/store/src/io/board/write.js';

const home = privateFixtureFiles('verify-busy-').root;
process.env.PULLBOARD_MACHINE_HOME = home;
after(() => rmSync(home, { recursive: true, force: true }));

/** Record one hold of `heldMs` just now. */
function hold(heldMs) {
  recordBoardHold({ command: 'verify', seat: 'core-1', item: 1, pid: 1, durationMs: heldMs, outcome: 'released', acquiredAt: Date.now() - 1, phase: 'native-move' });
}

test('clause 1: the holds log records every hold only when the setting is on, and reads back the median and p90 [C7,P4]', () => {
  delete process.env.PULLBOARD_BOARD_HOLD_LOG_ALL;
  hold(40);
  assert.equal(boardHoldPercentiles().count, 0, 'off by default: a short hold is not recorded');
  process.env.PULLBOARD_BOARD_HOLD_LOG_ALL = '1';
  for (const ms of [10, 20, 30, 40, 50, 60, 70, 80, 90, 100]) hold(ms);
  delete process.env.PULLBOARD_BOARD_HOLD_LOG_ALL;
  const stats = boardHoldPercentiles();
  assert.deepEqual({ count: stats.count, median: stats.medianMs, p90: stats.p90Ms }, { count: 10, median: 50, p90: 90 });
  assert.equal(boardHoldStats().invalidLines, 0, 'short holds are skipped by the over-a-second report, not counted invalid');
});

test('clause 2: verify runs its quarantine-proof check before the write opens, and marks the options so the writer skips it [C7,B2]', () => {
  const seen = [];
  const board = { nativePorts: { quarantine: { validateQuarantineProofIds: () => seen.push('validated') } }, db: null };
  // The preparation has no database to open a transaction on, so anything it does ran before the write.
  assert.throws(() => prepareVerdictEvidence(board, [7, { decision: 'REJECT', quarantineProofId: 'p' }]), { code: 'PROOF_RUN_UNBOUND' });
  assert.deepEqual(prepareVerdictEvidence(board, [7, { decision: 'ACCEPT' }]), [7, { decision: 'ACCEPT' }], 'a verdict naming no evidence passes through');
  assert.throws(() => prepareVerdictEvidence({ ...board, getItem: undefined }, [7, { decision: 'ACCEPT', quarantineProofId: 'p' }]), /./u, 'the proof lookup runs here, with no lock');
  assert.deepEqual(seen, []);
});
