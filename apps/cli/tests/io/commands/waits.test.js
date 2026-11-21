/** The waits command files only this board's waits [C7]. */
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { FIXTURE_MODEL } from '../../fixtures/testkit.js';
import { cli } from '../../fixtures/next/take.js';
import { fixture } from '../../fixtures/next/take.js';

const MINUTE = 60_000;

test('cli.io-commands-waits.record-reaches-record-waits: clause 3: pullboard waits record on a fixture board straight after init, with a runner-unavailable row for another board host, lists no new item [test] [C7]', async t => {
  const box = await fixture(t);
  const joined = await cli(box, box.root, ['join', 'coordinator', '--model', FIXTURE_MODEL]);
  assert.equal(joined.code, 0, joined.out + joined.err);
  mkdirSync(process.env.PULLBOARD_MACHINE_HOME, { recursive: true });
  const db = new DatabaseSync(join(process.env.PULLBOARD_MACHINE_HOME, 'resources.sqlite'));
  db.exec("CREATE TABLE IF NOT EXISTS runner_unavailable (host TEXT PRIMARY KEY, since TEXT, detail TEXT DEFAULT '')");
  db.prepare('INSERT OR REPLACE INTO runner_unavailable (host, since, detail) VALUES (?, ?, ?)').run('other-board-host', new Date(box.clock.now().getTime() - 20 * MINUTE).toISOString(), 'CLEANUP_UNVERIFIED');
  db.close();
  const itemCount = () => box.board.db.prepare('SELECT COUNT(*) AS n FROM item').get().n;
  const before = itemCount();
  const recorded = await cli(box, box.root, ['waits', 'record']);
  assert.equal(recorded.code, 0, recorded.out + recorded.err);
  assert.equal(itemCount(), before, 'a runner row of another board host files no item');
});
