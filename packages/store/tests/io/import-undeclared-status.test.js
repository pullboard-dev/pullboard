/** A board import refuses an item status the lifecycle never declared, before inserting anything [SM15]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { addItem } from '../../index.js';
import { exportBoard } from '../../index.js';
import { importBoard } from '../../index.js';
import { fixtureBoard } from '../../../board/tests/fixtures/board.js';

test('clause 1: restoreDocument refuses UNDECLARED_STATE for an item_status not in STATES, with nothing inserted [SM15]', (t) => {
  const source = fixtureBoard(t);
  addItem(source, { by: 'coordinator', lane: 'web', title: 'one' });
  const document = exportBoard(source);
  document.tables.item[0].item_status = 'limbo';
  const target = fixtureBoard(t);
  const before = target.db.prepare('SELECT COUNT(*) AS n FROM item').get().n;
  assert.throws(() => importBoard(target, document), (error) => error.code === 'UNDECLARED_STATE' && /limbo/.test(error.message));
  assert.equal(target.db.prepare('SELECT COUNT(*) AS n FROM item').get().n, before, 'refused before it inserted');
});
