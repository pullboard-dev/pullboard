/** The replay core: counts agreed, disagreed and not-replayable records, names each disagreement, and never replays a record from before the cut [C7,#8069]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { defineRules } from '../../../index.js';
import { replayTable } from '../../../index.js';

const RULES = defineRules({
  claimed: { says: 'the item is claimed', holds: s => s.item.status === 'claimed' },
  mine: { says: 'the caller holds the claim', holds: (s, m) => s.item.owner === m.actor },
});
const TABLE = {
  name: 'release',
  guards: [
    { id: 'claimed', requires: 'claimed', code: 'NOT_CLAIMED', message: 'm', next: 'n' },
    { id: 'mine', requires: 'mine', code: 'NOT_YOURS', message: 'm', next: 'n' },
  ],
  outcomes: [{ id: 'plain', patch: () => ({ status: 'open' }), events: (s, m) => [{ kind: 'release', by: m.actor, note: undefined }] }],
};
const CUT = '2026-11-10T00:00:00.000Z';
const record = (id, over = {}) => ({ event: { id, at: '2026-11-12T00:00:00.000Z' }, snapshot: { item: { status: 'claimed', owner: 'a' } }, move: { name: 'release', actor: 'a' }, recorded: { events: [{ kind: 'release', by: 'a' }] }, ...over });
const replay = (records) => replayTable(TABLE, RULES, records, { cut: CUT });

test('moves.replay.replay-counts-agreed-disagreed-and-not: replay counts agreed, disagreed and not-replayable records [C7,#8069]', () => {
  const report = replay([
    record(1),
    record(2, { recorded: { refused: 'NOT_YOURS' }, move: { name: 'release', actor: 'b' } }),
    record(3, { recorded: { refused: 'NOT_CLAIMED' } }),
    record(4, { snapshot: undefined }),
    record(5, { recorded: { note: 'x' } }),
    record(6, { snapshot: { item: null } }),
  ]);
  assert.deepEqual([report.total, report.agreed, report.disagreed, report.notReplayable, report.beforeCut], [6, 2, 1, 3, 0]);
  assert.deepEqual(report.unreplayable.map(entry => entry.event), [4, 5, 6]);
  assert.match(report.unreplayable[2].reason, /rules could not read the snapshot: TypeError/);
});

test('moves.replay.each-disagreement-names-its-event-id: each disagreement names its event id, the recorded outcome and the table outcome [C7,#8069]', () => {
  const report = replay([
    record(11, { recorded: { refused: 'NOT_CLAIMED' } }),
    record(12, { recorded: { events: [{ kind: 'release', by: 'a', note: 'late' }] } }),
    record(13, { move: { name: 'release', actor: 'b' }, recorded: { refused: 'NOT_CLAIMED' } }),
    record(14, { move: { name: 'release', actor: 'b' }, recorded: { events: [{ kind: 'release', by: 'b' }] } }),
  ]);
  assert.deepEqual(report.disagreements, [
    { event: 11, recorded: { decision: 'refused', code: 'NOT_CLAIMED' }, table: { decision: 'accepted', events: [{ kind: 'release', by: 'a' }] }, differs: 'decision' },
    { event: 12, recorded: { decision: 'accepted', events: [{ kind: 'release', by: 'a', note: 'late' }] }, table: { decision: 'accepted', events: [{ kind: 'release', by: 'a' }] }, differs: 'detail' },
    { event: 13, recorded: { decision: 'refused', code: 'NOT_CLAIMED' }, table: { decision: 'refused', code: 'NOT_YOURS' }, differs: 'code' },
    { event: 14, recorded: { decision: 'accepted', events: [{ kind: 'release', by: 'b' }] }, table: { decision: 'refused', code: 'NOT_YOURS' }, differs: 'decision' },
  ]);
});

test('moves.replay.a-record-from-before-the-0: a record from before the 0.9.4 cut is counted before-cut and never replayed [C7,#8069]', () => {
  let ran = 0;
  const counting = { ...TABLE, outcomes: [{ ...TABLE.outcomes[0], events: (s, m) => { ran++; return TABLE.outcomes[0].events(s, m); } }] };
  const old = record(21, { event: { id: 21, at: '2026-11-09T23:59:59.999Z' }, recorded: { refused: 'NOT_CLAIMED' } });
  const edge = record(22, { event: { id: 22, at: CUT } });
  const report = replayTable(counting, RULES, [old, edge, record(23, { event: { id: 23, at: Date.parse(CUT) - 1 }, snapshot: 'garbage' })], { cut: CUT });
  assert.deepEqual([report.total, report.beforeCut, report.agreed, report.disagreed, report.notReplayable], [3, 2, 1, 0, 0]);
  assert.equal(ran, 1);
  assert.equal(replayTable(counting, RULES, [old], { cut: Date.parse(CUT) }).beforeCut, 1);
});

test('moves.replay.replay-needs-a-cut-that-parses: replay needs a cut that parses and a list of records, and never reads the clock or writes a snapshot [C7,#8069]', () => {
  assert.throws(() => replayTable(TABLE, RULES, [], {}), { code: 'REPLAY_CUT' });
  assert.throws(() => replayTable(TABLE, RULES, [], { cut: 'soon' }), { code: 'REPLAY_CUT' });
  assert.throws(() => replayTable(TABLE, RULES, 'nope', { cut: CUT }), { code: 'REPLAY_RECORDS' });
  const mine = record(31);
  const before = structuredClone(mine);
  replay([mine]);
  assert.deepEqual(mine, before);
  assert.deepEqual(replay([]), { total: 0, agreed: 0, disagreed: 0, notReplayable: 0, beforeCut: 0, disagreements: [], unreplayable: [] });
});
