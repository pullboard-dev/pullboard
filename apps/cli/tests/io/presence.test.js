/** The presence heartbeat reads the board's item list only when it prints claim overlaps [C7,#5329]. */
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { cellBoard } from '../../../../packages/board/tests/fixtures/cell-board.js';
import { cellClaim } from '../../../../packages/store/tests/fixtures/cell.js';
import { cellItem } from '../../../../packages/store/tests/fixtures/cell.js';
import { cellRepo } from '../../../../packages/store/tests/fixtures/cell.js';
import { cellSeat } from '../../../../packages/store/tests/fixtures/cell.js';
import { privateFixtureFiles } from '../fixtures/child.js';
import { runFixtureGit } from '../fixtures/child.js';
import { recordClaimWorktrees } from '../../../../packages/activity/index.js';
import { listAgents } from '../../../../packages/store/index.js';
import { listItems } from '../../../../packages/store/index.js';
import { heartbeatCommand } from '../../src/io/presence.js';
import { stopSeatKeepalive } from '../../src/io/presence.js';
import { claimHeartbeatOverlaps } from '../../src/io/presence.js';

/** Two claims whose worktrees both edit shared.js, and the first seat's heartbeat context. */
function twoClaims(t) {
  const repo = cellRepo(t, { real: true });
  repo.put('shared.js', 'old\n');
  const base = repo.commitAll();
  const scratch = privateFixtureFiles('pullboard-presence-');
  const folders = ['first', 'second'].map(name => join(scratch.root, name));
  for (const folder of folders) {
    runFixtureGit(['-C', repo.root, 'worktree', 'add', '-q', '--detach', folder, base]);
    writeFileSync(join(folder, 'shared.js'), `${folder}\n`);
  }
  const board = cellBoard(t, repo.boardFile, undefined, { real: true });
  const seats = folders.map(path => cellSeat(board, { lane: 'web', path }));
  const items = seats.map((seat, index) => {
    const item = cellItem(board, { lane: 'web', title: `Edit shared ${index}` });
    cellClaim(board, item.item_id, seat, { root: repo.root });
    return item.item_id;
  });
  recordClaimWorktrees(board, listItems(board), listAgents(board));
  // A second connection, so the item list the setup read is not remembered for the heartbeat.
  const reader = cellBoard(t, repo.boardFile, undefined, { real: true });
  const ctx = { info: { root: folders[0] }, file: repo.boardFile, clock: reader.clock };
  return { board: reader, ctx, seats, items };
}

/** Run one heartbeat and return what it printed and every statement it prepared on a board connection. */
function beat(board, ctx, options) {
  const lines = [], prepared = [];
  const prepare = DatabaseSync.prototype.prepare;
  DatabaseSync.prototype.prepare = function recording(sql) { prepared.push(String(sql)); return prepare.call(this, sql); };
  try { heartbeatCommand({ err: line => lines.push(line) }, { ctx, board, ...options }); }
  finally { DatabaseSync.prototype.prepare = prepare; stopSeatKeepalive(); }
  return { lines, prepared };
}

test('cli.io-presence.overlaps-off-no-item-query: clause 1: a registered seat\'s heartbeat with overlaps off sends no item-list query to the board [C7,#5329]', t => {
  const { board, ctx } = twoClaims(t);
  const { prepared, lines } = beat(board, ctx, { overlaps: false });
  assert.ok(prepared.some(sql => /FROM agent WHERE agent_path/u.test(sql)), 'the heartbeat looked up its seat');
  assert.deepEqual(prepared.filter(sql => /FROM item\b/u.test(sql)), [], 'no statement lists items');
  assert.deepEqual(lines, []);
});

test('cli.io-presence.overlaps-on-prints-line: clause 2: with overlaps on and two claims recording the same file, the heartbeat prints the overlap line [C7,#5329]', t => {
  const { board, ctx, seats, items } = twoClaims(t);
  const { lines } = beat(board, ctx, { overlaps: true });
  assert.deepEqual(lines, [`#${items[0]} overlaps #${items[1]} (${seats[1].id}) on shared.js`]);
});

test('cli.io-presence.default-loop-claim-no-item-query: clause 1: a claim heartbeat for a default-loop next sends no item-list query, and one for any other io still lists [C7,#5329]', t => {
  assert.equal(claimHeartbeatOverlaps({ defaultLoop: true }), false);
  assert.equal(claimHeartbeatOverlaps({}), true);
  const { board, ctx } = twoClaims(t);
  const quiet = beat(board, ctx, { overlaps: claimHeartbeatOverlaps({ defaultLoop: true }) });
  assert.deepEqual(quiet.prepared.filter(sql => /FROM item\b/u.test(sql)), [], 'no statement lists items');
  assert.deepEqual(quiet.lines, []);
  const loud = twoClaims(t);
  const listed = beat(loud.board, loud.ctx, { overlaps: claimHeartbeatOverlaps({}) });
  assert.ok(listed.prepared.some(sql => /FROM item\b/u.test(sql)), 'a non-default next still lists items');
});
