/** replayClaims measures pull claims on a copy of the board database and leaves the source file untouched [C7,#12097]. */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { cellBoard } from '../../../board/tests/fixtures/cell-board.js';
import { cellRepo } from '../../../store/tests/fixtures/cell.js';
import { replayClaims } from '../../src/io/claim-replay.js';

test('api.io-claim-replay.replay-p95: replayClaims runs 50 claims on a copy of the board database and returns p50, p95 and max with the source bytes unchanged [C7,#12097]', t => {
  const repo = cellRepo(t, { real: true });
  const board = cellBoard(t, repo.boardFile, undefined, { real: true, gitRoot: repo.root });
  const before = readFileSync(repo.boardFile);
  const { p50, p95, max } = replayClaims({ db: repo.boardFile, root: repo.root, count: 50 });
  for (const value of [p50, p95, max]) assert.ok(Number.isFinite(value) && value >= 0, `a millisecond figure: ${value}`);
  assert.ok(p50 <= p95 && p95 <= max, 'the figures rise from p50 to max');
  assert.ok(readFileSync(repo.boardFile).equals(before), 'the source database file is byte for byte as before');
  assert.ok(board.db, 'the source board stayed open through the replay');
});
