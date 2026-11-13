// fixture-subject: addItem
/** A shared native session's tokens divide between its items by each item's claimed time [N2]. */
import assert from 'node:assert/strict';
import { join } from 'node:path';
import {
  after,
  test,
} from 'node:test';
import * as store from '../../../../../../packages/store/index.js';
import { openBoard } from '../../../../../lib/index.js';
import {
  itemCost,
  recordSharedUsage,
  recordUsage,
} from '../../../../../../packages/stats/index.js';
import {
  createE2eHelpers,
  FIXTURE_MODEL,
} from '../../../../tests/fixtures/e2e.js';
import { joinFixtureSeat } from '../../../../tests/fixtures/testkit.js';

const helpers = createE2eHelpers();
after(helpers.cleanup);
const HOUR = 60 * 60 * 1_000;
const LEASE = 6 * HOUR;
const SESSION = '00000000-0000-4000-8000-000000000001';

/** Numeric native-shaped totals for one model, as a seat's checkpoint publishes them. */
function totals(input, output, wallMs, reasons = []) {
  return { model: FIXTURE_MODEL, inputTokens: input, outputTokens: output, wallMs, knownInputTokens: input ?? 0, knownOutputTokens: output ?? 0, unknownReasons: reasons };
}

/** Two seats claim two items for the given hours each; one shared session spent 1000 input and 100 output tokens meanwhile. */
function twoSeats(hours, { leases = [], lapsed = [] } = {}) {
  const box = helpers.project('true');
  assert.equal(joinFixtureSeat(box, box.web, 'web', { model: FIXTURE_MODEL }).code, 0);
  const second = join(box.dir, 'split-seat');
  box.git(box.repo, 'worktree', 'add', '-q', '--detach', second, 'HEAD');
  assert.equal(joinFixtureSeat(box, second, 'web', { model: FIXTURE_MODEL }).code, 0);
  const start = Date.now() - 10 * HOUR;
  let instant = start;
  // @pullboard-board-file journey: the fixture board is the real SQLite file the CLI seats share; claim times are set by its clock.
  const board = openBoard(join(box.repo, '.git', 'pullboard', 'board.sqlite'), { now: () => new Date(instant) });
  try {
    const seats = [store.agentAt(board, box.web).agent_id, store.agentAt(board, second).agent_id];
    const main = box.git(box.repo, 'rev-parse', 'HEAD');
    const freeze = () => ({ text: '{"rows":[]}', digest: 'fixture-usage-split' });
    const items = hours.map((_, index) => store.addItem(board, { by: 'coordinator', lane: 'web', title: `Split item ${index + 1}`, specIds: ['G1'],
      criterion: 'a shared session divides by time', check: 'test -f web/ready',
      checkBaseline: { command: 'test -f web/ready', result: 'red', main, seconds: 0 } }));
    items.forEach((id, index) => store.claim(board, id, { agentId: seats[index], lane: 'web', leaseMs: leases[index] ?? LEASE, freeze }));
    for (const [index, id] of items.entries()) {
      if (lapsed.includes(index)) continue; // its claim is left open in the log: the lease ran out, nobody released it
      instant = start + hours[index] * HOUR;
      store.release(board, id, seats[index], 'Close the private usage fixture claim.', 'OTHER');
    }
    const observedAt = start + Math.max(...hours) * HOUR;
    items.forEach((id, index) => recordUsage(board, { agentId: seats[index], item: id, revision: 1, observedAt, shared: true,
      records: [totals(null, null, hours[index] * HOUR, ['shared-session'])] }));
    recordSharedUsage(board, { agentId: seats[0], id: SESSION, seats, allocations: items.map((item, index) => ({ seat: seats[index], item })),
      revision: 1, observedAt, records: [totals(1000, 100, Math.max(...hours) * HOUR)] });
    return { box, items, cost: items.map(id => itemCost(board, id)) };
  } finally { store.closeBoard(board); }
}

test('one session across 1h and 3h of claimed time gives its items 25% and 75% of its tokens, both marked split by time [N2]', async () => {
  const { cost: [a, b] } = twoSeats([1, 3]);
  assert.equal(a.inputTokens, 250);
  assert.equal(b.inputTokens, 750);
  assert.equal(a.outputTokens, 25);
  assert.equal(b.outputTokens, 75);
  assert.equal(a.splitByTime, true);
  assert.equal(b.splitByTime, true);
  assert.equal(a.shared, false, 'the split replaces the unknown shared-session marker');
  assert.equal(a.wallMs, 1 * 60 * 60 * 1_000);
  assert.equal(b.wallMs, 3 * 60 * 60 * 1_000);
  assert.deepEqual(a.unknownReasons, []);
  assert.equal(a.inputTokens + b.inputTokens, 1000, 'the split totals equal the session');
  assert.equal(a.outputTokens + b.outputTokens, 100);
});

test('an odd split still adds back to the session exactly [N2]', async () => {
  const { cost: [a, b] } = twoSeats([1, 2]);
  assert.equal(a.inputTokens + b.inputTokens, 1000);
  assert.equal(a.outputTokens + b.outputTokens, 100);
  assert.ok(a.inputTokens > 0 && b.inputTokens > a.inputTokens, 'the longer claim takes the larger share');
});

test('show prints that a shared session was split by time, not that the split is unknown [N2]', async () => {
  const { box, items } = twoSeats([1, 3]);
  const shown = (await box.runLocal(box.repo, 'show', String(items[0]), '--detail'));
  assert.equal(shown.code, 0, shown.err);
  assert.match(shown.out, /usage: input 250 .*output 25, .*; split by time with a shared session/u);
  assert.doesNotMatch(shown.out, /item split unknown/u);
});

test('a claim whose lease ran out counts only to its lease, not to the session checkpoint [N2]', async () => {
  // Item 1 was claimed for 1h and never released; the session checkpoint is 10h in. Item 2 held 3h.
  const { cost: [a, b] } = twoSeats([10, 3], { leases: [1 * HOUR], lapsed: [0] });
  assert.equal(a.inputTokens, 250, 'the lapsed claim weighs 1h, its lease, against 3h');
  assert.equal(b.inputTokens, 750);
  assert.equal(a.inputTokens + b.inputTokens, 1000, 'the split totals equal the session');
});
