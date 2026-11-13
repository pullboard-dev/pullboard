/** Candidate-only and differing-diagnostic failures keep their verdicts and wording [V4,B3,C7]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
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

test('candidate-only failures stay red, are first in text, and remain structured on refusal [V4,B3,C7]', async t => {
  const box = fixture(t, { main: 1, candidate: 2 });
  const tested = cli(box, box.builder, 'test', FILE, '--compare-main');
  assert.equal(tested.status, 1, tested.stdout + tested.stderr);
  assert.equal(JSON.parse(tested.stdout).mainFailures.length, 1, tested.stdout);
  notice(JSON.parse(tested.stdout).mainFailures[0], box, { only: true });
  const plain = await text(box, 'test', FILE, '--compare-main');
  assert.equal(plain.status, 1, plain.stdout + plain.stderr);
  assert.match(plain.stdout.split('\n')[0], /^fails only with your change:/u);
  const submitted = cli(box, box.builder, 'submit', String(box.item), '--no-next');
  assert.equal(submitted.status, 1, submitted.stdout + submitted.stderr);
  const refusal = JSON.parse(submitted.stdout);
  assert.equal(refusal.error.code, 'GATE_RED');
  assert.match(refusal.error.message, /^fails only with your change:/u);
  assert.equal(refusal.mainFailures.length, 1);
  notice(refusal.mainFailures[0], box, { only: true });
  assert.equal(rows(box, "SELECT event_id FROM event WHERE item_id=? AND event_kind='submit'", box.item).length, 0);
});

test('a case red on both sources with different diagnostics is not described as passing main [V4,B3,C7]', async t => {
  // Name the affected file in the frozen bar: own cases require an exact main failure signature.
  const box = fixture(t, { main: 2, candidate: 3, criterion: 'test/affected.test.js retains its behavior.' });
  const tested = cli(box, box.builder, 'test', FILE, '--compare-main');
  assert.equal(tested.status, 1, tested.stdout + tested.stderr);
  const report = JSON.parse(tested.stdout);
  assert.equal(report.mainFailures.length, 1, tested.stdout);
  assert.equal(report.mainFailures[0].status, 'different-on-main');
  assert.match(report.mainFailures[0].message, /^fails differently with your change:/u);
  assert.doesNotMatch(report.mainFailures[0].message, /not yours|fails only/u);
  const plain = await text(box, 'test', FILE, '--compare-main');
  assert.equal(plain.status, 1, plain.stdout + plain.stderr);
  assert.match(plain.stdout.split('\n')[0], /^fails differently with your change:/u);
  const submitted = cli(box, box.builder, 'submit', String(box.item), '--no-next');
  assert.equal(submitted.status, 1, submitted.stdout + submitted.stderr);
  const refusal = JSON.parse(submitted.stdout);
  assert.equal(refusal.error.code, 'GATE_RED');
  assert.equal(refusal.mainFailures[0].status, 'different-on-main');
  assert.match(refusal.error.message, /^fails differently with your change:/u);
  assert.equal(rows(box, "SELECT event_id FROM event WHERE item_id=? AND event_kind='submit'", box.item).length, 0);
});
