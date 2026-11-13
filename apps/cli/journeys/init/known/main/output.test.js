/** Exact case guidance carries the real main receipt in text and JSON, without changing verdicts [V4,B3,C7]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mainFailureNotices } from '../../../../../../packages/landing/index.js';
import { fixture } from '../../../../tests/fixtures/affected.js';
import { cli } from '../../../../tests/fixtures/affected.js';
import { rows } from '../../../../tests/fixtures/affected.js';
import { runCliInProcess } from '../../../../tests/fixtures/process.js';

const FILE = 'test/affected.test.js';
const NAME = 'affected case [G1]';

/** Invoke ordinary text mode, retaining its first output line separately from diagnostics. */
async function text(box, ...args) {
  return await runCliInProcess(args, { cwd: box.builder, env: box.env });
}

/** Exact wording, case identity and receipt custody are shared by both command documents. */
function notice(value, box, { owner, only = false } = {}) {
  assert.equal(value.file, FILE);
  assert.equal(value.name, NAME);
  assert.equal(value.main, box.main);
  assert.match(value.receiptId, /^[a-f0-9-]{36}$/u);
  const expected = only ? `fails only with your change: ${FILE} :: ${NAME}`
    : `also fails on main at ${box.main}: ${FILE} :: ${NAME} (not yours; ${owner ? `owner #${owner}` : 'accepted'})`;
  assert.equal(value.message, `${expected} [main receipt ${value.receiptId}]`);
  assert.equal(value.status, only ? 'candidate-only' : 'also-main');
}

test('identical main case is first in text and structured in test and submit, with real receipt [V4,B3,C7]', async t => {
  const box = fixture(t);
  const tested = cli(box, box.builder, 'test', FILE, '--compare-main');
  assert.equal(tested.status, 1, tested.stdout + tested.stderr);
  const report = JSON.parse(tested.stdout);
  assert.equal(report.green, false, 'guidance does not turn a red test green');
  assert.equal(report.mainFailures.length, 1, JSON.stringify(report));
  notice(report.mainFailures[0], box);
  // The JSON run above filed main's red as an item, which makes the file a known red for this board; text mode is judged on a fresh one.
  const fresh = fixture(t);
  const plain = await text(fresh, 'test', FILE, '--compare-main');
  assert.equal(plain.status, 1, plain.stdout + plain.stderr);
  assert.match(plain.stdout.split('\n')[0], new RegExp(`^also fails on main at ${fresh.main}:`));
  assert.ok(plain.stdout.split('\n')[0].includes('[main receipt '));
  const submitted = cli(box, box.builder, 'submit', String(box.item), '--no-next');
  assert.equal(submitted.status, 0, submitted.stdout + submitted.stderr);
  const submission = JSON.parse(submitted.stdout);
  assert.equal(submission.gate.green, false);
  assert.equal(submission.gate.mainFailures.length, 1);
  // The first run filed main's red, so the board now names its owner.
  const filed = rows(box, "SELECT item_id FROM item WHERE item_title LIKE 'Main red: %'");
  assert.equal(filed.length, 1, JSON.stringify(filed));
  notice(submission.gate.mainFailures[0], box, { owner: filed[0].item_id });

  const comparison = { main: box.main, files: report.known };
  const failures = report.known[0].failures;
  assert.equal(mainFailureNotices(box.builder, failures, comparison).length, 1);
  for (const bad of [
    { ...comparison, unavailable: 'runner unavailable' },
    { ...comparison, main: box.head },
    { ...comparison, files: report.known.map(({ receiptId, ...entry }) => entry) },
    { ...comparison, files: report.known.map(entry => ({ ...entry, receiptId: '00000000-0000-0000-0000-000000000000' })) },
    { ...comparison, files: report.known.map(entry => ({ ...entry, failures: undefined })) },
    { ...comparison, files: [...report.known, ...report.known] },
  ]) assert.deepEqual(mainFailureNotices(box.builder, failures, bad), [], 'incomplete, stale or ambiguous evidence is not accepted wording');
});
