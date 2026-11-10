/** A board read retries a transient "unable to open database file" before it refuses [test]. */
import assert from 'node:assert/strict';
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import {
  CANTOPEN_RETRY_MS,
  openBoardReadOnly,
} from '../../../../src/io/board/read/snapshot.js';

/** A fake clock whose sleeps advance time, so the five second backoff runs instantly. */
function clock(onSleep = () => {}) {
  let at = 0;
  const sleeps = [];
  return { sleeps, now: () => at, sleep: ms => { sleeps.push(ms); at += ms; onSleep(sleeps.length); } };
}

/** Make a folder for one test and remove it afterwards. */
function folder(t) {
  const dir = mkdtempSync(join(tmpdir(), 'cantopen-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test('clause 1: a board read retries SQLITE_CANTOPEN with growing backoff until the file opens [C7]', t => {
  const dir = folder(t);
  const file = join(dir, 'later', 'board.sqlite');
  const fake = clock(count => {
    if (count !== 4) return;
    mkdirSync(join(dir, 'later'));
    new DatabaseSync(file).close();
  });
  const db = openBoardReadOnly(file, fake);
  t.after(() => db.close());
  assert.equal(fake.sleeps.length, 4, 'it retried until the file appeared');
  assert.deepEqual(fake.sleeps, [10, 20, 40, 80], 'the backoff doubles');
});

test('clause 2: a board read that still cannot open after five seconds names the file and the open-file count [C7]', t => {
  const file = join(folder(t), 'missing', 'board.sqlite');
  const fake = clock();
  assert.throws(() => openBoardReadOnly(file, { ...fake, openFiles: () => 42 }),
    error => error.code === 'BOARD_BUSY' && error.message.includes(file) && /42 open files/u.test(error.message));
  assert.equal(fake.now(), CANTOPEN_RETRY_MS, 'it waited the whole five seconds, no more');
  assert.ok(Math.max(...fake.sleeps) <= 500, 'no single backoff step exceeds half a second');
});

test('a board read does not retry an error that is not SQLITE_CANTOPEN [C7]', t => {
  const dir = folder(t);
  const fake = clock();
  assert.throws(() => openBoardReadOnly(dir, fake), error => !/open files/u.test(error.message));
  assert.equal(fake.sleeps.length < 3, true, 'a directory is not mistaken for a transient open failure');
});
