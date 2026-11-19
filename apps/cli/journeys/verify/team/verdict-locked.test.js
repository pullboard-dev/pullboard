import { DatabaseSync } from 'node:sqlite';
import assert from 'node:assert/strict';
import test from 'node:test';
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { privateFixtureFiles } from '../../../../../packages/gate/tests/fixtures/child.js';
import { waitForCondition } from '../../../tests/fixtures/runner/holders.js';

test('cli.journeys-verify-team-verdict-locked.the-wait-helper-polls-again-when: clause 1: the wait helper polls again when its read hits a locked board [E8]', { timeout: 30_000 }, async t => { // budget: hang ceiling; the lock is released after ~200 ms.
  const dir = privateFixtureFiles('verdict-locked-').root;
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = join(dir, 'board.sqlite');
  const writer = new DatabaseSync(file);
  writer.exec('PRAGMA journal_mode = DELETE; CREATE TABLE event (event_id INTEGER PRIMARY KEY, event_detail TEXT);');
  writer.exec('BEGIN EXCLUSIVE');
  let lockedReads = 0;
  setTimeout(() => { writer.exec('INSERT INTO event (event_detail) VALUES (\'done\'); COMMIT'); }, 200);
  await waitForCondition(() => {
    const db = new DatabaseSync(file, { readOnly: true });
    try {
      db.exec('PRAGMA busy_timeout = 0');
      return Boolean(db.prepare('SELECT event_detail FROM event LIMIT 1').get());
    } catch (error) {
      if (/locked|busy/i.test(error.message)) lockedReads += 1;
      throw error;
    } finally { db.close(); }
  }, 'the writer to release the board', { signal: t.signal });
  writer.close();
  assert.ok(lockedReads > 0, 'the first poll must have hit the held write lock');
});
