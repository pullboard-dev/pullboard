/** @pullboard-test-input source-cell store */
/** deliverHealthNotices logs a resolved finding without shouting it from HEALTH_QUIET_ENGINE [A6,H16,#1479]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { deliverHealthNotices } from '../../../src/logic/board/receipts.js';
import { healthTargets } from '../../../src/logic/board/receipts.js';
import { healthDigestPlan } from '../../../src/logic/board/receipts.js';
import { HEALTH_QUIET_ENGINE } from '../../../../state/light.js';
import { HEALTH_EPISODE_ENGINE } from '../../../../state/light.js';

const finding = (key) => ({ key, cause: 'STUCK_BUILD', item: 7, subject: '#7', title: 'sits', since: '2026-11-18T00:00:00Z', why: 'no commit', owner: 'core-1', next: 'ask the builder' });

/** Run one delivery with one resolved and one new finding, recording every shout and log. */
function deliver(engine) {
  const shouts = [];
  const logs = [];
  deliverHealthNotices({ resolved: [finding('old')], added: [finding('new')], engine, coordinator: 'coordinator',
    targets: () => ['coordinator'], shout: (to, text) => shouts.push([to, text]), log: (found, cleared) => logs.push([found.key, cleared]) });
  return { shouts, logs };
}

test('store.logic-board-receipts.clause-1-resolved-is-logged-not-shouted: clause 1: from HEALTH_QUIET_ENGINE deliverHealthNotices logs every resolved finding and shouts none of them [A6,H16,#1479]', () => {
  const { shouts, logs } = deliver(HEALTH_QUIET_ENGINE);
  assert.deepEqual(logs, [['old', true], ['new', false]], 'the resolved finding is still recorded');
  assert.equal(shouts.filter(([, text]) => text.startsWith('Resolved')).length, 0, 'no resolved notice is shouted');
  assert.equal(shouts.filter(([, text]) => text.startsWith('Stuck')).length, 1, 'a new finding still shouts');
});

test('store.logic-board-receipts.clause-2-older-engine-still-shouts-resolved: clause 2: below HEALTH_QUIET_ENGINE the same call still shouts each resolved finding as before [A6,H16,#1479]', () => {
  const { shouts, logs } = deliver(HEALTH_QUIET_ENGINE - 1);
  assert.deepEqual(logs, [['old', true], ['new', false]]);
  assert.deepEqual(shouts.map(([, text]) => text.split(':')[0]), ['Resolved', 'Stuck']);
});

const context = (engine) => ({ engine, coordinator: 'coordinator', person: 'corey', lanes: ['core'], agents: [{ agent_id: 'core-1' }] });

test('store.logic-board-receipts.clause-1-only-the-owner-hears: clause 1: from HEALTH_QUIET_ENGINE healthTargets returns only a known owner, and the coordinator only for an unknown owner or a coordinator cause [A6,H16,#1479]', () => {
  const ctx = context(HEALTH_QUIET_ENGINE);
  assert.deepEqual(healthTargets(finding('a'), ctx), ['core-1'], 'a known owner alone hears a stuck build');
  assert.deepEqual(healthTargets({ ...finding('b'), owner: 'ghost-9' }, ctx), ['coordinator'], 'an unknown owner leaves it to the coordinator');
  assert.deepEqual(healthTargets({ ...finding('c'), owner: null }, ctx), ['coordinator'], 'no owner leaves it to the coordinator');
  for (const cause of ['UNLANDED_CONFLICT', 'UNLANDED_WAITING', 'UNLANDED_READY', 'UNLANDED_STACKED', 'DECISION_UNANSWERED', 'REQUEST_UNANSWERED', 'STALE_ROW_DECISION']) {
    assert.deepEqual(healthTargets({ ...finding('d'), cause }, ctx), ['coordinator', 'core-1'], `${cause} still reaches the coordinator`);
  }
});

test('store.logic-board-receipts.clause-2-older-engine-targets-unchanged: clause 2: below HEALTH_QUIET_ENGINE healthTargets still returns the coordinator and the known owner [A6,H16,#1479]', () => {
  assert.deepEqual(healthTargets(finding('a'), context(HEALTH_QUIET_ENGINE - 1)), ['coordinator', 'core-1']);
  assert.deepEqual(healthTargets({ ...finding('b'), owner: 'ghost-9' }, context(HEALTH_QUIET_ENGINE - 1)), ['coordinator']);
});

/** Deliver one added finding at `engine`, with its key resolved `minutes` before now; returns the shouts and logs. */
function deliverFlap(engine, minutes) {
  const now = '2026-11-19T10:00:00.000Z';
  const resolvedAt = new Date(Date.parse(now) - minutes * 60_000).toISOString();
  const shouts = [];
  const logs = [];
  deliverHealthNotices({ resolved: [], added: [finding('flap')], recentlyResolved: new Map([['flap', resolvedAt]]), now, engine, coordinator: 'coordinator',
    targets: () => ['coordinator'], shout: (to, text) => shouts.push([to, text]), log: (found, cleared) => logs.push([found.key, cleared]) });
  return { shouts, logs };
}

test('store.logic-board-receipts.flap-within-30-minutes-is-not-reshouted: clause 1: from HEALTH_EPISODE_ENGINE an added finding that resolved under 30 minutes before now is logged and shouted to no one, shouts after 30 minutes, and below the engine nothing changes [C7,#1479]', () => {
  const quick = deliverFlap(HEALTH_EPISODE_ENGINE, 10);
  assert.deepEqual(quick.shouts, []);
  assert.deepEqual(quick.logs, [['flap', false]]);
  assert.equal(deliverFlap(HEALTH_EPISODE_ENGINE, 30).shouts.length, 1, 'at 30 minutes it shouts as before');
  assert.equal(deliverFlap(HEALTH_EPISODE_ENGINE, 45).shouts.length, 1);
  assert.equal(deliverFlap(HEALTH_EPISODE_ENGINE - 1, 10).shouts.length, 1, 'below the engine the flap rule does not apply');
});

/** A finding for the digest tests, with the cause and subject it needs. */
function digestFinding(key, cause, subject = `item ${key}`) {
  return { ...finding(key), cause, subject };
}

test('store.logic-board-receipts.digest-batches-routine-findings: clause 1: healthDigestPlan sends the five immediate causes at once, buffers every other finding per reader, and after 10 minutes returns one line per reader naming every buffered subject [C7,#1479]', () => {
  const t0 = '2026-11-19T10:00:00.000Z';
  const targets = () => ['coordinator'];
  const immediateCauses = ['UNLANDED_HELD', 'UNLANDED_WAITING', 'UNLANDED_CONFLICT', 'DECISION_UNANSWERED', 'REQUEST_UNANSWERED'];
  const first = healthDigestPlan({
    added: [...immediateCauses.map((cause, i) => digestFinding(`i${i}`, cause)), digestFinding('r1', 'IDLE_AGENT', 'seat-a'), digestFinding('r2', 'STALE_CLAIM', 'seat-b')],
    resolved: [], buffered: {}, lastFlush: { coordinator: t0 }, now: t0, targets });
  assert.deepEqual(first.immediate.map(([to, found]) => [to, found.key]), immediateCauses.map((_, i) => ['coordinator', `i${i}`]));
  assert.deepEqual(first.buffered.coordinator.map(entry => entry.subject), ['seat-a', 'seat-b']);
  assert.deepEqual(first.lines, [], 'inside the window nothing is flushed');
  const early = healthDigestPlan({ added: [], resolved: [], buffered: first.buffered, lastFlush: first.lastFlush, now: '2026-11-19T10:09:59.000Z', targets });
  assert.deepEqual(early.lines, []);
  const later = healthDigestPlan({ added: [], resolved: [], buffered: first.buffered, lastFlush: first.lastFlush, now: '2026-11-19T10:10:00.000Z', targets });
  assert.equal(later.lines.length, 1);
  assert.equal(later.lines[0][0], 'coordinator');
  assert.match(later.lines[0][1], /seat-a, seat-b/u);
  assert.deepEqual(later.buffered, {});
  assert.equal(later.lastFlush.coordinator, '2026-11-19T10:10:00.000Z');
});

test('store.logic-board-receipts.digest-drops-resolved-buffered: clause 2: a buffered finding whose key resolves before its window flushes is dropped and never named in a flush line [C7,#1479]', () => {
  const t0 = '2026-11-19T10:00:00.000Z';
  const buffered = { coordinator: [{ key: 'r1', subject: 'seat-a' }, { key: 'r2', subject: 'seat-b' }] };
  const plan = healthDigestPlan({ added: [], resolved: [digestFinding('r1', 'IDLE_AGENT')], buffered, lastFlush: { coordinator: t0 }, now: '2026-11-19T10:11:00.000Z', targets: () => ['coordinator'] });
  assert.equal(plan.lines.length, 1);
  assert.match(plan.lines[0][1], /seat-b/u);
  assert.doesNotMatch(plan.lines[0][1], /seat-a/u);
  const all = healthDigestPlan({ added: [], resolved: [digestFinding('r2', 'IDLE_AGENT')], buffered: plan.buffered, lastFlush: plan.lastFlush, now: '2026-11-19T10:30:00.000Z', targets: () => ['coordinator'] });
  assert.deepEqual(all.lines, []);
});

/** A builder-owned and a coordinator-owned finding, each carrying the owner role the scan keeps when adviceThroughNext is on. */
const advised = (key, ownerRole, owner) => ({ ...finding(key), owner, ownerRole });

/** Deliver both findings at HEALTH_QUIET_ENGINE, with every target the coordinator and the owner, recording each shout and log. */
function deliverAdvised(options) {
  const shouts = [];
  const logs = [];
  deliverHealthNotices({ resolved: [], added: [advised('builder-owned', 'builder', 'core-1'), advised('coordinator-owned', 'coordinator', 'coordinator')], engine: HEALTH_QUIET_ENGINE,
    coordinator: 'coordinator', targets: found => [...new Set(['coordinator', found.owner])], shout: (to, text) => shouts.push([to, text]), log: (found, cleared) => logs.push([found.key, cleared]), ...options });
  return { shouts, logs };
}

test('store.logic-board-receipts.builder-advice-not-shouted: clause 1: with adviceThroughNext true deliverHealthNotices logs every finding but shouts none for a builder-owned one, and coordinator-owned findings shout as before [C7,#11705]', () => {
  const { shouts, logs } = deliverAdvised({ adviceThroughNext: true });
  assert.deepEqual(logs, [['builder-owned', false], ['coordinator-owned', false]], 'both findings are recorded');
  assert.equal(shouts.some(([, text]) => text.includes('Owner: core-1')), false, 'the builder-owned finding is shouted to no one');
  assert.deepEqual(shouts.map(([to]) => to), ['coordinator'], 'the coordinator-owned finding is shouted to the coordinator once');
});

test('store.logic-board-receipts.builder-advice-replay: clause 2: with adviceThroughNext false or absent, and for a finding recorded without an owner role, the shouts are exactly those of main [C7,#11705]', () => {
  const main = deliverAdvised({});
  assert.deepEqual(main.shouts.map(([to]) => to), ['coordinator', 'core-1', 'coordinator'], 'absent: the builder-owned finding shouts to the coordinator and the builder');
  assert.deepEqual(deliverAdvised({ adviceThroughNext: false }).shouts, main.shouts, 'false is the same as absent');
  const recorded = [];
  deliverHealthNotices({ resolved: [], added: [finding('older')], engine: HEALTH_QUIET_ENGINE, coordinator: 'coordinator', adviceThroughNext: true,
    targets: found => ['coordinator', found.owner], shout: (to) => recorded.push(to), log: () => {} });
  assert.deepEqual(recorded, ['coordinator', 'core-1'], 'a finding recorded before this change carries no owner role and shouts as it did');
});
