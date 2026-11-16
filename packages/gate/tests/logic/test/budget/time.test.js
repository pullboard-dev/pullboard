/** Where item time goes: every phase sums to each landed item's clock time, in a fixture with known events [R1,R2,C7]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { TIME_PHASES } from '../../../../../stats/index.js';
import { checkpointLine } from '../../../../../stats/index.js';
import { timeLines } from '../../../../../stats/index.js';
import { timeStats } from '../../../../../stats/index.js';
import { weeklyDue } from '../../../../../stats/index.js';
import { proofFields } from '../../../../../verify/index.js';
import { mkdtempSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import { rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runFixtureGit } from '../../../fixtures/child.js';
import { recordTimeCheckpoint } from '../../../../../stats/index.js';
import { retainedReceipts } from '../../../../index.js';
import { events } from '../../../../../store/index.js';

const T0 = Date.parse('2026-10-01T00:00:00.000Z');
const MIN = 60000;
let id = 0;
/** One native event at a known minute offset. */
const ev = (item, minute, kind, detail = {}) => ({ event_id: ++id, item_id: item, event_kind: kind, event_at: new Date(T0 + minute * MIN).toISOString(), event_detail: JSON.stringify(detail) });

/** Item 1: one clean pass. Item 2: a reject cycle and an idle hold, with recorded gate and seat time. */
const HISTORY = [
  ev(1, 0, 'add'), ev(1, 10, 'claim'), ev(1, 40, 'submit'), ev(1, 50, 'reserve'), ev(1, 60, 'accept'), ev(1, 65, 'merged'),
  ev(2, 0, 'add'), ev(2, 5, 'claim'), ev(2, 15, 'fact', { kind: 'measurement', text: JSON.stringify({ kind: 'seat-time', toolMs: 4 * MIN, thinkingMs: 2 * MIN }) }),
  ev(2, 20, 'release'), ev(2, 30, 'claim'),
  ev(2, 50, 'submit', { gatePhases: { static: MIN, doctrine: 2 * MIN, check: 3 * MIN, test: 4 * MIN, conflict: 0 } }),
  ev(2, 60, 'reserve'), ev(2, 70, 'reject'), ev(2, 80, 'claim'), ev(2, 95, 'submit'), ev(2, 100, 'reserve'), ev(2, 110, 'accept'), ev(2, 120, 'merged'),
];
const NOW = T0 + 200 * MIN;

test('every phase sums to each landed item clock time [R1,R2,C7]', () => {
  const stats = timeStats(HISTORY, { now: NOW, days: 7 });
  assert.equal(stats.landed, 2);
  for (const item of stats.items) {
    const sum = TIME_PHASES.reduce((total, phase) => total + item.phases[phase], 0);
    assert.equal(sum, item.clockMs, `item ${item.id} phases sum to its clock time`);
  }
  assert.deepEqual(stats.items.map(item => item.clockMs / MIN), [65, 120]);
});

test('queued, building, review and landing minutes match the known events [R1,R2,C7]', () => {
  const [one, two] = timeStats(HISTORY, { now: NOW, days: 7 }).items;
  assert.deepEqual([one.phases.queued, one.phases.building, one.phases.reviewWait, one.phases.reviewing, one.phases.landing].map(ms => ms / MIN), [10, 30, 10, 10, 5]);
  assert.equal(two.phases.idleHold / MIN, 0, 'unclaimed time is not an idle hold');
  assert.equal(two.phases.queued / MIN, 15, 'release to the next claim is unclaimed queue time');
  assert.equal(two.phases.rejectWaitingBuilder / MIN, 10, 'reject to the next claim waits for the builder');
  assert.equal(two.phases.rejectRebuilding / MIN, 15, 'the next claim to submit rebuilds');
});

test('recorded gate phases and seat time split building without changing the total [R1,R2,C7]', () => {
  const [, two] = timeStats(HISTORY, { now: NOW, days: 7 }).items;
  assert.deepEqual(['static', 'doctrine', 'check', 'test', 'conflict'].map(phase => two.phases[phase] / MIN), [1, 2, 3, 4, 0]);
  assert.equal(two.phases.tool / MIN, 4);
  assert.equal(two.phases.thinking / MIN, 2);
});

test('malformed and unrelated measurements do not invent seat time [R1,R2,C7]', () => {
  for (const text of ['not JSON', 'null', '[]', '{"kind":"cost","toolMs":240000}',
    '{"kind":"seat-time","toolMs":-1,"thinkingMs":"120000"}']) {
    const history = [ev(1, 0, 'add'), ev(1, 10, 'claim'), ev(1, 15, 'fact', { kind: 'measurement', text }),
      ev(1, 40, 'submit'), ev(1, 50, 'accept'), ev(1, 60, 'merged')];
    const row = timeStats(history, { now: NOW }).items[0];
    assert.equal(row.phases.tool, 0);
    assert.equal(row.phases.thinking, 0);
    assert.equal(row.phases.building / MIN, 30);
    assert.equal(TIME_PHASES.reduce((sum, phase) => sum + row.phases[phase], 0), row.clockMs);
  }
});

test('medians and totals cover the window and drop items that landed outside it [R1,R2,C7]', () => {
  const stats = timeStats(HISTORY, { now: NOW, days: 7 });
  assert.equal(stats.phases.queued.totalMs / MIN, 25);
  assert.equal(stats.phases.queued.medianMs / MIN, 12.5);
  assert.equal(timeStats(HISTORY, { now: NOW + 8 * 86400000, days: 7 }).landed, 0);
  assert.equal(timeLines(stats).length, TIME_PHASES.length + 1, 'each phase gets a median and total row, including zero');
});

test('a stalled claim charges idle time through the holder’s next real activity [R1,R2,C7]', () => {
  const holder = 'core-1';
  const history = [ev(11, 0, 'add'), { ...ev(11, 5, 'claim'), event_by: holder },
    { ...ev(11, 30, 'claim_stalled', { holder, lastActivity: new Date(T0 + 10 * MIN).toISOString(), observedAt: new Date(T0 + 30 * MIN).toISOString(), idleMinutes: 20 }), event_by: 'sentinel' },
    { ...ev(11, 35, 'fact', { kind: 'note' }), event_by: 'other' },
    { ...ev(11, 45, 'fact', { kind: 'note' }), event_by: holder },
    { ...ev(11, 60, 'submit'), event_by: holder }, ev(11, 65, 'accept'), ev(11, 70, 'merged')];
  const item = timeStats(history, { now: NOW }).items[0];
  assert.equal(item.phases.idleHold / MIN, 35, 'the other seat does not end the stall');
  assert.equal(item.phases.building / MIN, 20);
  assert.equal(TIME_PHASES.reduce((sum, phase) => sum + item.phases[phase], 0), item.clockMs);
});

test('repeated stall notices do not double count and a release closes the idle span [R1,R2,C7]', () => {
  const holder = 'core-1';
  const notice = minute => ({ ...ev(12, minute, 'claim_stalled', { holder, lastActivity: new Date(T0 + 20 * MIN).toISOString(), observedAt: new Date(T0 + minute * MIN).toISOString() }), event_by: 'sentinel' });
  const history = [ev(12, 0, 'add'), { ...ev(12, 1, 'claim'), event_by: holder }, ev(12, 5, 'submit'), ev(12, 6, 'reject'),
    { ...ev(12, 10, 'claim'), event_by: holder }, notice(40), notice(45), ev(12, 50, 'release'),
    { ...ev(12, 60, 'claim'), event_by: holder }, ev(12, 70, 'submit'), ev(12, 75, 'accept'), ev(12, 80, 'merged')];
  const item = timeStats(history, { now: NOW }).items[0];
  assert.equal(item.phases.idleHold / MIN, 30);
  assert.equal(item.phases.rejectRebuilding / MIN, 20);
  assert.equal(item.phases.rejectWaitingBuilder / MIN, 14);
  assert.equal(TIME_PHASES.reduce((sum, phase) => sum + item.phases[phase], 0), item.clockMs);
});

test('a checkpoint is one dated JSON line and a weekly one is due only after seven days [R1,C7]', () => {
  const stats = timeStats(HISTORY, { now: NOW, days: 7 });
  const line = checkpointLine(stats, { reason: 'weekly', retainedReceipts, events });
  assert.equal(JSON.parse(line).landed, 2);
  assert.equal(weeklyDue('', NOW), true);
  assert.equal(weeklyDue(`${line}\n`, NOW + 6 * 86400000), false);
  assert.equal(weeklyDue(`${line}\n`, NOW + 7 * 86400000), true);
  assert.equal(weeklyDue(`${checkpointLine(stats, { reason: 'release' })}\n`, NOW), true, 'a release does not replace a weekly checkpoint');
});

test('a production check receipt of 60000 ms shows as 60000 ms of check time, not a matching sum [R1,R2,C7]', () => {
  const proof = { item: 3, frozenDigest: null, environment: null, seat: 'core-1', runner: null, exitCode: 0,
    counts: { passed: 1, failed: 0, skipped: 0 }, durationMs: 60000, sourceClean: true };
  assert.ok(proofFields(proof), 'the production validator accepts these receipt fields');
  const receipt = { id: '11111111-1111-4111-8111-111111111111', kind: 'check', commit: 'a'.repeat(40), at: new Date(T0 + 8 * MIN).toISOString(), ...proof };
  const history = [ev(3, 0, 'add'), ev(3, 1, 'claim'), ev(3, 8, 'proof-run', { receipt }), ev(3, 10, 'submit'),
    ev(3, 12, 'reserve'), ev(3, 14, 'accept'), ev(3, 15, 'merged')];
  const stats = timeStats(history, { now: T0 + 200 * MIN, days: 7 });
  assert.equal(stats.phases.check.totalMs, 60000);
  assert.equal(stats.phases.building.totalMs, 9 * MIN - 60000);
  assert.equal(stats.items[0].clockMs, 15 * MIN);
});

test('a native submit criterion receipt contributes check time [R1,R2,C7]', () => {
  const proof = proofFields({ item: 4, frozenDigest: null, environment: null, seat: 'core-1', runner: null,
    exitCode: 0, counts: { passed: 1, failed: 0, skipped: 0 }, durationMs: MIN, sourceClean: true,
    submitPhase: 'criterion', submitAdmission: '11111111-1111-4111-8111-111111111111' });
  assert.ok(proof);
  const history = [ev(4, 0, 'add'), ev(4, 1, 'claim'), ev(4, 3, 'proof-run', { receipt: { id: '22222222-2222-4222-8222-222222222222', kind: 'submit', commit: 'b'.repeat(40), ...proof } }),
    ev(4, 4, 'submit'), ev(4, 5, 'reserve'), ev(4, 6, 'accept'), ev(4, 7, 'merged')];
  const stats = timeStats(history, { now: NOW, days: 7 });
  assert.equal(stats.phases.check.totalMs, MIN);
  assert.equal(stats.items[0].clockMs, 7 * MIN);
});

test('a receipt without a commit is an unattributed check without changing the item clock [R1,R2,C7]', () => {
  const history = [ev(10, 0, 'add'), ev(10, 1, 'claim'), ev(10, 3, 'proof-run', { receipt: { kind: 'check', durationMs: MIN } }),
    ev(10, 4, 'submit'), ev(10, 5, 'accept'), ev(10, 6, 'merged')];
  const stats = timeStats(history, { now: NOW });
  assert.equal(stats.phases.unattributedChecks.totalMs, MIN);
  assert.equal(TIME_PHASES.reduce((sum, name) => sum + stats.items[0].phases[name], 0), 6 * MIN);
});

test('only item-attributed gate receipts contribute static and doctrine time [R1,R2,C7]', () => {
  const history = [ev(5, 0, 'add'), ev(5, 1, 'claim'), ev(5, 10, 'submit'), ev(5, 11, 'reserve'), ev(5, 12, 'accept'), ev(5, 13, 'merged')];
  const receipts = [
    { item: 5, commit: 'a'.repeat(40), kind: 'static', at: new Date(T0 + 4 * MIN).toISOString(), runMs: MIN },
    { item: 5, commit: 'a'.repeat(40), kind: 'doctrine', at: new Date(T0 + 5 * MIN).toISOString(), runMs: 2 * MIN },
    { item: 6, commit: 'a'.repeat(40), kind: 'static', at: new Date(T0 + 4 * MIN).toISOString(), runMs: 9 * MIN },
    { kind: 'static', at: new Date(T0 + 4 * MIN).toISOString(), runMs: 9 * MIN },
  ];
  const stats = timeStats(history, { now: NOW, days: 7, receipts });
  assert.equal(stats.phases.static.totalMs, MIN);
  assert.equal(stats.phases.doctrine.totalMs, 2 * MIN);
  assert.equal(stats.unattributedReceipts, 1);
  assert.equal(TIME_PHASES.reduce((sum, name) => sum + stats.items[0].phases[name], 0), 13 * MIN);
});

test('item-linked gate receipts without a commit stay unattributed [R1,R2,C7]', () => {
  const history = [ev(5, 0, 'add'), ev(5, 1, 'claim'), ev(5, 10, 'submit'), ev(5, 11, 'reserve'), ev(5, 12, 'accept'), ev(5, 13, 'merged')];
  const receipts = ['static', 'doctrine', 'conflict'].map((kind, index) => ({
    item: 5, kind, at: new Date(T0 + (4 + index) * MIN).toISOString(), runMs: MIN,
  }));
  const stats = timeStats(history, { now: NOW, receipts });
  assert.equal(stats.phases.unattributedChecks.totalMs, 3 * MIN);
  for (const name of ['static', 'doctrine', 'conflict']) assert.equal(stats.phases[name].totalMs, 0);
  assert.equal(stats.phases.building.totalMs, 6 * MIN);
  assert.equal(TIME_PHASES.reduce((sum, name) => sum + stats.items[0].phases[name], 0), 13 * MIN);
});

test('a claim renewal does not truncate a measured gate phase [R1,R2,C7]', () => {
  const history = [ev(9, 0, 'add'), ev(9, 1, 'claim'), ev(9, 3, 'renew'), ev(9, 5, 'submit'), ev(9, 6, 'accept'), ev(9, 7, 'merged')];
  const receipts = [{ item: 9, commit: 'a'.repeat(40), kind: 'static', at: new Date(T0 + 4 * MIN).toISOString(), runMs: 3 * MIN }];
  const stats = timeStats(history, { now: NOW, receipts });
  assert.equal(stats.phases.static.totalMs, 3 * MIN);
  assert.equal(stats.phases.building.totalMs, MIN);
  assert.equal(TIME_PHASES.reduce((sum, name) => sum + stats.items[0].phases[name], 0), 7 * MIN);
});

test('a receipt commit is attributed only to a unique submitted item [R1,R2,C7]', () => {
  const commit = 'a'.repeat(40), at = new Date(T0 + 4 * MIN).toISOString();
  const history = [ev(7, 0, 'add'), ev(7, 1, 'claim'), ev(7, 5, 'submit', { commit }), ev(7, 6, 'accept'), ev(7, 7, 'merged')];
  const receipts = [{ kind: 'static', commit, at, runMs: MIN }];
  assert.equal(timeStats(history, { now: NOW, receipts }).phases.static.totalMs, MIN);
  history.push(ev(8, 0, 'add'), ev(8, 1, 'claim'), ev(8, 5, 'submit', { commit }), ev(8, 6, 'accept'), ev(8, 7, 'merged'));
  const ambiguous = timeStats(history, { now: NOW, receipts });
  assert.equal(ambiguous.phases.static.totalMs, 0);
  assert.equal(ambiguous.unattributedReceipts, 1);
});

test('weekly and release checkpoints append without replacing earlier history [R1,R2,C7]', t => {
  const root = mkdtempSync(join(tmpdir(), 'time-checkpoints-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  runFixtureGit(['init', '-q'], { cwd: root });
  const ctx = { info: { root, commonDir: join(root, '.git') }, clock: { now: () => new Date(NOW) } };
  const board = { db: { prepare: () => ({ all: () => HISTORY }) } };
  const file = recordTimeCheckpoint(ctx, board, { reason: 'weekly', retainedReceipts, events });
  assert.ok(file);
  assert.equal(recordTimeCheckpoint(ctx, board, { reason: 'weekly', retainedReceipts, events }), null);
  assert.equal(recordTimeCheckpoint(ctx, board, { reason: 'release', label: '0.9.4', retainedReceipts, events }), file);
  assert.equal(recordTimeCheckpoint(ctx, board, { reason: 'weekly', retainedReceipts, events, now: NOW + 7 * 86400000 }), file);
  const rows = readFileSync(file, 'utf8').trim().split('\n').map(line => JSON.parse(line));
  assert.deepEqual(rows.map(row => row.reason), ['weekly', 'release', 'weekly']);
  assert.equal(rows[1].label, '0.9.4');
});

