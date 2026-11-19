/** With submit.recoverFromJobRow on, a lost gate offer is recovered from the seat's own gate job row [C7,#9825]. @pullboard-test-input source-cell apps/cli */
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { test } from 'node:test';
import { cellBoard } from '../../../../../packages/board/tests/fixtures/cell-board.js';
import { cellSandbox } from '../../../../../packages/store/tests/fixtures/cell.js';
import { RUNS_STORE_KEY } from '../../../../../packages/store/index.js';
import { queueFor } from '../../../../../packages/api/index.js';
import { gateOfferFromJobRow } from '../../../src/io/submit/pull.js';
import { offerGateJob } from '../../../src/io/submit/pull.js';
import { recoverOfferedGateFromJobRow } from '../../../src/io/submit/pull.js';
import { fixtureMachineSettings } from '../../fixtures/testkit.js';

const MAIN = 'a'.repeat(40);
const SOURCE = 'b'.repeat(40);
const HEAD = 'c'.repeat(40);

/** A file board holding the one gate offer seat core-1 made for item 9825, with or without the runs store, and with or without companions. */
function offered(t, { runsStore = false, companion = false } = {}) {
  const board = cellBoard(t, join(cellSandbox(t).dir, 'board.sqlite'), undefined, { real: true });
  if (runsStore) board.db.prepare('INSERT INTO board_meta (meta_key, meta_value) VALUES (?, ?)').run(RUNS_STORE_KEY, '1');
  const queue = queueFor(board, 'core-1');
  t.after(() => queue?.runs.db.close());
  const request = { submit: { agentId: 'core-1', ...(companion ? { companion: { source: HEAD, commit: SOURCE } } : {}) } };
  const job = offerGateJob(board.db, { item: 9825, main: MAIN, source: SOURCE, request, ...(queue ? { queue } : {}) });
  return { board, job };
}

for (const runsStore of [false, true]) {
  test(`clause 1: recovery reads the offered job, source and composed head from the job row (runs_store ${runsStore ? 'on' : 'off'}) [C7,#9825]`, t => {
    const { board, job } = offered(t, { runsStore });
    assert.deepEqual(gateOfferFromJobRow(board, { me: 'core-1', id: 9825, source: SOURCE }), { job: job.id, onto: null });
  });
}

test('cli.io-submit-recover-job-row.a-composed-submit-recovers-the-builder-head: clause 1: a composed submit recovers the builder head its companions were composed onto [C7,#9825]', t => {
  const { board, job } = offered(t, { companion: true });
  assert.deepEqual(gateOfferFromJobRow(board, { me: 'core-1', id: 9825, source: SOURCE }), { job: job.id, onto: HEAD });
});

test('cli.io-submit-recover-job-row.a-job-row-offered-by-another-seat: clause 2: a job row offered by another seat, or for another source, recovers nothing [C7,#9825]', t => {
  const { board } = offered(t);
  assert.equal(gateOfferFromJobRow(board, { me: 'core-2', id: 9825, source: SOURCE }), null);
  assert.equal(gateOfferFromJobRow(board, { me: 'core-1', id: 9825, source: 'd'.repeat(40) }), null);
});

test('cli.io-submit-recover-job-row.with-submit-recoverfromjobrow-off-recovery-from-the: clause 3: with submit.recoverFromJobRow off, recovery from the job row does nothing and reads no board [C7,#9825]', async t => {
  const home = cellSandbox(t).dir;
  const saved = process.env.PULLBOARD_MACHINE_HOME;
  process.env.PULLBOARD_MACHINE_HOME = home;
  t.after(() => { if (saved === undefined) delete process.env.PULLBOARD_MACHINE_HOME; else process.env.PULLBOARD_MACHINE_HOME = saved; });
  fixtureMachineSettings(home, {});
  assert.equal(await recoverOfferedGateFromJobRow({}, 9825), null);
});
