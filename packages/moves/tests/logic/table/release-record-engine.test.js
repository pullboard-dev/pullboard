/** @pullboard-test-input source-cell packages/moves */
/** @pullboard-world-pin reads the recorded release history fixture to prove each replay record carries the engine its release was written at. A release record hands the table the engine the board stamped on the release, and the replay verdicts do not change [C7,#9831]. */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { boardReleaseEngine } from '../../../index.js';
import { readReleaseRecords } from '../../../index.js';
import { replayTable } from '../../../index.js';

const HISTORY = JSON.parse(readFileSync(new URL('../../fixtures/table/release-history.json', import.meta.url), 'utf8'));
const RELEASE = boardReleaseEngine();

/** The recorded events on an in-memory board; `engineOf` gives the engine a release event is stamped with, or undefined for none. */
function recordedBoard(engineOf) {
  const db = new DatabaseSync(':memory:');
  db.exec(`CREATE TABLE event (event_id INTEGER PRIMARY KEY, event_at TEXT NOT NULL, event_by TEXT NOT NULL, event_kind TEXT NOT NULL, item_id INTEGER, event_detail TEXT NOT NULL DEFAULT '{}');
    CREATE TABLE agent (agent_id TEXT PRIMARY KEY, agent_route TEXT)`);
  const event = db.prepare('INSERT INTO event VALUES (?, ?, ?, ?, ?, ?)');
  for (const [id, at, by, kind, item, detail] of HISTORY.events) {
    const engine = kind === 'release' ? engineOf(id) : undefined;
    event.run(id, at, by, kind, item, JSON.stringify(engine === undefined ? detail : { ...detail, engine }));
  }
  const agent = db.prepare('INSERT INTO agent VALUES (?, ?)');
  for (const [id, route] of HISTORY.agents) agent.run(id, route);
  return { db };
}

const read = engineOf => readReleaseRecords(recordedBoard(engineOf), { since: HISTORY.since, only: HISTORY.releases });
const verdicts = records => replayTable(RELEASE.table, RELEASE.rules, records.release, { cut: HISTORY.since });

test('clause 1: release-records.js hands the table the engine each recorded release was written at, in the replay state [C7,#9831]', () => {
  const records = read(id => (id % 2 === 0 ? 14 : 15));
  assert.equal(records.release.length, 55);
  for (const record of records.release) assert.equal(record.snapshot.engine, record.event.id % 2 === 0 ? 14 : 15);
  assert.ok(records.reclaim.every(record => !('engine' in record.snapshot)));
});

test('clause 1: a release recorded by an older engine with none stamped reads as engine null [C7,#9831]', () => {
  const records = read(() => undefined);
  assert.ok(records.release.every(record => record.snapshot.engine === null));
});

test('clause 2: the 65-record replay gives the same verdicts as before with no rule reading the engine yet [C7,#9831]', () => {
  const bare = verdicts(read(() => undefined));
  const stamped = verdicts(read(() => 14));
  assert.deepEqual(bare.disagreements, []);
  assert.deepEqual(stamped.disagreements, []);
  assert.deepEqual([bare.total, bare.agreed, bare.notReplayable], [stamped.total, stamped.agreed, stamped.notReplayable]);
  assert.deepEqual([HISTORY.releases.length, stamped.agreed], [65, 55]);
});
