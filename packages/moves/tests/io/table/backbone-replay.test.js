/** The backbone table's rows carry the machine's guards, and replaying a fixture board's recorded moves agrees with it [C7,#8100]. */
import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { after } from 'node:test';
import { test } from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { privateFixtureFiles } from '../../../../gate/tests/fixtures/child.js';
import { MACHINE } from '../../../../state/light.js';
import { BACKBONE_RULES } from '../../../index.js';
import { BACKBONE_TABLE } from '../../../index.js';
import { readMoveRecords } from '../../../index.js';
import { replayTable } from '../../../index.js';
import { runTable } from '../../../index.js';

const files = privateFixtureFiles('pullboard-backbone-replay-');
after(() => rmSync(files.root, { recursive: true, force: true }));
const CUT = '2026-11-05T00:00:00.000Z';
let count = 0;

/** A fixture board on real SQLite whose events are the given rows: [at, by, kind, item, detail]. */
function board(rows) {
  const file = join(files.root, `board-${count += 1}.sqlite`);
  const db = new DatabaseSync(file);
  db.exec(`CREATE TABLE event (event_id INTEGER PRIMARY KEY AUTOINCREMENT, event_at TEXT NOT NULL, event_by TEXT NOT NULL, event_kind TEXT NOT NULL, item_id INTEGER, event_detail TEXT NOT NULL DEFAULT '{}')`);
  const add = db.prepare('INSERT INTO event (event_at, event_by, event_kind, item_id, event_detail) VALUES (?, ?, ?, ?, ?)');
  for (const [at, by, kind, item, detail] of rows) add.run(at, by, kind, item, JSON.stringify(detail ?? {}));
  db.close();
  return file;
}

/** The lifecycle of item 1, with item 2 waiting on it: add, claim, submit, accept, then a claim of the waiter. */
const LIFECYCLE = [
  ['2026-11-01T00:00:00.000Z', 'coordinator', 'add', 1, { after: '[]' }],
  ['2026-11-01T00:00:01.000Z', 'coordinator', 'add', 2, { after: '[1]' }],
  ['2026-11-10T00:00:00.000Z', 'core-1', 'claim', 1, { leaseUntil: '2026-11-10T03:00:00.000Z' }],
  ['2026-11-10T01:00:00.000Z', 'core-1', 'submit', 1, {}],
  ['2026-11-10T02:00:00.000Z', 'core-2', 'accept', 1, {}],
  ['2026-11-10T04:00:00.000Z', 'core-3', 'claim', 2, { leaseUntil: '2026-11-10T09:00:00.000Z' }],
];

test('moves.backbone-replay.every-backbone-row-whose-declared-move-has: clause 1: every backbone row whose declared move has a guard names each guard as a rule fact [C7,#8100]', () => {
  const guarded = BACKBONE_TABLE.items.filter(row => row.guards.length);
  assert.ok(guarded.length >= 10);
  MACHINE.moves.forEach((move, index) => {
    assert.deepEqual(BACKBONE_TABLE.items[index].guards, move.guards ?? []);
    for (const guard of move.guards ?? []) assert.ok(Object.hasOwn(BACKBONE_RULES, guard), `${move.verb} guard ${guard} is a rule fact`);
  });
  assert.ok(BACKBONE_TABLE.guards.length > 10 && BACKBONE_TABLE.outcomes.length === 1);
});

test('moves.backbone-replay.replaying-a-fixture-board-s-recorded-add: clause 2: replaying a fixture board\'s recorded add, claim, submit and accept moves reports zero disagreements [C7,#8100]', () => {
  const records = readMoveRecords(board(LIFECYCLE), { since: CUT });
  assert.deepEqual(records.map(record => record.move.name), ['claim', 'submit', 'accept', 'claim']);
  const report = replayTable(BACKBONE_TABLE, BACKBONE_RULES, records, { cut: CUT });
  assert.deepEqual([report.agreed, report.disagreed, report.notReplayable], [4, 0, 0]);
});

test('moves.backbone-replay.a-move-the-board-accepted-but-a: clause 2: a move the board accepted but a guard refuses is reported as a disagreement with its event id [C7,#8100]', () => {
  const rows = [...LIFECYCLE.slice(0, 4), ['2026-11-10T01:30:00.000Z', 'core-9', 'claim', 2, { leaseUntil: '2026-11-10T09:00:00.000Z' }], ['2026-11-10T02:00:00.000Z', 'core-1', 'accept', 1, {}]];
  const report = replayTable(BACKBONE_TABLE, BACKBONE_RULES, readMoveRecords(board(rows), { since: CUT }), { cut: CUT });
  assert.deepEqual(report.disagreements.map(entry => [entry.event, entry.table.code]), [[5, 'BLOCKED'], [6, 'SELF_VERIFY']]);
});

test('moves.backbone-replay.a-record-built-by-readmoverecords-is-matched: clause 3: a record built by readMoveRecords is matched by runTable on the field it was written with [C7,#8100]', () => {
  const [claim] = readMoveRecords(board(LIFECYCLE), { since: CUT });
  assert.equal(claim.move.name, 'claim');
  const answer = runTable(BACKBONE_TABLE, BACKBONE_RULES, structuredClone(claim.snapshot), structuredClone(claim.move));
  assert.deepEqual(answer.events, claim.recorded.events);
  assert.equal(answer.via[0], 'record');
  const stranger = runTable(BACKBONE_TABLE, BACKBONE_RULES, structuredClone(claim.snapshot), { ...structuredClone(claim.move), name: 'teleport' });
  assert.equal(stranger.refused.code, 'UNKNOWN_MOVE');
  assert.match(stranger.refused.message, /teleport/u);
});
