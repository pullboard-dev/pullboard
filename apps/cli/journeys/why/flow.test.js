/** pullboard why names one cause per unlanded item and every idle seat [N26,C7]. */
import assert from 'node:assert/strict';
import { after } from 'node:test';
import { test } from 'node:test';
import { flowWhy } from '../../../../packages/health/index.js';
import { createE2eHelpers } from '../../tests/fixtures/e2e.js';
import { fileFixtureItem } from '../../tests/fixtures/testkit.js';

const e2e = createE2eHelpers();
after(e2e.cleanup);

const NOW = Date.parse('2026-11-12T12:00:00Z');
const MIN = 60_000;

/** A board reader port with one item per cause, one idle seat and two recent landings. */
function ports(extra = {}) {
  const item = (id, status, more = {}) => ({ item_id: id, item_title: `T${id}`, item_lane: 'core', item_status: status, ...more });
  const items = [
    item(1, 'verified'), item(2, 'submitted'), item(3, 'submitted'), item(4, 'claimed'), item(5, 'open', { item_hold_reason: 'External prerequisite' }),
    item(6, 'open'), item(7, 'open'), item(8, 'submitted', { item_merged_commit: 'abc' }), item(9, 'open', { item_status: 'withdrawn' }),
  ];
  const progress = new Map([[3, { holder: 'rev-1' }], [4, { holder: 'build-1', idleMinutes: 7, idleBasis: 'commit' }], [6, { waits: ['#4', 'file clash'] }]]);
  const store = {
    milestones: () => [{ name: 'R', shipped: false, items: [1, 2, 3, 4, 5, 6, 7, 8, 9] }],
    lineSettings: () => ({}),
    listItems: () => items,
    listAgents: () => [{ agent_id: 'build-1', agent_lane: 'core', presence: 'live' }, { agent_id: 'rev-1', agent_lane: 'core', presence: 'live' },
      { agent_id: 'idle-1', agent_lane: 'core', presence: 'live' }, { agent_id: 'gone-1', agent_lane: 'core', presence: 'gone' }],
    landingBatches: () => [{ id: 'batch-1', state: 'testing', startedAt: new Date(NOW - 25 * MIN).toISOString(), items: [{ id: 1 }] }],
    laneHold: () => null,
    nextFor: () => ({ item: null, reasons: ['no open work in lane core'] }),
    ...extra,
  };
  return {
    store, now: () => NOW,
    workProgress: () => progress,
    reviewEligibility: () => ({ eligible: ['rev-2', 'idle-1'], ineligible: [{ agent: 'build-1', rule: 'built it' }] }),
    merged: () => [{ item_id: 8, event_at: new Date(NOW - 20 * MIN).toISOString() }, { item_id: 9, event_at: new Date(NOW - 90 * MIN).toISOString() }],
  };
}

test('pullboard why names one cause per unlanded item and every idle seat [N26,C7]', () => {
  const result = flowWhy({}, ports());
  assert.equal(result.release, 'R');
  assert.deepEqual(result.items.map(row => row.id), [1, 2, 3, 4, 5, 6, 7]);
  const cause = id => result.items.find(row => row.id === id);
  assert.deepEqual([cause(1).cause, cause(1).batch, cause(1).minutes], ['landing', 'batch-1', 25]);
  assert.deepEqual([cause(2).cause, cause(2).eligible], ['review', ['idle-1']]);
  assert.deepEqual([cause(3).cause, cause(3).seat], ['reviewing', 'rev-1']);
  assert.deepEqual([cause(4).cause, cause(4).seat, cause(4).minutes], ['building', 'build-1', 7]);
  assert.deepEqual([cause(5).cause, cause(5).reason], ['held', 'External prerequisite']);
  assert.deepEqual([cause(6).cause, cause(6).waits], ['waiting', ['#4']]);
  assert.equal(cause(7).cause, 'free');
  assert.ok(result.items.every(row => typeof row.cause === 'string'));
});

test('a review with no live eligible reviewer says why, and a lane hold reads as held [N26,C7]', () => {
  const base = ports({ laneHold: (_board, lane) => (lane === 'core' ? { hold_reason: 'core lane paused' } : null) });
  const none = flowWhy({}, { ...base, reviewEligibility: () => ({ eligible: ['gone-1'], ineligible: [{ agent: 'build-1', rule: 'built it' }] }) });
  const review = none.items.find(row => row.id === 2);
  assert.deepEqual([review.cause, review.eligible], ['held', undefined]);
  assert.equal(review.reason, 'core lane paused');
  const open = flowWhy({}, { ...ports(), reviewEligibility: () => ({ eligible: ['gone-1'], ineligible: [{ agent: 'build-1', rule: 'built it' }] }) });
  const waiting = open.items.find(row => row.id === 2);
  assert.deepEqual([waiting.cause, waiting.eligible, waiting.reason], ['review', [], 'build-1: built it']);
});

test('every live seat with nothing to do is listed with why, with landings in the last one and two hours [N26,C7]', () => {
  const result = flowWhy({}, ports());
  assert.deepEqual(result.idle.map(row => row.seat), ['idle-1']);
  assert.equal(result.idle[0].reason, 'nothing eligible');
  assert.deepEqual(result.idle[0].detail, ['no open work in lane core', 'no open work in lane core']);
  const busy = flowWhy({}, ports({ nextFor: () => ({ item: { item_id: 7 } }) }));
  assert.deepEqual([busy.idle[0].reason, busy.idle[0].item], ['work available', 7]);
  assert.deepEqual(result.landings, { lastHour: 1, lastTwoHours: 2 });
  assert.equal(result.asOf, new Date(NOW).toISOString());
});

test('a release that does not exist is refused with the next step [N26,C7]', () => {
  assert.throws(() => flowWhy({}, { ...ports(), release: 'Nope' }), error => error.code === 'NO_MILESTONE' && /roadmap/u.test(error.message));
});

/** A project with a release of two open items, one of which waits on the other. */
async function released() {
  const box = e2e.project('true');
  const file = (title, args = []) => fileFixtureItem(box, box.repo, { lane: 'web', title, criterion: 'the page renders', check: 'true', args: ['--specs', 'G1', ...args] }).item_id;
  const first = file('First page');
  const second = file('Second page', ['--after', String(first)]);
  const added = await box.runLocal(box.repo, 'milestone', 'add', 'Delivery', '--reason', 'Arrange fixture release', '--items', `${first},${second}`);
  assert.equal(added.code, 0, `${added.out}\n${added.err}`);
  return { box, first, second };
}

test('why prints the release flow on one screen: a line per unlanded item, and --json carries a version [N26,C7]', async () => {
  const { box, first, second } = await released();
  const text = await box.runLocal(box.repo, 'why');
  assert.equal(text.code, 0, `${text.out}\n${text.err}`);
  const lines = text.out.trim().split('\n').filter(line => !line.startsWith('next:'));
  assert.match(lines[0], /^release Delivery as of \d{4}-/u);
  assert.match(lines.find(line => line.startsWith(`#${first} `)), /free/u);
  assert.match(lines.find(line => line.startsWith(`#${second} `)), /waiting {2}#\d+/u);
  assert.ok(lines.some(line => line.startsWith('landed: 0 in the last hour')));
  assert.ok(lines.length < 25, 'one screen');
  const named = await box.runLocal(box.repo, 'why', 'Delivery', '--json');
  const json = JSON.parse(named.out);
  assert.equal(json.version, 1);
  assert.equal(json.release, 'Delivery');
  assert.deepEqual(json.items.map(row => [row.id, row.cause]).sort((a, b) => a[0] - b[0]), [[first, 'free'], [second, 'waiting']]);
  assert.ok(Array.isArray(json.idle) && json.landings.lastHour === 0);
});

test('why <id> and why <file> keep their output [N26,C7]', async () => {
  const { box, first } = await released();
  const byId = await box.runLocal(box.repo, 'why', String(first), '--json');
  assert.deepEqual(Object.keys(JSON.parse(byId.out)).sort(), ['decisions', 'id', 'version']);
  const byFile = await box.runLocal(box.repo, 'why', 'web/none.txt', '--json');
  assert.deepEqual(Object.keys(JSON.parse(byFile.out)).sort(), ['decisions', 'file', 'items', 'line', 'rows', 'version']);
  const refused = await box.runLocal(box.repo, 'why', 'a', 'b');
  assert.notEqual(refused.code, 0);
});
