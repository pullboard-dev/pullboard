/**
 * A claim's preparation is overtaken only by writes to the rows it depends on, and a refusal names the writer [B2,C7].
 * This test uses a real Git checkout, real SQLite boards and a real concurrent writer thread.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Worker } from 'node:worker_threads';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { atomic } from '../../../../index.js';
import { getItem } from '../../../../index.js';
import { writeBoardCommand } from '../../../../index.js';
import { cellBoard } from '../../../fixtures/cell.js';
import { cellClaim } from '../../../fixtures/cell.js';
import { cellItem } from '../../../fixtures/cell.js';
import { cellProject } from '../../../fixtures/cell.js';
import { cellSeat } from '../../../fixtures/cell.js';

/** Block this thread, as a slow source read during preparation does. */
const pause = ms => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

/** A fixed frozen bar, so the test controls how long and how often preparation freezes. */
const FROZEN = { text: '{"criterion":"the fixture works"}', digest: createHash('sha256').update('{"criterion":"the fixture works"}').digest('hex') };

/** File the claimed item and an unrelated one in the fixture project. */
function setup(t) {
  const project = cellProject(t, { real: true });
  const board = cellBoard(t, project.boardFile, undefined, { real: true, gitRoot: project.repo });
  const seat = cellSeat(board, { lane: 'web', path: project.repo });
  const add = title => cellItem(board, { lane: 'web', title, specIds: ['G1'], route: 'strong', criterion: 'the fixture works' }).item_id;
  return { project, board, seat, target: add('Claimed fixture'), other: add('Unrelated fixture') };
}

/** A real second connection on its own thread that updates an unrelated item every 500 ms until terminated. */
function concurrentWriter(t, file, item) {
  const source = `
    const { DatabaseSync } = require('node:sqlite');
    const { parentPort } = require('node:worker_threads');
    const db = new DatabaseSync(${JSON.stringify(file)}, { timeout: 5000 });
    let n = 0;
    const write = () => { db.prepare('UPDATE item SET item_title=? WHERE item_id=?').run('Unrelated fixture ' + (++n), ${item}); parentPort.postMessage(n); };
    write();
    setInterval(write, 500);`;
  const worker = new Worker(source, { eval: true, stderr: true });
  t.after(() => worker.terminate());
  return new Promise(resolve => worker.once('message', () => resolve(worker)));
}

test('clause 1: claim succeeds quickly while a concurrent writer touches an unrelated item every 500 ms [B2,C7]', async t => {
  const { project, board, seat, target, other } = setup(t);
  const writer = await concurrentWriter(t, project.boardFile, other);
  let frozen = 0;
  // A 1.2 s preparation always spans at least two of the writer's commits, which used to refuse BOARD_BUSY every time.
  const freeze = () => { frozen++; pause(1_200); return FROZEN; };
  cellClaim(board, target, seat, { root: project.repo, itemFolder: true, freeze });
  await writer.terminate();
  const item = getItem(board, target);
  assert.equal(item.item_status, 'claimed');
  assert.equal(item.item_owner, seat.id);
  assert.notEqual(getItem(board, other).item_title, 'Unrelated fixture', 'the writer really wrote the unrelated item');
  // One preparation, not a refusal or a retry loop: the claim took the time of a single prepare.
  assert.equal(frozen, 1, 'unrelated writes never forced a second preparation');
});

test('clause 1: a write to the claimed item itself during preparation still re-prepares, then claims [B2,C7]', t => {
  const { project, board, seat, target } = setup(t);
  const peer = cellBoard(t, project.boardFile, undefined, { real: true, gitRoot: project.repo });
  let frozen = 0;
  const freeze = () => {
    if (frozen++ === 0) atomic(peer, () => peer.db.prepare('UPDATE item SET item_brief=? WHERE item_id=?').run('changed while preparing', target));
    return FROZEN;
  };
  cellClaim(board, target, seat, { root: project.repo, itemFolder: true, freeze });
  assert.equal(frozen, 2, 'the changed item was prepared again from the current board');
  assert.equal(getItem(board, target).item_status, 'claimed');
});

test('clause 2: a claim whose own item keeps changing refuses BOARD_BUSY naming the writer command and pid [B2,C7]', t => {
  const { project, board, seat, target } = setup(t);
  const previous = process.env.PULLBOARD_MACHINE_HOME;
  process.env.PULLBOARD_MACHINE_HOME = join(project.dir, 'machine-home');
  t.after(() => { if (previous === undefined) delete process.env.PULLBOARD_MACHINE_HOME; else process.env.PULLBOARD_MACHINE_HOME = previous; });
  const peer = cellBoard(t, project.boardFile, undefined, { real: true, gitRoot: project.repo });
  peer.writeContext = { command: 'edit', seat: 'coordinator' };
  let n = 0;
  const freeze = () => {
    atomic(peer, () => peer.db.prepare('UPDATE item SET item_brief=? WHERE item_id=?').run(`edit ${++n}`, target));
    return FROZEN;
  };
  const options = { agentId: seat.id, lane: seat.lane, leaseMs: 3_600_000, itemFolder: true, freeze };
  assert.throws(() => writeBoardCommand(board, 'claim', [target, options], seat.id), error => {
    assert.equal(error.code, 'BOARD_BUSY');
    assert.match(error.message, /the board changed while preparing claim/u);
    assert.match(error.message, /observed writer records: \[\{"command":"edit","seat":"coordinator","pid":\d+/u);
    assert.match(error.message, new RegExp(`"pid":${process.pid}`, 'u'));
    return true;
  });
  assert.ok(n > 1, 'the claim prepared again before refusing');
  assert.equal(getItem(board, target).item_status, 'open');
});
