/** Exact case guidance carries the real main receipt in text and JSON, without changing verdicts [V4,B3,C7]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mainFailureNotices } from '../src/main-red.js';
import { fixture } from './known-main-affected.fixture.js';
import { cli } from './known-main-affected.fixture.js';
import { rows } from './known-main-affected.fixture.js';
import { fileMainRed } from './known-main-affected.fixture.js';
import { runFixtureChild } from './fixture-child.js';
import { join } from 'node:path';

const BIN = join(import.meta.dirname, '../bin/pullboard.js');
const FILE = 'test/affected.test.js';
const NAME = 'affected case [G1]';

/** Invoke ordinary text mode, retaining its first output line separately from diagnostics. */
function text(box, ...args) {
  return runFixtureChild(process.execPath, [BIN, ...args], { cwd: box.builder, env: box.env, encoding: 'utf8' });
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

test('identical main case is first in text and structured in test and submit, with real receipt [V4,B3,C7]', t => {
  const box = fixture(t);
  const tested = cli(box, box.builder, 'test', FILE);
  assert.equal(tested.status, 1, tested.stdout + tested.stderr);
  const report = JSON.parse(tested.stdout);
  assert.equal(report.green, false, 'guidance does not turn a red test green');
  assert.equal(report.mainFailures.length, 1);
  notice(report.mainFailures[0], box);
  const plain = text(box, 'test', FILE);
  assert.equal(plain.status, 1, plain.stdout + plain.stderr);
  assert.match(plain.stdout.split('\n')[0], new RegExp(`^also fails on main at ${box.main}:`));
  assert.ok(plain.stdout.split('\n')[0].includes('[main receipt '));
  const submitted = cli(box, box.builder, 'submit', String(box.item), '--no-next');
  assert.equal(submitted.status, 0, submitted.stdout + submitted.stderr);
  const submission = JSON.parse(submitted.stdout);
  assert.equal(submission.gate.green, false);
  assert.equal(submission.gate.mainFailures.length, 1);
  notice(submission.gate.mainFailures[0], box);

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

test('a unique repair owner appears at the top of submit text and in test JSON [V4,B3,C7]', t => {
  const box = fixture(t);
  const owner = fileMainRed(box);
  const tested = cli(box, box.builder, 'test', FILE);
  assert.equal(tested.status, 1, tested.stdout + tested.stderr);
  notice(JSON.parse(tested.stdout).mainFailures[0], box, { owner });
  const submitted = text(box, 'submit', String(box.item), '--no-next');
  assert.equal(submitted.status, 0, submitted.stdout + submitted.stderr);
  const lines = submitted.stdout.split('\n');
  const explanation = lines.findIndex(line => line.startsWith('also fails on main at '));
  assert.ok(explanation >= 0);
  assert.ok(explanation < lines.findIndex(line => line.startsWith('submitted #')), 'case explanation precedes submission summary');
  assert.ok(lines[explanation].includes(`(not yours; owner #${owner}) [main receipt `));
});

test('candidate-only failures stay red, are first in text, and remain structured on refusal [V4,B3,C7]', t => {
  const box = fixture(t, { main: 1, candidate: 2 });
  const tested = cli(box, box.builder, 'test', FILE);
  assert.equal(tested.status, 1, tested.stdout + tested.stderr);
  notice(JSON.parse(tested.stdout).mainFailures[0], box, { only: true });
  const plain = text(box, 'test', FILE);
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
