/** The machine every-write log rotates to one prior file past 64 MB and never loses the current write [#6478]. */
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdirSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import { truncateSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { cellProject } from '../../../fixtures/cell.js';
import { BOARD_WRITES_MAX_BYTES } from '../../../../src/io/board/hold/rotate.js';
import { rotateBoardWritesLog } from '../../../../src/io/board/hold/rotate.js';
import { recordBoardHold } from '../../../../src/io/board/hold/log.js';

/** Run a body with the machine home pointed at a fresh directory, then restore it. */
function withHome(t, body) {
  const saved = process.env.PULLBOARD_MACHINE_HOME;
  const home = join(cellProject(t).repo, 'rotate-home');
  mkdirSync(home);
  process.env.PULLBOARD_MACHINE_HOME = home;
  t.after(() => {
    if (saved === undefined) delete process.env.PULLBOARD_MACHINE_HOME; else process.env.PULLBOARD_MACHINE_HOME = saved;
  });
  body(home);
}
const write = command => recordBoardHold({ command, seat: 's', durationMs: 5, acquiredAt: Date.now(), allWrites: true });

test('clause 1: a log past 64 MB moves to one prior file and the current write lands in the fresh log [C7,#6478]', t => withHome(t, home => {
  const log = join(home, 'board-writes.jsonl');
  writeFileSync(log, 'old\n');
  truncateSync(log, BOARD_WRITES_MAX_BYTES + 1);
  assert.equal(rotateBoardWritesLog(), true);
  write('after');
  assert.equal(existsSync(log + '.1'), true, 'the prior file exists');
  assert.equal(readFileSync(log, 'utf8').trim().split('\n').length, 1, 'the fresh log holds exactly the current write');
  assert.match(readFileSync(log, 'utf8'), /"command":"after"/u);
}));

test('clause 1: a second rotation replaces the prior file and a small log is never rotated [C7,#6478]', t => withHome(t, home => {
  const log = join(home, 'board-writes.jsonl');
  write('first');
  write('second');
  assert.equal(rotateBoardWritesLog(), false);
  assert.equal(existsSync(log + '.1'), false, 'a small log stays in place');
  assert.equal(readFileSync(log, 'utf8').trim().split('\n').length, 2);
  truncateSync(log, BOARD_WRITES_MAX_BYTES + 1);
  rotateBoardWritesLog();
  write('third');
  truncateSync(log, BOARD_WRITES_MAX_BYTES + 1);
  rotateBoardWritesLog();
  write('fourth');
  assert.equal(existsSync(log + '.2'), false, 'only one prior file is kept');
  assert.match(readFileSync(log, 'utf8'), /"command":"fourth"/u);
}));
