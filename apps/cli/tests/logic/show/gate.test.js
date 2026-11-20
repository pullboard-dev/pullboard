/** show prints no refusal or next step from an infrastructure stop that no longer covers the item's claim or bar (#3325) [C7]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  pulledRedLines,
  pulledWaitingLines,
  settledGateWord,
  queueWaitLines,
  queuedGateLines,
  supersededStop,
} from '../../../src/logic/show/gate.js';
import { settledGate } from '../../../../../packages/jobs/index.js';

const STOP = { state: 'infrastructure', agentId: 'core-1324', digest: 'old', commit: 'c'.repeat(40), executionCommit: 'c'.repeat(40),
  error: { code: 'GATE_INFRA_EXHAUSTED', message: 'the gate stopped on infrastructure 4 times', next: 'nothing to do as the builder: the coordinator restores the named runner and requeues this gate' } };

/** The lines show prints for `job` on `item`, built as show builds its queued-gate record. */
function lines(job, item) {
  return queuedGateLines({ ...job, ...(supersededStop(job, item) ? { superseded: { agentId: job.agentId } } : {}) }).join('\n');
}

test('cli.logic-show-gate.a-stop-by-another-seat-or-under: clause 1: a stop by another seat, or under an older bar, prints no refusal or next step (#3325) [C7]', () => {
  const cases = [
    ['another seat holds it', { item_status: 'claimed', item_owner: 'core-1869', item_frozen_digest: 'old' }],
    ['refrozen under the same seat', { item_status: 'claimed', item_owner: 'core-1324', item_frozen_digest: 'new' }],
    ['open after a refreeze', { item_status: 'open', item_owner: null, item_frozen_digest: 'new' }],
  ];
  for (const [label, item] of cases) {
    const shown = lines(STOP, item);
    assert.doesNotMatch(shown, /GATE_INFRA_EXHAUSTED|next:|nothing to do as the builder/u, label);
    assert.match(shown, /^earlier gate: infrastructure at c{40} for core-1324 .*does not cover this claim$/u, label);
  }
});

test('cli.logic-show-gate.the-stop-still-prints-its-refusal-and: clause 1: the stop still prints its refusal and next step for the claim and bar it was built for [C7]', () => {
  for (const item of [{ item_status: 'claimed', item_owner: 'core-1324', item_frozen_digest: 'old' },
    { item_status: 'open', item_owner: null, item_frozen_digest: 'old' }]) {
    const shown = lines(STOP, item);
    assert.match(shown, /^queued gate: infrastructure at c{40}\nGATE_INFRA_EXHAUSTED: .*\nnext: nothing to do as the builder/u, item.item_status);
  }
});

test('cli.logic-show-gate.only-an-infrastructure-stop-is-ever-superseded: clause 1: only an infrastructure stop is ever superseded; a red gate keeps its refusal [C7]', () => {
  const red = { ...STOP, state: 'red', error: { code: 'GATE_RED', message: 'red', next: 'fix it' } };
  assert.equal(supersededStop(red, { item_status: 'claimed', item_owner: 'core-1869', item_frozen_digest: 'new' }), false);
  assert.match(lines(red, { item_status: 'claimed', item_owner: 'core-1869', item_frozen_digest: 'new' }), /GATE_RED: red\nnext: fix it/u);
});

test('cli.logic-show-gate.a-red-pulled-gate-prints-gate-red: a red pulled gate prints GATE_RED, each case once, a bounded tail and its full log; a green or submitted one prints nothing [C7,V10]', () => {
  const errors = [{ file: 'test/a.test.js', name: 'first', error: 'first detail\nmore' }, { file: 'test/a.test.js', name: 'second', error: 'second detail' }];
  const gate = { green: false, counts: { passed: 400, failed: 4, skipped: 0 }, logPath: '/kept/check.log', logRunner: 'r1',
    phases: [{ role: 'check', status: 1, errors }, { role: 'proof', status: 1, errors }, { role: 'extra', status: 2, exit: Array.from({ length: 30 }, (_, n) => `line ${n}`).join('\n') }] };
  const red = pulledRedLines({ id: 'gate:1', step: 'done', gate }, { item_id: 1, item_status: 'claimed' });
  assert.match(red[0], /^GATE_RED: gate job gate:1 is red: 400 passed, 4 failed; its full log is on runner r1/u);
  assert.deepEqual(red.filter(line => line.includes('::')), ['  test/a.test.js :: first: first detail more', '  test/a.test.js :: second: second detail']);
  assert.equal(red.filter(line => line.startsWith('  extra | ')).length, 10, 'a phase that names no case prints its last 10 lines');
  assert.equal(red.at(-1), 'full log: /kept/check.log');
  assert.deepEqual(pulledRedLines({ id: 'gate:1', step: 'done', gate: { ...gate, green: true } }, { item_id: 1, item_status: 'claimed' }), []);
  assert.deepEqual(pulledRedLines({ id: 'gate:1', step: 'done', gate }, { item_id: 1, item_status: 'submitted' }), []);
  assert.deepEqual(pulledRedLines({ id: 'gate:1', step: 'claimed', gate: null }, { item_id: 1, item_status: 'claimed' }), []);
});

/** A red proof phase whose one failing case carries `error`, with a node --test output tail that names the crash. */
function crashedGate(error) {
  return { green: false, phases: [{ role: 'proof', status: 1, errors: [{ file: 'test/a.test.js', name: 'a.test.js', error }],
    tail: '# Subtest: a.test.js\n# ReferenceError: describe is not defined\n#     at file:///a.test.js:1:1' }] };
}

test('cli.logic-show-gate.generic-case-error-leads-with-output-line: clause 1: a case whose error is only "test failed" is named by the first error line of its phase output [C7]', () => {
  const red = pulledRedLines({ id: 'gate:1', step: 'done', gate: crashedGate('test failed') }, { item_id: 1, item_status: 'claimed' });
  const named = red.find(line => line.includes('::'));
  assert.match(named, /ReferenceError: describe is not defined$/u);
  assert.doesNotMatch(named, /test failed/u);
});

test('cli.logic-show-gate.specific-case-error-unchanged: clause 2: a case with its own error keeps that text and gets no extra output line [C7]', () => {
  const red = pulledRedLines({ id: 'gate:1', step: 'done', gate: crashedGate('expected 1 to equal 2') }, { item_id: 1, item_status: 'claimed' });
  assert.deepEqual(red.filter(line => line.includes('::')), ['  test/a.test.js :: a.test.js: expected 1 to equal 2']);
  assert.ok(!red.some(line => line.includes('ReferenceError')), 'the output line is not added beside a specific error');
});

const DEFERRED = { green: false, deferred: true, phases: [{ role: 'proof', status: 1, exit: 'full suite deferred' }] };

test('cli.logic-show-gate.a-done-gate-whose-receipt-is-deferred: clause 1: a done gate whose receipt is deferred to shard jobs prints no GATE_RED line [C7]', () => {
  assert.deepEqual(pulledRedLines({ id: 'gate:2', step: 'done', gate: DEFERRED }, { item_id: 2, item_status: 'claimed' }), []);
});

test('cli.logic-show-gate.show-names-a-deferred-gate-as-passed: clause 2: show names a deferred gate as passed its checks and waiting on its shard jobs [C7]', () => {
  const [line, ...rest] = pulledWaitingLines({ id: 'gate:2', step: 'done', gate: DEFERRED }, { item_id: 2, item_status: 'claimed' });
  assert.deepEqual(rest, []);
  assert.match(line, /^GATE_WAITING: gate job gate:2 passed its checks; its proof waits on its shard jobs/u);
  assert.deepEqual(pulledWaitingLines({ id: 'gate:2', step: 'done', gate: { ...DEFERRED, deferred: false } }, { item_id: 2, item_status: 'claimed' }), [], 'a plain red is not waiting');
  assert.deepEqual(pulledWaitingLines({ id: 'gate:2', step: 'done', gate: DEFERRED }, { item_id: 2, item_status: 'submitted' }), []);
});

test('cli.logic-show-gate.a-deferred-gate-settled-red-or-unknown: clause 1: a deferred gate whose shards settled red or unknown prints GATE_RED or GATE_UNKNOWN, and GATE_WAITING only while no settled fact exists [C7,#10893]', () => {
  const job = { id: 'gate:3', step: 'done', gate: DEFERRED }, item = { item_id: 3, item_status: 'claimed' };
  const fact = text => ({ type: 'fact', text });
  const sharded = fact('Gate job gate:3 passed its checks at abc; its proof of 9 files is offered as 3 shard jobs');
  assert.match(pulledWaitingLines(job, item, [sharded])[0], /^GATE_WAITING: gate job gate:3 /u, 'shards still pending');
  assert.match(pulledWaitingLines(job, item, [sharded, fact('Gate job gate:3 red at abc; failing parts:\nproof not ok: x')])[0], /^GATE_RED: gate job gate:3 settled red/u);
  assert.doesNotMatch(pulledWaitingLines(job, item, [sharded, fact('Gate job gate:3 red at abc; failing parts:')]).join('\n'), /GATE_WAITING|do not resubmit/u);
  assert.match(pulledWaitingLines(job, item, [fact("Gate job gate:3 unknown at abc until main's missing receipts record; failing parts:")])[0], /^GATE_UNKNOWN: gate job gate:3 settled unknown/u);
  assert.deepEqual(pulledWaitingLines(job, item, [fact('Gate job gate:3 green')]), [], 'a green settle prints no waiting line');
  assert.match(pulledWaitingLines(job, item, [fact('Gate job gate:2 red at abc; failing parts:')])[0], /^GATE_WAITING/u, 'another gate job\'s settle does not count');
  assert.equal(settledGateWord([], 'gate:3'), null);
});

test('cli.logic-show-gate.show-prints-queuewaitseconds-in-under-200-ms: clause 2: show prints queueWaitSeconds from a fixture gate receipt in under 200 ms [C7,#10524]', () => {
  const posted = { runner: 'r-a', receipt: { status: 0, queueWaitSeconds: 7.5, gate: { green: true, phases: [{ role: 'check', status: 0 }] } } };
  const began = performance.now();
  const lines = queueWaitLines({ id: 'gate:fixture', step: 'done', gate: settledGate('gate:fixture', posted) });
  const ms = performance.now() - began;
  process.stdout.write(`show queueWaitSeconds line ms: ${ms.toFixed(2)}\n`);
  assert.deepEqual(lines, ['queueWaitSeconds: 7.5']);
  assert.deepEqual(queueWaitLines({ id: 'g', step: 'done', gate: settledGate('g', { receipt: { gate: { green: true } } }) }), [], 'a receipt with no wait prints no line');
});

test('cli.logic-show-gate.stale-settle-says-resubmit: clause 1: a gate job that settled stale prints a resubmit line, not GATE_WAITING [C7,#11935]', () => {
  const item = { item_id: 5, item_status: 'claimed' };
  const lines = pulledWaitingLines({ id: 'gate:5', step: 'done', gate: DEFERRED, settle: 'stale' }, item, [{ type: 'fact', text: 'Gate job gate:5 passed its checks at abc; its proof of 9 files is offered as 3 shard jobs' }]);
  assert.deepEqual(lines, ['GATE_STALE: gate job gate:5 settled stale; build at your claim and run pullboard submit 5']);
  assert.doesNotMatch(lines.join('\n'), /GATE_WAITING|do not resubmit/u);
  assert.deepEqual(pulledWaitingLines({ id: 'gate:5', step: 'done', gate: DEFERRED, settle: 'stale' }, { item_id: 5, item_status: 'submitted' }), [], 'a held item prints no stale line');
});

test('cli.logic-show-gate.unsettled-gate-still-says-waiting: clause 1: a gate job with no settle step, or an unknown one, still prints GATE_WAITING [C7,#11935]', () => {
  const item = { item_id: 6, item_status: 'claimed' };
  for (const settle of [undefined, 'review', 'unknown']) {
    const [line, ...rest] = pulledWaitingLines({ id: 'gate:6', step: 'done', gate: DEFERRED, ...(settle ? { settle } : {}) }, item);
    assert.match(line, /^GATE_WAITING: gate job gate:6 passed its checks; its proof waits on its shard jobs, so do not resubmit #6/u, String(settle));
    assert.deepEqual(rest, []);
  }
});
