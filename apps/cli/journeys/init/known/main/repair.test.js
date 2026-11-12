/** A unique repair owner shows in submit text and test JSON [V4,B3,C7]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fixture } from '../../../../tests/fixtures/affected.js';
import { cli } from '../../../../tests/fixtures/affected.js';
import { fileMainRed } from '../../../../tests/fixtures/affected.js';
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

test('a unique repair owner appears at the top of submit text and in test JSON [V4,B3,C7]', async t => {
  const box = fixture(t);
  const owner = fileMainRed(box);
  // Submit runs first: the JSON test run below files its own Main red for the case, after which the file has two owners.
  const submitted = await text(box, 'submit', String(box.item), '--no-next');
  assert.equal(submitted.status, 0, submitted.stdout + submitted.stderr);
  const lines = submitted.stdout.split('\n');
  const explanation = lines.findIndex(line => line.startsWith('also fails on main at '));
  assert.ok(explanation >= 0);
  assert.ok(explanation < lines.findIndex(line => line.startsWith('submitted #')), 'case explanation precedes submission summary');
  assert.ok(lines[explanation].includes(`(not yours; owner #${owner}) [main receipt `));
  const tested = cli(box, box.builder, 'test', FILE, '--compare-main');
  assert.equal(tested.status, 1, tested.stdout + tested.stderr);
  assert.equal(JSON.parse(tested.stdout).mainFailures.length, 1, tested.stdout);
  notice(JSON.parse(tested.stdout).mainFailures[0], box, { owner });
});
