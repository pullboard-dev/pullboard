/** replayClaims measures pull claims on a copy of the board database and leaves the source file untouched [C7,#12097]. */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { test } from 'node:test';
import { cellBoard } from '../../../board/tests/fixtures/cell-board.js';
import { cellRepo } from '../../../store/tests/fixtures/cell.js';
import { replayClaims } from '../../src/io/claim-replay.js';
import { replayLine } from '../../src/io/claim-replay.js';

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

test('api.io-claim-replay.free-space-guard: replayClaims throws before writing any copy when free space is under twice the source size [C7,#12097]', t => {
  const repo = cellRepo(t, { real: true });
  cellBoard(t, repo.boardFile, undefined, { real: true, gitRoot: repo.root });
  const before = readdirSync(tmpdir()).sort();
  assert.throws(() => replayClaims({ db: repo.boardFile, root: repo.root, count: 1, freeBytes: () => 0 }), /needs \d+ free bytes/);
  assert.deepEqual(readdirSync(tmpdir()).sort(), before, 'the temp directory is unchanged');
});

test('api.io-claim-replay.real-path: replayClaims over a scratch board prints one line with p50, p95 and max for 50 claims [C7,#12097]', t => {
  const repo = cellRepo(t, { real: true });
  cellBoard(t, repo.boardFile, undefined, { real: true, gitRoot: repo.root });
  const line = replayLine(replayClaims({ db: repo.boardFile, root: repo.root, count: 50 }), 50);
  console.log(line);
  assert.match(line, /^claim replay: 50 claims p50 [\d.]+ ms, p95 [\d.]+ ms, max [\d.]+ ms$/);
});
