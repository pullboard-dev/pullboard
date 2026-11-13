/** @pullboard-test-input apps/cli/src/io/commands/submit.js */
/** Submit has one gate path: every gate is a pull job row, whatever gate.runnerDispatch says [C7,P7]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { jobsOf } from '../../../../../packages/jobs/index.js';
import { pullProject } from '../../../tests/fixtures/pull.js';
import { pullQueue } from '../../../tests/fixtures/pull.js';
import { submitOne } from '../../../tests/fixtures/pull.js';

const SUBMIT = resolve(import.meta.dirname, '../../../src/io/commands/submit.js');

/** The body of submitHere, from its signature to the closing brace at the start of a line. */
function submitHereBody() {
  const source = readFileSync(SUBMIT, 'utf8');
  const start = source.indexOf('export async function submitHere(');
  assert.ok(start >= 0, 'submit.js defines submitHere');
  return source.slice(start, source.indexOf('\n}\n', start) + 2);
}

test('clause 1: submitHere offers every gate as a pull job and holds no inline gate code [C7]', () => {
  const body = submitHereBody();
  const offers = body.match(/offerSubmitGate\(/gu) ?? [];
  assert.equal(offers.length, 1, 'one pull offer');
  assert.match(body, /\n {2}return \(await import\('\.\.\/submit\/pull\.js'\)\)\.offerSubmitGate\([^\n]*\n\}$/u, 'the offer ends submitHere unconditionally');
  for (const inline of ['runSubmitGate', 'remoteSubmitAnalysis', 'gateWithRunnerPlan', 'runGateStages', 'withGateSlot', 'pullGateWanted', 'enqueueSubmitHandoff'])
    assert.equal(body.includes(inline), false, `submitHere holds no ${inline}`);
  assert.ok(body.split('\n').length < 260, 'the inline gate (~530 lines) is gone');
});

test('clause 2: a submit under gate.runnerDispatch controller settles through the pull gate [C7,P7]', async t => {
  const box = await pullProject(t, 1, { gate: { runnerDispatch: 'controller' } });
  const [id] = box.ids;
  const { document, commit } = submitOne(box, id);
  assert.equal(document.queued, true, 'the submit returns queued, not an inline gate result');
  const { board } = await pullQueue(t, box);
  const rows = jobsOf(board.db, { kind: 'gate' });
  assert.deepEqual(rows.map(row => [row.item, row.step, row.candidate]), [[id, 'offered', commit]], 'one offered gate job row');
});
