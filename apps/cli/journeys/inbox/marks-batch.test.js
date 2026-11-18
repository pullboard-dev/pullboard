/** With inbox.batchedMarks on, the marks for shouts inbox read are written by a background worker in one batch [C7,#8942]. */
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { test } from 'node:test';
import * as store from '../../../../packages/store/index.js';
import { drainInboxMarks } from '../../../../packages/store/index.js';
import { spoolFile } from '../../../../packages/store/index.js';
import { spoolInboxMarks } from '../../../../packages/store/index.js';
import { marksBoard } from '../../tests/fixtures/inbox/marks.js';

const mark = (board, id) => board.db.prepare('SELECT agent_last_shout_id AS m FROM agent WHERE agent_id=?').get(id).m;

test('cli.journeys-inbox-marks-batch.delivery-marks-for-shouts-read-by: clause 1: delivery marks for shouts read by inbox are recorded by the worker in one batched write [C7,#8942]', t => {
  const { board, file, seats, ports } = marksBoard(t, 3);
  spoolInboxMarks(file, [[seats[0], 2]]);
  spoolInboxMarks(file, [[seats[1], 3], [seats[2], 1]]);
  assert.deepEqual(seats.map(id => mark(board, id)), [0, 0, 0], 'a spooled mark writes nothing yet');
  let commits = 0;
  const real = board.db.exec.bind(board.db);
  board.db.exec = sql => { if (/^\s*(COMMIT|RELEASE)/i.test(sql)) commits++; return real(sql); };
  assert.equal(drainInboxMarks(file, ports), 3, 'one mark per seat');
  board.db.exec = real;
  assert.equal(commits, 1, 'one transaction for every spooled mark');
  assert.deepEqual(seats.map(id => mark(board, id)), [2, 3, 1]);
  assert.equal(existsSync(spoolFile(file)), false, 'the spool is consumed');
});

test('cli.journeys-inbox-marks-batch.a-shout-read-once-is-not: clause 2: a shout read once is not delivered again after the batch records [C7,#8942]', t => {
  const { board, file, seats, ports } = marksBoard(t, 1);
  const shown = store.inbox(board, seats[0], { markRead: false });
  assert.equal(shown.length, 3, 'unread shouts are shown');
  assert.equal(store.inbox(board, seats[0], { markRead: false }).length, 3, 'until the batch records, a read marks nothing');
  spoolInboxMarks(file, [[seats[0], Math.max(...shown.map(shout => shout.shout_id))]]);
  drainInboxMarks(file, ports);
  assert.equal(store.inbox(board, seats[0]).length, 0, 'after the batch the same shouts are not delivered again');
  assert.equal(drainInboxMarks(file, ports), 0, 'an empty spool writes nothing');
});
