/** Ordinary board commands revive captured launches without duplicating live dispatchers [C7]. */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdirSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { test } from 'node:test';
import { exactStart } from '../packages/gate/index.js';
import { HANDOFF_DISPATCHER_RESOURCE, takeResource } from '../packages/resources/index.js';
import { queueHandoffLaunch } from '../packages/resources/index.js';
import { reserveHandoffTicket } from '../packages/resources/index.js';
import { createE2eHelpers } from './e2e-helpers.js';
import { runFixtureChild } from './fixture-child.js';
import { waitForCondition } from './runner-fixture-state.js';

/** Demand a native success before consuming fixture data. */
function document(result) {
  assert.equal(result.code, 0, result.err + result.out);
  return JSON.parse(result.out);
}

/** Prepare a real held seat and a private captured dispatcher process with observable lifetime. */
async function fixture(t, state) {
  const helpers = createE2eHelpers();
  let marker, stop, held;
  t.after(async () => {
    try {
      if (held) held.release();
      if (stop) writeFileSync(stop, 'stop');
      if (marker && existsSync(marker)) {
        const pids = readFileSync(marker, 'utf8').trim().split('\n').map(Number);
        await waitForCondition(() => pids.every(pid => !exactStart(pid)), 'owned dispatcher probes have exited');
      }
    } finally { helpers.cleanup(); }
  });
  const box = helpers.project('true');
  const id = document(box.run(box.repo, 'add', 'web', 'Dispatcher recovery fixture',
    '--specs', 'G1', '--criterion', 'The fixture remains held.', '--json')).item.item_id;
  document(box.run(box.web, 'claim', String(id), '--json'));
  const tools = join(box.dir, 'captured-tools');
  marker = join(box.dir, 'dispatcher-starts');
  stop = join(box.dir, 'stop-dispatcher');
  const queue = join(box.env.PULLBOARD_MACHINE_HOME, 'handoff-queue');
  mkdirSync(join(tools, 'bin'), { recursive: true });
  mkdirSync(queue, { recursive: true });
  // A working dispatcher is whoever holds the machine's dispatcher lock, so the captured stub takes it and keeps it until told to stop.
  const resourcesUrl = pathToFileURL(join(import.meta.dirname, '..', 'packages', 'resources', 'index.js')).href;
  writeFileSync(join(tools, 'bin', 'handoff-worker-dispatcher.js'), [
    "const fs = require('node:fs');",
    `const stop = ${JSON.stringify(stop)};`,
    '(async () => {',
    `  const { takeResource, HANDOFF_DISPATCHER_RESOURCE } = await import(${JSON.stringify(resourcesUrl)});`,
    "  const lock = await takeResource({ name: HANDOFF_DISPATCHER_RESOURCE, capacity: 1, scope: 'machine', agent: 'fixture-dispatcher', onWait() { process.exit(0); } });",
    `  fs.appendFileSync(${JSON.stringify(marker)}, process.pid + '\\n');`,
    `  await new Promise(done => { const watcher = fs.watch(${JSON.stringify(box.dir)}, () => { if (fs.existsSync(stop)) { watcher.close(); done(); } }); if (fs.existsSync(stop)) { watcher.close(); done(); } });`,
    '  lock.release();',
    '})();',
  ].join('\n'));
  if (state !== 'empty') {
    const prior = process.env.PULLBOARD_MACHINE_HOME;
    process.env.PULLBOARD_MACHINE_HOME = box.env.PULLBOARD_MACHINE_HOME;
    try {
      const job = randomUUID();
      const reservation = await reserveHandoffTicket(job, { startOf: exactStart });
      queueHandoffLaunch({ directory: box.dir, tools, commonDir: join(box.repo, '.git'), job }, reservation);
      if (state === 'alive') held = await takeResource({ name: HANDOFF_DISPATCHER_RESOURCE, capacity: 1, scope: 'machine', agent: 'alive-fixture-dispatcher' });
    } finally {
      if (prior === undefined) delete process.env.PULLBOARD_MACHINE_HOME;
      else process.env.PULLBOARD_MACHINE_HOME = prior;
    }
  }
  let pid = process.pid;
  if (state !== 'alive') {
    const gone = runFixtureChild(process.execPath, ['-e', 'process.exit(0)'], { env: box.env, encoding: 'utf8' });
    assert.equal(gone.status, 0, gone.failure);
    pid = gone.pid;
    assert.equal(exactStart(pid), '', 'the recorded fixture process really exited');
  }
  writeFileSync(join(queue, 'dispatcher.json'), JSON.stringify({ pid, started: exactStart(pid) || 'exited fixture process' }));
  return { box, id, marker, queue, priorPid: pid };
}

for (const command of ['next', 'status', 'show']) {
  for (const state of ['dead', 'alive', 'empty']) {
    test(`clause ${state === "dead" ? 1 : 2}: ${command} recovers only a dead dispatcher with queued launches (${state}) [C7]`, async t => {
      const f = await fixture(t, state);
      const result = f.box.run(f.box.web, command, ...(command === 'show' ? [String(f.id)] : []));
      assert.equal(result.code, 0, result.err + result.out);
      if (state === 'dead') {
        await waitForCondition(() => existsSync(f.marker), `${command} started the captured dispatcher`);
        const starts = readFileSync(f.marker, 'utf8').trim().split('\n').map(Number);
        assert.equal(starts.length, 1, 'one dispatcher is launched');
        const receipt = JSON.parse(readFileSync(join(f.queue, 'dispatcher.json'), 'utf8'));
        assert.equal(receipt.pid, starts[0]);
        assert.notEqual(receipt.pid, f.priorPid);
        assert.ok(receipt.started, 'the new process incarnation is recorded');
        const repeated = f.box.run(f.box.web, command, ...(command === 'show' ? [String(f.id)] : []));
        assert.equal(repeated.code, 0, repeated.err + repeated.out);
        assert.equal(readFileSync(f.marker, 'utf8').trim().split('\n').length, 1, 'another command does not duplicate the live dispatcher');
      } else {
        assert.equal(existsSync(f.marker), false, 'an alive dispatcher or an empty launch queue starts nothing');
        assert.equal(JSON.parse(readFileSync(join(f.queue, 'dispatcher.json'), 'utf8')).pid, f.priorPid);
      }
    });
  }
}
