/** A pulled trip starts its serve-need and finish controllers beside submit, so their load overlaps its prepare [C7]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { runPulled } from '../../../src/io/pull/delegate.js';

const RUNNER = { host: 'runner.example.invalid', slots: 1, browser: 0 };

/** Run one trip through fake seams and return the ordered events; `need` says whether the runner asks for history. */
async function trip({ need }) {
  const events = [];
  const custody = { job() {}, ready() {}, unavailable: () => null, close() {} };
  const start = mode => {
    events.push(`start ${mode}`);
    return {
      async send(payload) { events.push(`send ${mode}`); return mode === '--finish' ? { isGreen: true, phases: {}, reason: payload.reason } : { sent: true }; },
      async close() { events.push(`close ${mode}`); },
    };
  };
  const call = async mode => {
    assert.equal(mode, '--submit', 'only submit is started on demand');
    events.push('submit');
    return { id: 'job-1', recovery: {}, host: RUNNER.host, toolingSha: 'a'.repeat(64), reusedRuntime: false };
  };
  const waitRunnerJob = async ({ onNeed, onReady }) => {
    if (need) await onNeed('job-1', 'inventory');
    onReady();
    return { end: 'result', job: { exit: { code: 0, signal: null } } };
  };
  const result = await runPulled(process.cwd(), 'node -e 0', { runner: RUNNER, metadata: {} },
    { call, start, waitRunnerJob, controllerDeadline: () => custody, runnerItemState: () => null });
  return { events, result };
}

test('8189 clause 1: a trip starts serve-need and finish before submit, and sends each once [C7]', async () => {
  const { events, result } = await trip({ need: true });
  assert.equal(result.isGreen, true);
  assert.equal(result.reason, 'result');
  assert.deepEqual(events.slice(0, 3), ['start --serve-need', 'start --finish', 'submit'], 'both later modes load while submit prepares');
  assert.deepEqual(events.filter(event => event.startsWith('send')), ['send --serve-need', 'send --finish']);
});

test('8189 clause 1: a trip whose runner holds the source stops the serve-need controller it never used [C7]', async () => {
  const { events } = await trip({ need: false });
  assert.ok(!events.includes('send --serve-need'), 'no history was asked for');
  assert.ok(events.includes('close --serve-need'), 'the unused controller is stopped, never left running');
  assert.ok(events.indexOf('send --finish') < events.indexOf('close --serve-need'));
});
