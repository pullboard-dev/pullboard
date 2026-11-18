/** @pullboard-test-input source-cell store */
/** A BOARD_BUSY refusal names the write holder's command, pid and seat, or says the holder is unrecorded [C7]. */
import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { boardBusyError } from '../../../src/io/board/busy.js';
import { discardBoardWriteMarker } from '../../../src/io/board/write/lock.js';
import { prepareBoardWriteIdentity } from '../../../src/io/board/write/lock.js';
import { prepareBoardWriteMarker } from '../../../src/io/board/write/lock.js';
import { temporaryDirectory } from '../../fixtures/tmp.js';

/** A board file whose lock a peer connection holds; the second connection fails its own BEGIN IMMEDIATE with the real busy error. */
function contended(t) {
  const directory = temporaryDirectory('pullboard-busy-');
  const file = join(directory, 'board.sqlite');
  const holder = new DatabaseSync(file);
  const waiter = new DatabaseSync(file, { timeout: 0 });
  holder.exec('CREATE TABLE t (x)');
  holder.exec('BEGIN IMMEDIATE');
  t.after(() => { holder.close(); waiter.close(); rmSync(directory, { recursive: true, force: true }); });
  let busy;
  try { waiter.exec('BEGIN IMMEDIATE'); } catch (error) { busy = error; }
  assert.ok(busy, 'the peer really holds the lock');
  return { file, waiter, busy };
}

test('store.io-board-busy.names-holder: clause 1: with a peer holding BEGIN IMMEDIATE and a write-holders marker, boardBusyError gives a BOARD_BUSY message naming that holder\'s command, pid and seat [C7]', t => {
  const { file, waiter, busy } = contended(t);
  prepareBoardWriteIdentity();
  const marker = prepareBoardWriteMarker(waiter, { command: 'claim', seat: 'core-9' });
  t.after(() => discardBoardWriteMarker(marker));
  assert.ok(marker, 'the holder published its marker');
  const error = boardBusyError(file, Date.now(), busy);
  assert.equal(error.code, 'BOARD_BUSY');
  assert.match(error.message, /"command":"claim"/u);
  assert.match(error.message, new RegExp(`"pid":${process.pid}\\b`, 'u'));
  assert.match(error.message, /"seat":"core-9"/u);
});

test('store.io-board-busy.no-marker-says-unrecorded: clause 2: with a peer holding the lock and no marker, the message says the holder is unrecorded instead of naming nobody [C7]', t => {
  const { file, busy } = contended(t);
  const error = boardBusyError(file, Date.now(), busy);
  assert.equal(error.code, 'BOARD_BUSY');
  assert.match(error.message, /holder unrecorded/u);
  assert.doesNotMatch(error.message, /observed writer records/u);
});
