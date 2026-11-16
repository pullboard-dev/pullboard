/** A versioned flow report namespace is local derived state in the board exchange, so replicas never diverge or refuse an import (#2288). */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fixtureBoard } from '../../../board/tests/fixtures/board.js';
import {
  exportBoard,
  importBoard,
  semanticBoardDigest,
} from '../../index.js';

const KEYS = ['local:proof-stats:v2:report-v3:summary', 'local:proof-stats:v2:report-v4:item:7'];

/** Write the versioned report shards straight into a board's meta table. */
function seedReport(board) {
  for (const key of KEYS) board.db.prepare('INSERT INTO board_meta(meta_key,meta_value) VALUES (?,?)').run(key, '{"data":{"last":9},"numbers":[]}');
}

test('clause 2: a versioned report namespace is neither exported nor part of the native digest [R1,R2]', (t) => {
  const board = fixtureBoard(t);
  const before = semanticBoardDigest(exportBoard(board));
  seedReport(board);
  const exported = exportBoard(board);
  assert.deepEqual(exported.tables.board_meta.filter(row => KEYS.includes(row.meta_key)), [], 'the export filter leaves the namespace out');
  assert.equal(semanticBoardDigest(exported), before, 'report shards leave the native digest unchanged, so replicas never diverge');
});

test('clause 2: an import skips a supplied versioned report namespace instead of refusing or storing it [R1,R2]', (t) => {
  const source = fixtureBoard(t), target = fixtureBoard(t);
  const document = exportBoard(source);
  document.tables.board_meta = [...document.tables.board_meta, ...KEYS.map(meta_key => ({ meta_key, meta_value: '{"data":{"last":9},"numbers":[]}' }))];
  importBoard(target, document);
  assert.deepEqual(target.db.prepare('SELECT meta_key FROM board_meta WHERE meta_key IN (?, ?)').all(...KEYS), [], 'the import skips the supplied shards');
});
