/** Exact case guidance carries the real main receipt in text and JSON, without changing verdicts [V4,B3,C7]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { runProfiledShellAsync } from '../../../../../../packages/gate/index.js';
import { existsSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { mainFailureNotices } from '../../../../../../packages/landing/index.js';
import { fixture } from '../../../../tests/fixtures/affected.js';
import { cli } from '../../../../tests/fixtures/affected.js';
import { rows } from '../../../../tests/fixtures/affected.js';
import { fileMainRed } from '../../../../tests/fixtures/affected.js';
import { runCliInProcess } from '../../../../tests/fixtures/process.js';
import { join } from 'node:path';

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
  const plain = await text(box, 'test', FILE, '--compare-main');
  assert.equal(plain.status, 1, plain.stdout + plain.stderr);
  assert.match(plain.stdout.split('\n')[0], new RegExp(`^also fails on main at ${box.main}:`), 'DIAG ' + plain.stdout.slice(0, 1200));
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

test('a unique repair owner appears at the top of submit text and in test JSON [V4,B3,C7]', async t => {
  const box = fixture(t);
  const owner = fileMainRed(box);
  const tested = cli(box, box.builder, 'test', FILE, '--compare-main');
  assert.equal(tested.status, 1, tested.stdout + tested.stderr);
  assert.equal(JSON.parse(tested.stdout).mainFailures.length, 1, tested.stdout);
  notice(JSON.parse(tested.stdout).mainFailures[0], box, { owner });
  const submitted = await text(box, 'submit', String(box.item), '--no-next');
  assert.equal(submitted.status, 0, submitted.stdout + submitted.stderr);
  const lines = submitted.stdout.split('\n');
  const explanation = lines.findIndex(line => line.startsWith('also fails on main at '));
  assert.ok(explanation >= 0);
  assert.ok(explanation < lines.findIndex(line => line.startsWith('submitted #')), 'case explanation precedes submission summary');
  assert.ok(lines[explanation].includes(`(not yours; owner #${owner}) [main receipt `));
});

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

/** Quote one real executable or private fixture path for the shell. */
function word(value) { return "'" + value.replaceAll("'", "'\\''") + "'"; }

test('async named accounting retains producer status, opaque unknowns and event-loop progress [V4,B3,C7]', async t => {
  const box = fixture(t);
  const producer = `${word(process.execPath)} -e ${word("process.stdout.write('producer\\n'); process.exitCode = 1")}`;
  const consumer = `${word(process.execPath)} -e ${word('process.stdin.resume()')}`;
  const pipeline = await runProfiledShellAsync(box.builder, `${producer} | ${consumer}`, { stages: true });
  assert.equal(pipeline.isGreen, true, 'stage capture preserves ordinary shell pipeline exit semantics');
  assert.deepEqual(pipeline.stages[0].pipeline.map(row => row.status), [1, 0]);
  assert.match(pipeline.stages[0].pipeline[0].output, /producer/u);
  const opaque = await runProfiledShellAsync(box.builder, '(false)', { stages: true });
  assert.equal(opaque.isGreen, false);
  assert.equal(opaque.stages, null, 'unsupported control flow is not guessed from stdout');

  const ready = join(box.directory, 'ready');
  const release = join(box.directory, 'release');
  const script = `const fs=require('node:fs'); fs.writeFileSync(${JSON.stringify(ready)},'ready'); const end=Date.now()+5000; const timer=setInterval(()=>{if(fs.existsSync(${JSON.stringify(release)})){clearInterval(timer); process.stdout.write('released\\n');}else if(Date.now()>end){clearInterval(timer);process.exitCode=1;}},10);`;
  let released = false;
  const timer = setInterval(() => {
    if (existsSync(ready)) { writeFileSync(release, 'release'); released = true; }
  }, 10);
  try {
    const run = await runProfiledShellAsync(box.builder, `${word(process.execPath)} -e ${word(script)}`, { stages: true });
    assert.equal(run.isGreen, true, run.output);
    assert.equal(released, true, 'the real child is released by this event loop while the run is pending');
    assert.equal(run.stages[0].status, 0);
    assert.match(run.output, /released/u);
  } finally { clearInterval(timer); }
});

test('an unaccountable cancelled main file retains a coarse verdict without accepted-case words [V4,B3,C7]', async t => {
  const box = fixture(t, { cancelled: true });
  const tested = cli(box, box.builder, 'test', FILE, '--compare-main');
  assert.equal(tested.status, 1, tested.stdout + tested.stderr);
  const report = JSON.parse(tested.stdout);
  assert.equal(report.green, false);
  assert.equal(report.known.find(row => row.file === FILE)?.result, 'red', tested.stdout);
  assert.deepEqual(report.mainFailures, [], 'cancellation never becomes an identical accepted case');
  assert.equal(report.mainFileFailures.length, 1);
  assert.equal(report.mainFileFailures[0].result, 'red');
  assert.equal(report.mainFileFailures[0].message, `file also fails on main at ${box.main}: ${FILE} (case comparison unavailable)`);
  const plain = await text(box, 'test', FILE, '--compare-main');
  assert.equal(plain.status, 1, plain.stdout + plain.stderr);
  assert.equal(plain.stdout.split('\n')[0], report.mainFileFailures[0].message);
  assert.doesNotMatch(plain.stdout, /not yours; accepted/u);
});
