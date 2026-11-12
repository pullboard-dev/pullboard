/**
 * A claim's preparation is overtaken only by writes to the rows it depends on, and a refusal names the writer [B2,C7].
 * This test uses a real Git checkout, real SQLite boards and a real concurrent writer process.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { atomic } from '../../../../index.js';
import { getItem } from '../../../../index.js';
import { cellBoard } from '../../../fixtures/cell.js';
import { cellClaim } from '../../../fixtures/cell.js';
import { cellItem } from '../../../fixtures/cell.js';
import { cellProject } from '../../../fixtures/cell.js';
import { cellSeat } from '../../../fixtures/cell.js';
import { criterionFreezer } from '../../../../../moves/index.js';
import { loadConfig } from '../../../../../config/index.js';

/** The claim command's own criterion freezer for the fixture checkout. */
const freezerFor = (project, board) => criterionFreezer({ root: project.repo, isMain: true, config: loadConfig(project.repo) }, { board });

/** Block this thread, as a slow source read during preparation does. */
const pause = ms => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

/** File the claimed item and an unrelated one in the fixture project. */
function setup(t) {
  const project = cellProject(t);
  const board = cellBoard(t, project.boardFile, undefined, { gitRoot: project.repo });
  const seat = cellSeat(board, { lane: 'web', path: project.repo });
  const add = title => cellItem(board, { lane: 'web', title, specIds: ['G1'], route: 'strong', criterion: 'the fixture works' }).item_id;
  return { project, board, seat, target: add('Claimed fixture'), other: add('Unrelated fixture') };
}

/** A real second process that updates an unrelated item every 500 ms until killed. */
function concurrentWriter(t, file, item) {
  const source = `
    const { DatabaseSync } = require('node:sqlite');
    const db = new DatabaseSync(${JSON.stringify(file)}, { timeout: 5000 });
    let n = 0;
    const write = () => { db.prepare('UPDATE item SET item_title=? WHERE item_id=?').run('Unrelated fixture ' + (++n), ${item}); process.stdout.write('w'); };
    write();
    setInterval(write, 500);`;
  const child = spawn(process.execPath, ['--no-warnings', '-e', source], { stdio: ['ignore', 'pipe', 'inherit'] });
  t.after(() => child.kill('SIGKILL'));
  return new Promise(resolve => child.stdout.once('data', () => resolve(child)));
}

test('clause 1: claim succeeds quickly while a concurrent writer touches an unrelated item every 500 ms [B2,C7]', async t => {
  const { project, board, seat, target, other } = setup(t);
  const writer = await concurrentWriter(t, project.boardFile, other);
  const base = freezerFor(project, board);
  let frozen = 0;
  // A 1.2 s preparation always spans at least two of the writer's commits, which used to refuse BOARD_BUSY every time.
  const freeze = item => { frozen++; pause(1_200); return base(item); };
  cellClaim(board, target, seat, { root: project.repo, itemFolder: true, freeze });
  writer.kill('SIGKILL');
  const item = getItem(board, target);
  assert.equal(item.item_status, 'claimed');
  assert.equal(item.item_owner, seat.id);
  assert.ok(getItem(board, other).item_title.startsWith('Unrelated fixture '), 'the writer really wrote the unrelated item');
  // One preparation, not a refusal or a retry loop: the claim took the time of a single prepare.
  assert.equal(frozen, 1, 'unrelated writes never forced a second preparation');
});

test('clause 1: a write to the claimed item itself during preparation still re-prepares, then claims [B2,C7]', t => {
  const { project, board, seat, target } = setup(t);
  const peer = cellBoard(t, project.boardFile, undefined, { gitRoot: project.repo });
  const base = freezerFor(project, board);
  let frozen = 0;
  const freeze = item => {
    if (frozen++ === 0) atomic(peer, () => peer.db.prepare('UPDATE item SET item_brief=? WHERE item_id=?').run('changed while preparing', target));
    return base(item);
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
  const peer = cellBoard(t, project.boardFile, undefined, { gitRoot: project.repo });
  peer.writeContext = { command: 'edit', seat: 'coordinator' };
  const base = freezerFor(project, board);
  let n = 0;
  const freeze = item => {
    atomic(peer, () => peer.db.prepare('UPDATE item SET item_brief=? WHERE item_id=?').run(`edit ${++n}`, target));
    return base(item);
  };
  assert.throws(() => cellClaim(board, target, seat, { root: project.repo, itemFolder: true, freeze }), error => {
    assert.equal(error.code, 'BOARD_BUSY');
    assert.match(error.message, /the board changed while preparing claim/u);
    assert.match(error.message, /observed writer records: \[\{"command":"edit","seat":"coordinator","pid":\d+/u);
    assert.match(error.message, new RegExp(`"pid":${process.pid}`, 'u'));
    return true;
  });
  assert.equal(getItem(board, target).item_status, 'open');
});
