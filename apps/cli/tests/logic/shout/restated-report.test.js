/** @pullboard-test-input source-cell apps/cli packages/kernel packages/store */
/** A coordinator shout that only restates a submit or verdict the board recorded is refused naming the event; integration evidence is validated [C7,B22]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { resolve } from 'node:path';
import * as store from '../../../../../packages/store/index.js';
import { boardFixture } from '../../fixtures/next/order.js';
import { evidenceFrom } from '../../../src/io/shout.js';
import { refuseRestatedReport } from '../../../src/logic/purpose.js';

const NOW = Date.parse('2026-10-28T20:00:00.000Z');
const COMMIT = 'a'.repeat(40);

/** An in-memory board with a coordinator, a web lane and item 1, and its one helper; closed after the body. */
function withBoard(body) {
  const { board } = boardFixture();
  try {
    const id = store.addItem(board, { by: 'coordinator', lane: 'core', title: 'Item', criterion: 'works' }); // fixture-subject: addItem
    const at = (minutes) => new Date(NOW - minutes * 60_000);
    body({ board, id, at });
  } finally { store.closeBoard(board); }
}

/** The refusal a shout draws, or undefined when it is delivered. */
function outcome(board, shout) {
  try { refuseRestatedReport(board, shout, NOW); } catch (error) { return error; }
  return undefined;
}

test('cli.logic-shout-restated-report.c7-a-report-right-after-the-same: clause 1: [C7] a report right after the same agent accept is refused naming the event, by text or by --item; questions, blockers and old reports are delivered', () => {
  withBoard(({ board, id, at }) => {
    const report = { from: 'web-1', to: 'coordinator', kind: 'idea', text: `Item #${id} is done` };
    assert.equal(outcome(board, report), undefined, 'a report with no recent event is delivered');
    store.logEvent(board, 'web-1', 'accept', id, {}, at(1));
    for (const kind of ['idea', 'exception']) {
      const refused = outcome(board, { ...report, kind, text: `Accepted #${id} with a clean check` });
      assert.equal(refused.code, 'REPORT_RESTATES_EVENT');
      assert.match(refused.message, /#1 already records your accept \(event \d+ at /u, 'the refusal names the recorded event');
      assert.match(refused.message, /pullboard show 1/u);
    }
    assert.equal(outcome(board, { ...report, text: 'Accepted it', item: String(id) }).code, 'REPORT_RESTATES_EVENT', '--item names the item as the text does');
    for (const [kind, text] of [['question', `Should #${id} land now?`], ['blocker', `#${id} blocked on the runner because its gate failed to start`]])
      assert.equal(outcome(board, { ...report, kind, text }), undefined, `a ${kind} after an accept is delivered`);
    assert.equal(outcome(board, { ...report, text: 'An unrelated idea about review receipts' }), undefined, 'a shout naming no item with a recent event is delivered');
  });
});

test('cli.logic-shout-restated-report.c7-the-refusal-covers-only-the-sender: [C7] the refusal covers only the sender, only the last ten minutes and only submit, accept and reject events', () => {
  withBoard(({ board, id, at }) => {
    const shout = { from: 'web-1', to: 'coordinator', kind: 'idea', text: `reported #${id}` };
    store.logEvent(board, 'web-1', 'reject', id, {}, at(11));
    assert.equal(outcome(board, shout), undefined, 'an event older than ten minutes is not restated');
    store.logEvent(board, 'web-1', 'submit', id, {}, at(9));
    assert.equal(outcome(board, shout).code, 'REPORT_RESTATES_EVENT');
    assert.equal(outcome(board, { ...shout, from: 'web-2' }), undefined, 'another agent restates nothing of its own');
    for (const kind of ['question', 'blocker', 'decision']) assert.equal(outcome(board, { ...shout, kind }), undefined, `a ${kind} after a submit is delivered`);
    assert.equal(outcome(board, { ...shout, decision: true }), undefined, 'a decision request is delivered');
    assert.equal(outcome(board, { ...shout, to: 'api' }), undefined, 'only coordinator shouts are covered');
    assert.equal(outcome(board, { ...shout, from: 'person' }), undefined, 'the person is exempt');
  });
});

test('cli.logic-shout-restated-report.c7-b22-validated-integration-purposes-pass-while: [C7,B22] validated integration purposes pass while plain reports and unbound receipts still refuse', () => {
  withBoard(({ board, id, at }) => {
    store.logEvent(board, 'web-1', 'submit', id, {}, at(1));
    /** A shout carrying evidence of the given kind and outcome on item 1. */
    const send = (kind, evidenceOutcome, commit = COMMIT) => ({ from: 'web-1', to: 'coordinator', kind: undefined, text: `Integration state for #${id}`, item: String(id),
      evidence: { kind, outcome: evidenceOutcome, item: id, commit } });
    /** Record a delivered shout's evidence row, as the shout move does. */
    const record = (shout) => store.shout(board, { from: shout.from, to: 'coordinator', text: shout.text, lanes: ['coordinator', 'core'], item: id, evidence: shout.evidence });
    assert.equal(outcome(board, send('receipt', 'done')).code, 'REPORT_RESTATES_EVENT', 'a receipt with no attempt is a restatement');
    assert.equal(outcome(board, send('attempt', 'measured')).code, 'REPORT_RESTATES_EVENT', 'an attempt that is not integrating is a restatement');
    assert.equal(outcome(board, send('unknown', 'integrating')).code, 'BAD_EVIDENCE');
    assert.equal(outcome(board, send('attempt', 'integrating', 'missing-integration-commit')).code, 'BAD_EVIDENCE');
    const attempt = send('attempt', 'integrating');
    assert.equal(outcome(board, attempt), undefined, 'an integrating attempt is delivered');
    record(attempt);
    assert.equal(outcome(board, { ...attempt, evidence: undefined, kind: 'idea', text: `Submitted #${id}` }).code, 'REPORT_RESTATES_EVENT', 'plain progress still refuses');
    const receipt = send('receipt', 'superseded');
    assert.equal(outcome(board, receipt), undefined, 'a receipt closing the actor\'s attempt is delivered');
    record(receipt);
    assert.equal(outcome(board, send('receipt', 'done')).code, 'REPORT_RESTATES_EVENT', 'a second receipt has no open attempt');
  });
});

test('cli.logic-shout-restated-report.b22-evidence-names-a-real-commit-of: [B22] evidence names a real commit of the repo: a missing or unknown revision is refused BAD_EVIDENCE', () => {
  // A read-only rev-parse in this checkout: no repository is created.
  const ctx = { info: { root: resolve(import.meta.dirname, '../../../../..') } };
  for (const commit of [undefined, '', 'missing-integration-commit'])
    assert.throws(() => evidenceFrom(ctx, { evidence: 'attempt', outcome: 'integrating', item: '1', commit }), { code: 'BAD_EVIDENCE' });
});
