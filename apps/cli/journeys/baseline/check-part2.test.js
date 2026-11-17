/** @pullboard-test-input apps/cli/pullboard.js apps/lib/src/io/check/baseline.js */
/** Coordinator-owned check commands and explicit caller consent [V2,N23]. */
import assert from 'node:assert/strict';
import { startFixtureChild as spawn } from '../../tests/fixtures/child.js';
import { existsSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { resolve } from 'node:path';
import { after } from 'node:test';
import { test } from 'node:test';
import { addItem } from '../../../../packages/store/index.js';
import { closeBoard } from '../../../../packages/store/index.js';
import { openBoard } from '../../../lib/index.js';
import { prepareCheckBaseline } from '../../../../packages/gate/src/io/check/baseline.js';
import { project } from '../../tests/fixtures/check-owner.js';
import { removeSandboxes } from '../../tests/fixtures/check-owner.js';
import { shellWord } from '../../tests/fixtures/check-owner.js';

const BASELINE_WORKER = resolve(import.meta.dirname, '../../../lib/src/io/check/baseline.js');
const BACKGROUND_WRITERS = [];

/** Wait for every owned baseline worker before removing its fixture repository. */
async function cleanupFixtures() {
  const failures = [];
  for (const writer of BACKGROUND_WRITERS) writeFileSync(writer.releaseFile, 'release');
  for (const writer of BACKGROUND_WRITERS) {
    try {
      await writer.closed;
      assert.notEqual(writer.child.exitCode, null, `background writer ${writer.name} did not exit before cleanup`);
      assert.equal(writer.child.signalCode, null, `background writer ${writer.name} was signaled before cleanup`);
      assert.equal(writer.child.exitCode, 0, `background writer ${writer.name} exited unsuccessfully before cleanup`);
      assert.equal(readFileSync(writer.completedFile, 'utf8'), writer.completedValue,
        `background writer ${writer.name} wrote its late marker before cleanup`);
    } catch (error) { failures.push(error); }
  }
  for (const writer of BACKGROUND_WRITERS) if (writer.child.exitCode === null) await writer.closed;
  removeSandboxes();
  if (failures.length) throw failures[0];
}

after(cleanupFixtures);

/** Wait for a real baseline worker to start its held check before the test body ends. */
async function waitForFile(filename, child, description) {
  // budget: a pulled check starts only after its enqueue, the runner agent and the job's worker each boot; at runner load
  // that passed 10 s on the pull runners (#6917).
  const deadline = Date.now() + 60_000;
  while (!existsSync(filename) && child.exitCode === null && child.signalCode === null && Date.now() < deadline) {
    await new Promise(resolvePromise => setTimeout(resolvePromise, 10));
  }
  assert.ok(existsSync(filename), `${description}${child.fixtureFailure ? `: ${child.fixtureFailure}` : ''}`);
}

test('check cleanup waits for every background writer [C7]', async () => {
  const box = await project();
  const startedFile = join(box.dir, 'baseline-started');
  const releaseFile = join(box.dir, 'baseline-release');
  const completedFile = join(box.dir, 'baseline-completed');
  const completedValue = 'late baseline write completed';
  const source = [
    `const fs = require('node:fs');`,
    `fs.writeFileSync(${JSON.stringify(startedFile)}, 'started');`,
    `while (!fs.existsSync(${JSON.stringify(releaseFile)})) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);`,
    `fs.writeFileSync(${JSON.stringify(completedFile)}, ${JSON.stringify(completedValue)});`,
  ].join('');
  const command = `${shellWord(process.execPath)} -e ${shellWord(source)}`;
  const baseline = prepareCheckBaseline(box.repo, command);
  assert.equal(baseline.result, 'pending', 'the real fixture check starts with an authorized pending baseline');
  const board = openBoard(join(box.repo, '.git', 'pullboard', 'board.sqlite'));
  let itemId;
  try {
    itemId = addItem(board, {
      by: 'coordinator', lane: 'web', title: 'Held baseline writer',
      criterion: 'cleanup waits until the baseline worker exits', check: command, checkBaseline: baseline,
    });
  } finally { closeBoard(board); }

  // Process-level: a detached baseline worker must outlive the test body until cleanup releases it.
  const child = spawn(process.execPath, [BASELINE_WORKER, box.repo, String(itemId), baseline.request], {
    cwd: box.repo, env: box.env, stdio: 'ignore',
  });
  const closed = new Promise(resolveClose => {
    child.once('close', (code, signal) => resolveClose({ code, signal }));
  });
  BACKGROUND_WRITERS.push({
    name: `baseline request ${baseline.request}`,
    child,
    releaseFile,
    completedFile,
    completedValue,
    closed,
  });
  await waitForFile(startedFile, child, `background writer ${baseline.request} started its check`);
  assert.equal(existsSync(completedFile), false, 'the baseline is still writing after the test body reaches cleanup');
});
