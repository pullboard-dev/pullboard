/** A pull job queued from a locally staged folder: row.json is written by a JS call, and the shipped folder matches the one the remote printf made [C7,#8820]. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdirSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import { readdirSync } from 'node:fs';
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { privateFixtureFiles } from '../../../../gate/tests/fixtures/child.js';
import { HOST } from '../../../../gate/tests/fixtures/runner/ssh.js';
import { installSshStandIn } from '../../../../gate/tests/fixtures/runner/ssh.js';
import { enqueueRunnerJob } from '../../../src/io/pull/enqueue.js';
import { enqueueStagedJob } from '../../../src/io/pull/stage.js';
import { stageRunnerJob } from '../../../src/io/pull/scripts.js';

/** A runner root and the ssh stand-in over it. */
function runnerFixture(t) {
  const base = privateFixtureFiles('pbstage-').root;
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const root = join(base, 'runner'), dir = join(base, 'status'), bin = join(base, 'bin'), requests = join(base, 'requests');
  for (const sub of [root, dir, bin, join(base, 'home')]) mkdirSync(sub, { recursive: true });
  const ssh = installSshStandIn({ bin, worker: base, home: join(base, 'home'), machineHome: join(base, 'machine'), requests });
  return { root, dir, ssh, runner: { host: HOST, root } };
}

const FRAME = Buffer.from([0, 1, 2, 10, 255, 10, 7]);
const NOW = 1_700_000_000_000;
const ROW = { recovery: { request: 'r' }, rawOutput: false };

test('clause 1: staging a pull job writes its row.json through a JS write call in a local folder, before anything ships [C7,#8820]', t => {
  const staged = stageRunnerJob({ id: 's-1', row: ROW, frame: FRAME, command: 'node x', now: NOW, parent: privateFixtureFiles('pbstage-parent-').root });
  t.after(() => rmSync(staged.dir, { recursive: true, force: true }));
  assert.deepEqual(readFileSync(join(staged.dir, 'row.json')), staged.rowBytes);
  assert.deepEqual(JSON.parse(staged.rowBytes.toString()), { version: 1, id: 's-1', enqueuedAt: NOW, ...ROW });
  assert.deepEqual(readFileSync(join(staged.dir, 'input')), FRAME);
  assert.deepEqual(readdirSync(staged.dir).sort(), ['command', 'input', 'row.json', 'wanted']);
});

test('clause 2: the shipped job folder holds the same row.json bytes, input, command and wanted file the remote printf enqueue made [C7,#8820]', async t => {
  const old = runnerFixture(t), staged = runnerFixture(t);
  const job = { id: 's-2', row: ROW, frame: FRAME, command: 'node x', now: NOW };
  await enqueueRunnerJob(old.runner, { id: job.id, row: { enqueuedAt: NOW, ...ROW }, frame: FRAME, command: job.command }, { ssh: old.ssh, dir: old.dir });
  await enqueueStagedJob(staged.runner, job, { ssh: staged.ssh, dir: staged.dir });
  const was = join(old.root, 'queue', 's-2'), now = join(staged.root, 'queue', 's-2');
  assert.deepEqual(readdirSync(now).sort(), readdirSync(was).sort());
  for (const name of readdirSync(now)) assert.deepEqual(readFileSync(join(now, name)), readFileSync(join(was, name)), name);
  assert.equal(existsSync(join(staged.root, 'queue', '.tmp-s-2')), false);
  await assert.rejects(enqueueStagedJob(staged.runner, job, { ssh: staged.ssh, dir: staged.dir }), error => error.code === 'RUNNER_PULL_SCRIPT' && error.status === 4, 'a duplicate id is refused as before');
});
