/** @pullboard-test-input apps/cli/src/io/gate/drive.js packages/resources/index.js */
/** The hand-off dispatcher frees the slot of a worker that ends with no result, and dispatcher.json names the lock holder [C7]. */
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import { realpathSync } from 'node:fs';
import { rmSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { drainHandoffQueue } from '../../../../../packages/resources/index.js';
import { handoffQueueDirectory } from '../../../../../packages/resources/index.js';
import { queueHandoffLaunch } from '../../../../../packages/resources/index.js';
import { reserveHandoffTicket } from '../../../../../packages/resources/index.js';
import { temporaryDirectory } from '../../../tests/fixtures/board.js';

/** A stand-in gate driver that records that it ran, then ends without writing any result. */
const WORKER = `const fs = require('node:fs');
const path = require('node:path');
fs.writeFileSync(path.join(path.dirname(process.argv[2]), 'ran'), 'ran');
`;

test('child exits with no result: slot freed, ticket requeued [C7]', { timeout: 60_000 }, async t => {
  const dir = realpathSync(temporaryDirectory('pullboard-dead-slots-'));
  const tools = join(dir, 'tools');
  mkdirSync(join(tools, 'apps/cli/src/io/gate'), { recursive: true });
  writeFileSync(join(tools, 'apps/cli/src/io/gate/drive.js'), WORKER);
  const saved = process.env.PULLBOARD_MACHINE_HOME;
  const home = join(dir, 'home');
  mkdirSync(home);
  process.env.PULLBOARD_MACHINE_HOME = home;
  t.after(() => {
    if (saved === undefined) delete process.env.PULLBOARD_MACHINE_HOME; else process.env.PULLBOARD_MACHINE_HOME = saved;
    rmSync(dir, { recursive: true, force: true });
  });
  const jobs = ['first', 'second'];
  for (const job of jobs) {
    const directory = join(dir, 'jobs', job);
    mkdirSync(directory, { recursive: true });
    writeFileSync(join(directory, 'request.json'), JSON.stringify({ job }) + '\n');
    queueHandoffLaunch({ directory, tools, commonDir: dir, job }, await reserveHandoffTicket(job));
  }
  let sweeps = 0;
  const result = await drainHandoffQueue({ capacity: 1, pollMs: 25, resultGraceMs: 0, sweep: async () => { sweeps += 1; } });
  assert.deepEqual(result.started, jobs, 'with a cap of one, the second worker starts only after the dead first one gave its slot back');
  for (const job of jobs) assert.equal(readFileSync(join(dir, 'jobs', job, 'ran'), 'utf8'), 'ran');
  assert.ok(sweeps >= 2, 'a worker that exited with no result asks for a sweep at once, which requeues its gate');
});

test('dispatcher.json carries the live dispatcher pid [C7]', { timeout: 60_000 }, async t => {
  const dir = realpathSync(temporaryDirectory('pullboard-dead-receipt-'));
  const tools = join(dir, 'tools');
  mkdirSync(join(tools, 'apps/cli/src/io/gate'), { recursive: true });
  writeFileSync(join(tools, 'apps/cli/src/io/gate/drive.js'), WORKER);
  const saved = process.env.PULLBOARD_MACHINE_HOME;
  const home = join(dir, 'home');
  mkdirSync(home);
  process.env.PULLBOARD_MACHINE_HOME = home;
  t.after(() => {
    if (saved === undefined) delete process.env.PULLBOARD_MACHINE_HOME; else process.env.PULLBOARD_MACHINE_HOME = saved;
    rmSync(dir, { recursive: true, force: true });
  });
  const directory = join(dir, 'jobs', 'only');
  mkdirSync(directory, { recursive: true });
  writeFileSync(join(directory, 'request.json'), JSON.stringify({ job: 'only' }) + '\n');
  queueHandoffLaunch({ directory, tools, commonDir: dir, job: 'only' }, await reserveHandoffTicket('only'));
  writeFileSync(join(handoffQueueDirectory(), 'dispatcher.json'), JSON.stringify({ pid: 1, started: 'launcher' }) + '\n');
  await drainHandoffQueue({ capacity: 1, pollMs: 25, resultGraceMs: 0, startOf: pid => `start-${pid}` });
  const receipt = JSON.parse(readFileSync(join(handoffQueueDirectory(), 'dispatcher.json'), 'utf8'));
  assert.equal(receipt.pid, process.pid, 'the lock holder rewrote the launcher pid');
  assert.equal(receipt.started, `start-${process.pid}`);
});
