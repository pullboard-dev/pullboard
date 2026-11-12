/** @pullboard-test-loads apps/cli/src/logic/purpose.js apps/cli/src/io/commands/shout.js */
/** A shout that only restates a submit or verdict the board recorded is refused, naming the event [C7]. */
import assert from 'node:assert/strict';
import {
  after,
  test,
} from 'node:test';
import { join } from 'node:path';
import { createE2eHelpers } from '../../tests/fixtures/e2e.js';
import * as store from '../../../../packages/store/index.js';
import { openBoard } from '../../../lib/index.js';
import { refuseRestatedReport } from '../../src/logic/purpose.js';
import { fixtureAdd } from '../../tests/fixtures/testkit.js';

const fixtures = createE2eHelpers();
after(fixtures.cleanup);

/** Record one event by web-1 on item 1 at the given time, in the fixture's persisted board. */
function record(box, kind, at) {
  // @pullboard-board-file persistence: the real CLI processes that follow must read this exact event row
  const board = openBoard(join(box.repo, '.git/pullboard/board.sqlite'));
  try { store.logEvent(board, 'web-1', kind, 1, {}, at); } finally { store.closeBoard(board); }
}

/** Count the shouts to the coordinator in the fixture. */
async function shouts(box) {
  return JSON.parse((await box.runIn(box.repo, 'export', '--json')).out).tables.shout.length;
}

test('[C7] a report shout right after the same agent verdict is refused naming the event; questions and old reports are delivered', async () => {
  const box = fixtures.project('true');
  assert.equal((await fixtureAdd(box.runIn, box.repo, 'web', 'Reported item', '--specs', 'G1', '--criterion', 'works', '--check', 'true')).code, 0);

  const quiet = await box.runIn(box.web, 'shout', 'coordinator', 'Item #1 is done', '--kind', 'idea', '--json');
  assert.equal(quiet.code, 0, 'a report with no recent event is delivered');

  record(box, 'accept', new Date());
  const before = await shouts(box);
  for (const kind of ['idea', 'exception']) {
    const refused = await box.runIn(box.web, 'shout', 'coordinator', 'Accepted #1 with a clean check', '--kind', kind, '--json');
    assert.equal(refused.code, 1, refused.out);
    const error = JSON.parse(refused.out).error;
    assert.equal(error.code, 'REPORT_RESTATES_EVENT');
    assert.match(error.message, /#1 already records your accept \(event \d+ at /, 'the refusal names the recorded event');
    assert.match(error.message, /pullboard show 1/);
  }
  const viaItem = await box.runIn(box.web, 'shout', '--item', '1', 'Accepted it', '--kind', 'idea', '--json');
  assert.equal(viaItem.code, 1, 'naming the item with --item is the same report');
  assert.equal(await shouts(box), before, 'refusals record no shout');

  // A bare '#1 blocked on the runner' only restates the board (BOARD_SHOWS_THIS, 3d6a7169b3); a blocker names its cause.
  for (const args of [['Should #1 land now?', '--kind', 'question'], ['#1 blocked on the runner because its gate failed to start', '--kind', 'blocker'], ]) {
    const sent = await box.runIn(box.web, 'shout', 'coordinator', ...args, '--json');
    assert.equal(sent.code, 0, `${args.join(' ')}: ${sent.out}`);
  }
  assert.equal(await shouts(box), before + 2, 'questions and blockers are delivered after an accept');

  const unrelated = await box.runIn(box.web, 'shout', 'coordinator', 'An unrelated idea about review receipts', '--kind', 'idea', '--json');
  assert.equal(unrelated.code, 0, 'a shout naming no item with a recent event is delivered');
});

test('[C7] the refusal covers only the sender, only the last ten minutes and only submit, accept and reject events', () => {
  const board = openBoard(':memory:');
  try {
    store.register(board, { lane: 'coordinator', path: '/repo' });
    store.register(board, { lane: 'web', path: '/repo-web' });
    const id = store.addItem(board, { by: 'coordinator', lane: 'web', title: 'Item', criterion: 'works' });
    const now = Date.parse('2026-10-28T20:00:00.000Z');
    const shout = { from: 'web-1', to: 'coordinator', kind: 'idea', text: `reported #${id}` };
    store.logEvent(board, 'web-1', 'reject', id, {}, new Date(now - 11 * 60_000));
    assert.doesNotThrow(() => refuseRestatedReport(board, shout, now), 'an event older than ten minutes is not restated');
    store.logEvent(board, 'web-1', 'submit', id, {}, new Date(now - 9 * 60_000));
    assert.throws(() => refuseRestatedReport(board, shout, now), { code: 'REPORT_RESTATES_EVENT' });
    assert.doesNotThrow(() => refuseRestatedReport(board, { ...shout, from: 'web-2' }, now), 'another agent restates nothing of its own');
    for (const kind of ['question', 'blocker', 'decision']) assert.doesNotThrow(() => refuseRestatedReport(board, { ...shout, kind }, now), `a ${kind} after a submit is delivered`);
    assert.doesNotThrow(() => refuseRestatedReport(board, { ...shout, kind: 'idea', decision: true }, now), 'a decision request is delivered');
    assert.doesNotThrow(() => refuseRestatedReport(board, { ...shout, to: 'api' }, now), 'only coordinator shouts are covered');
    assert.doesNotThrow(() => refuseRestatedReport(board, { ...shout, from: 'person' }, now), 'the person is exempt');
  } finally { store.closeBoard(board); }
});


test('[C7,B22] validated integration purposes pass while plain reports and unbound receipts still refuse', async () => {
  const box = fixtures.project('true');
  assert.equal((await fixtureAdd(box.runIn, box.repo, 'web', 'Integration item', '--specs', 'G1', '--criterion', 'works')).code, 0);
  record(box, 'submit', new Date());
  const commit = box.git(box.repo, 'rev-parse', 'HEAD');
  /** Drive the real evidence parser, guard and persisted item message with a genuine Git object. */
  const send = (kind, outcome, rev = commit) => box.runIn(box.web, 'shout', '--item', '1', 'Integration state for #1',
    '--evidence', kind, '--outcome', outcome, '--commit', rev, '--json');
  /** A refused integration label cannot turn a redundant report into a persisted message. */
  const refuses = (result, code) => {
    assert.equal(result.code, 1, result.out);
    assert.equal(JSON.parse(result.out).error.code, code, result.out);
  };
  const before = await shouts(box);
  refuses(await send('receipt', 'done'), 'REPORT_RESTATES_EVENT');
  refuses(await send('attempt', 'measured'), 'REPORT_RESTATES_EVENT');
  refuses(await send('unknown', 'integrating'), 'BAD_EVIDENCE');
  refuses(await send('attempt', 'integrating', 'missing-integration-commit'), 'BAD_EVIDENCE');
  assert.equal(await shouts(box), before, 'invalid or irrelevant metadata bypasses no refusal');
  const attempt = await send('attempt', 'integrating');
  assert.equal(attempt.code, 0, attempt.out);
  const plain = await box.runIn(box.web, 'shout', '--item', '1', 'Submitted #1', '--kind', 'idea', '--json');
  refuses(plain, 'REPORT_RESTATES_EVENT');
  const receipt = await send('receipt', 'superseded');
  assert.equal(receipt.code, 0, receipt.out);
  refuses(await send('receipt', 'done'), 'REPORT_RESTATES_EVENT');
  assert.equal(await shouts(box), before + 2, 'only the real attempt and its closing receipt are recorded');
});
