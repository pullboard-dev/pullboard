/** Async named accounting and an unaccountable cancelled main file keep their coarse verdicts [V4,B3,C7]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { runProfiledShellAsync } from '../../../../../../packages/gate/index.js';
import { existsSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { fixture } from '../../../../tests/fixtures/affected.js';
import { cli } from '../../../../tests/fixtures/affected.js';
import { runCliInProcess } from '../../../../tests/fixtures/process.js';
import { join } from 'node:path';

const FILE = 'test/affected.test.js';

/** Invoke ordinary text mode, retaining its first output line separately from diagnostics. */
async function text(box, ...args) {
  return await runCliInProcess(args, { cwd: box.builder, env: box.env });
}

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
