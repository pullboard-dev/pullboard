/** Activity delivery separates interrupts from digests, budgets the rendered inbox, and names the coordinator call-outs still open [R2,N26,H16,N2,C7]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { cellBoard } from '../../../board/tests/fixtures/cell-board.js';
import { cellItem } from '../../../store/tests/fixtures/cell.js';
import { cellRepo } from '../../../store/tests/fixtures/cell.js';
import { cellSeat } from '../../../store/tests/fixtures/cell.js';
import { board_ensureCoordinator } from '../../../store/index.js';
import { shout } from '../../../store/index.js';
import { CALLOUT_AGE_MS } from '../../index.js';
import { CLAIM_INTERRUPT_WINDOW_MS } from '../../index.js';
import { actionableCallout } from '../../index.js';
import { budgetInbox } from '../../index.js';
import { calloutLine } from '../../index.js';
import { classifyActivityDelivery } from '../../index.js';
import { coordinatorCalloutLine } from '../../index.js';
import { openCallouts } from '../../index.js';
import { readActivityCursor } from '../../index.js';
import { saveActivityCursor } from '../../index.js';
import { takeWaitShouts } from '../../index.js';

const AT = '2026-11-09T12:00:00.000Z';
const NOW = Date.parse(AT);
const delivery = (over = {}) => classifyActivityDelivery({ agentId: 'core-1', items: [], shouts: [], at: AT, activity: { entries: [], digests: [], cursor: 7 }, ...over });

test('activity.delivery.interrupt-own-work: delivery interrupts for what happened to this seat\'s own work and counts the rest [R2,N26]', () => {
  const entries = [
    { eventId: 1, kind: 'reject', recipient: 'core-1' },
    { eventId: 2, kind: 'reject', recipient: 'core-2' },
    { eventId: 3, kind: 'stalled', recipient: 'core-1' },
    { eventId: 4, kind: 'unblocked', recipient: 'core-1' },
    { eventId: 5, kind: 'main-moved', files: ['a.js'] },
    { eventId: 6, kind: 'main-moved', files: [] },
    { eventId: 7, kind: 'main-moved', files: [], unknownFiles: true },
    { eventId: 8, kind: 'submit' },
    { eventId: 9, kind: 'submit' },
  ];
  const result = delivery({ activity: { entries, digests: [{ kind: 'landed', count: 3 }], cursor: 9 } });
  assert.deepEqual(result.interrupts.map(entry => [entry.id, entry.reason]),
    [['event:1', 'rejected'], ['event:3', 'stalled'], ['event:4', 'unblocked'], ['event:5', 'files-changed'], ['event:7', 'files-changed']]);
  assert.deepEqual(result.entries, []);
  assert.deepEqual(result.digests.map(digest => digest.text), [
    '1 main-moved activity; details remain on the board',
    '1 reject activity; details remain on the board',
    '2 submit activities; details remain on the board',
    '3 landed updates; details remain on the board',
  ], 'counts sort by kind, then the board\'s own digests follow');
  assert.equal(result.cursor, 9);
});

test('activity.delivery.decision-answer-interrupts: an answer to this seat\'s decision interrupts, and shouts and typed requests stay direct [R2,N26]', () => {
  const shouts = [
    { shout_id: 10, shout_from: 'core-1', shout_decision: 1, shout_answers: null },
    { shout_id: 11, shout_answers: 10 },
    { shout_id: 12, shout_from: 'core-2', shout_decision: 1, shout_answers: null },
    { shout_id: 13, shout_answers: 12 },
  ];
  const entries = [{ eventId: 20, kind: 'answer', shout: 11 }, { eventId: 21, kind: 'answer', shout: 13 }, { eventId: 22, kind: 'shout', shout: 14 }, { eventId: 23, kind: 'request', typedRequest: 5 }, { eventId: 24, kind: 'mystery', unknown: true }];
  const result = delivery({ shouts, activity: { entries, digests: [], cursor: 24 } });
  assert.deepEqual(result.interrupts.map(entry => [entry.id, entry.reason]), [['event:20', 'answered']]);
  assert.deepEqual(result.entries.map(entry => entry.eventId), [21, 22, 23, 24], 'an answer to someone else\'s decision stays a direct entry');
});

test('activity.delivery.lease-ending-interrupts: a claim whose lease ends within five minutes interrupts, and a distant, foreign or unclaimed one does not [R2]', () => {
  const lease = ms => new Date(NOW + ms).toISOString();
  const item = (id, over) => ({ item_id: id, item_status: 'claimed', item_owner: 'core-1', item_lease_until: lease(60_000), ...over });
  const result = delivery({ items: [
    item(1, {}),
    item(2, { item_lease_until: lease(-1000) }),
    item(3, { item_lease_until: lease(CLAIM_INTERRUPT_WINDOW_MS) }),
    item(4, { item_lease_until: lease(CLAIM_INTERRUPT_WINDOW_MS + 1) }),
    item(5, { item_owner: 'core-2' }),
    item(6, { item_status: 'open' }),
    item(7, { item_lease_until: 'never' }),
  ] });
  assert.deepEqual(result.interrupts.map(entry => [entry.item, entry.reason, entry.text]), [
    [1, 'claim-lapsing', '#1 claim is lapsing; renew or release it'],
    [2, 'claim-lapsing', '#2 claim has lapsed; renew or release it'],
    [3, 'claim-lapsing', '#3 claim is lapsing; renew or release it'],
  ]);
  assert.equal(result.interrupts[0].id, `claim:1:${lease(60_000)}`, 'an episode is tied to its exact lease');
});

/** The rendered size the budget measures: the public document as JSON, or its rendered lines, whichever is longer. */
const measure = (document, lines) => {
  const { agents, ...publicDocument } = document;
  return Math.max(Buffer.byteLength(JSON.stringify({ version: 1, ...publicDocument }, null, 2) + '\n'), Buffer.byteLength(lines(document).join('\n') + '\n'));
};
const inboxDocument = () => ({
  shouts: [{ shout_id: 1, shout_text: 'x'.repeat(300) }, { shout_id: 2, shout_text: 'y'.repeat(300) }],
  activity: {
    interrupts: [{ id: 'event:1', reason: 'rejected', text: 'rejected' }],
    entries: [{ shout: 1, kind: 'shout' }, { shout: 2, kind: 'shout' }, { kind: 'submit', text: 'a submit' }],
    digests: [{ kind: 'landed', count: 4, text: '4 landed updates' }],
    cursor: 5,
  },
});
const renderLines = document => [...document.shouts.map(entry => entry.shout_text), ...document.activity.interrupts.map(entry => entry.text)];

test('activity.delivery.budget-big-keeps-all: a budget big enough keeps everything, and one too small keeps nothing and names what it withheld [R2,N26,H16]', () => {
  const whole = budgetInbox(inboxDocument(), 1_000_000, renderLines);
  assert.deepEqual([whole.shouts.length, whole.activity.interrupts.length, whole.activity.entries.length, whole.activity.digests.length], [2, 1, 3, 1]);
  assert.equal(whole.budget.summary, '');
  assert.deepEqual(whole.budget.omitted, { interrupt: 0, shout: 0, activity: 0, digest: 0 });

  const none = budgetInbox(inboxDocument(), 1, renderLines);
  assert.deepEqual([none.shouts, none.activity.interrupts, none.activity.entries, none.activity.digests], [[], [], [], []]);
  assert.deepEqual(none.budget.omitted, { interrupt: 1, shout: 2, activity: 1, digest: 4 });
  assert.equal(none.budget.summary, 'Summarized: 1 interrupt, 2 shout, 1 activity, 4 digest; read item history or log for details. Increase inbox.tokenBudget to deliver withheld interrupts.');
  assert.equal(none.activity.cursor, 5, 'the cursor survives the budget');
  assert.equal(none.budget.limit, 1);
});

test('activity.delivery.budget-middling-whole-groups: a middling budget keeps whole groups within its byte limit and never splits a shout\'s text [R2,N26,H16]', () => {
  const limit = measure(budgetInbox(inboxDocument(), 1_000_000, renderLines), renderLines) - 200;
  const trimmed = budgetInbox(inboxDocument(), limit, renderLines);
  const total = trimmed.shouts.length + trimmed.activity.interrupts.length + trimmed.activity.entries.length + trimmed.activity.digests.length;
  assert.ok(total > 0 && total < 7, 'some groups kept and some withheld');
  assert.ok(trimmed.budget.summary.startsWith('Summarized: '));
  for (const kept of trimmed.shouts) assert.ok([`${'x'.repeat(300)}`, `${'y'.repeat(300)}`].includes(kept.shout_text));
});

test('activity.callouts.coordinator-actions-only: only the coordinator actions count as call-outs, and the subject of one is the first item it names [N2,C7]', () => {
  for (const text of ['Sentinel: #3 needs a sharper bar', 'Queued gate for #4 is dead', '#5 has two send-backs at strong', 'Stuck: decision #6 unanswered for 2 h', 'A Decision Request from core-1']) {
    assert.equal(actionableCallout(text), true, text);
  }
  for (const text of ['Resolved: #3 needs a sharper bar', 'takeover notice', 'released claim on #4', '', undefined]) assert.equal(actionableCallout(text), false, String(text));
});

test('activity.callouts.open-until-answered: a call-out stays open until it is answered, its item changed or its item moved on [N2,C7]', () => {
  const at = '2026-11-09T11:00:00.000Z';
  const callouts = [{ id: 1, at, text: 'Stuck: decision #3 unanswered' }, { id: 2, at, text: 'Stuck: decision #4 unanswered' }, { id: 3, at, text: 'Stuck: decision #5 unanswered' }, { id: 4, at, text: 'a decision request with no item' }, { id: 5, at, text: 'Stuck: decision #6 unanswered' }];
  const open = openCallouts(callouts, new Set([5]), item => item === 4, item => item !== 5);
  assert.deepEqual(open.map(callout => [callout.id, callout.item]), [[1, 3], [4, null]]);
});

test('activity.callouts.line-after-fifteen-minutes: the call-out line speaks only once the oldest is past fifteen minutes, in the singular or plural, naming who to tell [N2,C7]', () => {
  const at = ms => ({ at: new Date(NOW - ms).toISOString() });
  assert.equal(calloutLine([], NOW, true), null);
  assert.equal(calloutLine([at(CALLOUT_AGE_MS)], NOW, true), null, 'exactly fifteen minutes is not past it');
  assert.equal(calloutLine([at(CALLOUT_AGE_MS + 60_000)], NOW, true),
    '1 unanswered call-out to the coordinator, oldest 16 min; the coordinator runs pullboard inbox to see it; tell whoever runs the coordinator');
  assert.equal(calloutLine([at(130 * 60_000), at(60_000)], NOW, false),
    '2 unanswered call-outs to the coordinator, oldest 2 h 10 min; the coordinator runs pullboard inbox to see them; tell the person who owns this board');
});

test('activity.callouts.board-line-count: the board\'s call-out line counts the unanswered actionable shouts to the coordinator about items still open [N2,C7]', t => {
  const repo = cellRepo(t);
  const now = new Date('2026-11-09T10:00:00.000Z');
  const board = cellBoard(t, repo.boardFile, { now: () => now });
  const seat = cellSeat(board, { lane: 'web', path: `${repo.root}/seat` });
  board_ensureCoordinator(board, `${repo.root}/coordinator`);
  const open = cellItem(board, { lane: 'web', title: 'Still open' });
  const lanes = ['web', 'api'];
  shout(board, { from: seat.id, to: 'coordinator', text: `Stuck: decision #${open.item_id} unanswered for an hour`, lanes });
  shout(board, { from: seat.id, to: 'coordinator', text: 'just a note for you', lanes });
  assert.equal(coordinatorCalloutLine(board, now.getTime() + 5 * 60_000), null, 'too young to speak up');
  const line = coordinatorCalloutLine(board, now.getTime() + 30 * 60_000);
  assert.match(line, /^1 unanswered call-out to the coordinator, oldest 30 min; the coordinator runs pullboard inbox to see it; tell whoever runs the coordinator$/u);
});

test('activity.delivery.next-wait-hears-shouts-once: a seat idling in next --wait hears each unread shout once and is told the open item it is asked to act on [B3,N2]', t => {
  const repo = cellRepo(t);
  const board = cellBoard(t, repo.boardFile);
  const asked = cellSeat(board, { lane: 'web', path: `${repo.root}/a` });
  const sender = cellSeat(board, { lane: 'api', path: `${repo.root}/b` });
  const item = cellItem(board, { lane: 'web', title: 'Build the page' });
  const lanes = ['web', 'api'];
  shout(board, { from: sender.id, to: asked.id, text: `please build #${item.item_id} next`, lanes });
  shout(board, { from: sender.id, to: asked.id, text: 'and thanks for the earlier work', lanes });
  const ports = { withBoard: (_ctx, work) => work(board), withBoardRead: (_ctx, work) => work(board), whoAmI: () => ({ id: asked.id }) };
  const seen = new Set();
  const first = takeWaitShouts({}, seen, ports);
  assert.deepEqual(first.lines.filter(line => line.startsWith(`${sender.id} ->`)), [`${sender.id} -> ${asked.id}: please build #${item.item_id} next`, `${sender.id} -> ${asked.id}: and thanks for the earlier work`]);
  assert.equal(first.item.item_id, item.item_id);
  assert.equal(seen.size, first.lines.length);
  assert.deepEqual(takeWaitShouts({}, seen, ports), { lines: [], item: null }, 'nothing is read twice');
});

test('activity.delivery.cursor-replay: the activity cursor replays from the start until saved, and a cursor saved for another agent or board is not trusted [R2,N26]', t => {
  const repo = cellRepo(t);
  const fresh = readActivityCursor(repo.root, 'core-1', 'board-a');
  assert.deepEqual([fresh.after, fresh.newsAfter, fresh.sessionStart], [0, 0, true]);
  assert.equal(saveActivityCursor(fresh, 42), true);
  const same = readActivityCursor(repo.root, 'core-1', 'board-a');
  assert.deepEqual([same.after, same.newsAfter, same.sessionStart], [42, 42, false]);
  assert.deepEqual([readActivityCursor(repo.root, 'core-2', 'board-a').after, readActivityCursor(repo.root, 'core-1', 'board-b').after], [0, 0]);
  assert.equal(saveActivityCursor({ ...same, file: `${repo.root}/missing/dir/cursor.json` }, 50), false, 'a failed save reports it and keeps replay available');
  assert.equal(readActivityCursor(repo.root, 'core-1', 'board-a').after, 42);
});
