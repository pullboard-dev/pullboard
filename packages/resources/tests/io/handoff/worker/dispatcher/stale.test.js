/** The dispatcher drops a dead gate's tickets on its first refusal, never waits behind a live reservation, and records idle spans [C7,#5727]. */
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdirSync } from 'node:fs';
import { readdirSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import { realpathSync } from 'node:fs';
import { rmSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { Refused } from '../../../../../../kernel/index.js';
import { drainHandoffQueue } from '../../../../../index.js';
import { handoffDispatcherIdleLog } from '../../../../../index.js';
import { handoffDispatcherLog } from '../../../../../index.js';
import { handoffQueueDirectory } from '../../../../../index.js';
import { HANDOFF_WORKER_RESOURCE } from '../../../../../index.js';
import { queueHandoffLaunch } from '../../../../../index.js';
import { reserveHandoffTicket } from '../../../../../index.js';
import { takeResource } from '../../../../../index.js';
import { temporaryDirectory } from '../../../../../../../apps/cli/tests/fixtures/board.js';
import { waitForCondition } from '../../../../../../../apps/cli/tests/fixtures/runner/holders.js';

/** A real worker that records its job directory name and exits at once. */
const WORKER = `const { appendFileSync } = require('node:fs');
const { basename, dirname } = require('node:path');
appendFileSync(process.env.HANDOFF_TEST_LOG, basename(dirname(process.argv[2])) + '\\n');
`;

/** A private machine home and a captured tools tree holding the stand-in worker. */
function fixture(t) {
  const dir = realpathSync(temporaryDirectory('pullboard-dispatcher-stale-'));
  const tools = join(dir, 'tools');
  mkdirSync(join(tools, 'apps/cli/src/io/gate'), { recursive: true });
  writeFileSync(join(tools, 'apps/cli/src/io/gate/drive.js'), WORKER);
  const log = join(dir, 'log');
  writeFileSync(log, '');
  const saved = { home: process.env.PULLBOARD_MACHINE_HOME, log: process.env.HANDOFF_TEST_LOG };
  process.env.PULLBOARD_MACHINE_HOME = join(dir, 'home');
  process.env.HANDOFF_TEST_LOG = log;
  t.after(() => {
    for (const [key, value] of [['PULLBOARD_MACHINE_HOME', saved.home], ['HANDOFF_TEST_LOG', saved.log]]) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    rmSync(dir, { recursive: true, force: true });
  });
  return { dir, tools, log };
}

/** Fill a reserved place with a launch for a job directory named after the job. */
function fill(box, id, reservation) {
  const directory = join(box.dir, 'jobs', id);
  mkdirSync(directory, { recursive: true });
  writeFileSync(join(directory, 'request.json'), JSON.stringify({ job: id }) + '\n');
  queueHandoffLaunch({ directory, tools: box.tools, commonDir: box.dir, job: id }, reservation);
}

/** Queue one launch ticket for a job, as a submit or a worker-gone requeue does. */
async function queueJob(box, id) { fill(box, id, await reserveHandoffTicket(id)); }

/** The jobs the stand-in worker started so far. */
function launched(box) { return readFileSync(box.log, 'utf8').split('\n').filter(Boolean); }

/** The tickets in line, reserved or filled. */
function tickets() { return existsSync(handoffQueueDirectory()) ? readdirSync(handoffQueueDirectory()).filter(name => /^\d+-.+\.(json|reserved)$/u.test(name)) : []; }

/** The dispatcher log text, empty before its first line. */
function dispatcherLog() { return existsSync(handoffDispatcherLog()) ? readFileSync(handoffDispatcherLog(), 'utf8') : ''; }

/** The recorded idle spans. */
function idleSpans() { return existsSync(handoffDispatcherIdleLog()) ? readFileSync(handoffDispatcherIdleLog(), 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line)) : []; }

/** An admission that refuses GATE_STALE for the named jobs and counts every admit and unstarted record. */
function staleAdmission(dead) {
  const seen = { admit: [], unstarted: [] };
  return {
    seen,
    admission: {
      admit(launch) { seen.admit.push(launch.job); if (dead.has(launch.job)) throw Object.assign(new Error(`gate ${launch.job} no longer serves its item; it is not started`), { code: 'GATE_STALE' }); },
      spawned() {},
      unstarted(launch, reason) { seen.unstarted.push(`${launch.job} ${reason.code}`); },
      entry: null,
    },
  };
}

test('clause 1: a gate that no longer serves its item is refused once; its other tickets and every later requeue are dropped unstarted [C7,#5727]', async t => {
  const box = fixture(t);
  const { seen, admission } = staleAdmission(new Set(['dead']));
  // Three tickets for one dead job, as the worker-gone sweep requeued it, and one live gate behind them.
  await queueJob(box, 'dead');
  await queueJob(box, 'dead');
  await queueJob(box, 'dead');
  await queueJob(box, 'live');
  assert.deepEqual((await drainHandoffQueue({ capacity: 2, pollMs: 20, admission })).started, ['live']);
  assert.deepEqual(seen.admit.filter(job => job === 'dead'), ['dead'], 'the dead gate was offered for admission once');
  assert.deepEqual(seen.unstarted, ['dead GATE_STALE'], 'its one refusal ended it unstarted once');
  assert.deepEqual(tickets(), [], 'no ticket of the dead gate is left in line');
  // A requeue of the same dead job, by a later sweep, is dropped by a fresh drain without a slot or an admission.
  await queueJob(box, 'dead');
  await queueJob(box, 'later');
  assert.deepEqual((await drainHandoffQueue({ capacity: 2, pollMs: 20, admission })).started, ['later']);
  assert.deepEqual(seen.admit.filter(job => job === 'dead'), ['dead'], 'the requeued dead gate was never admitted again');
  assert.deepEqual(launched(box), ['live', 'later']);
  assert.match(dispatcherLog(), /dropped: its gate no longer serves its item/u);
});

test('clause 2: a live reservation at the head of the line never holds back a later ticket; it starts once its submit fills it [C7,#5727]', async t => {
  const box = fixture(t);
  const slow = await reserveHandoffTicket('slow');
  await queueJob(box, 'fast');
  const drained = drainHandoffQueue({ capacity: 2, pollMs: 20 });
  await waitForCondition(() => launched(box).includes('fast'), 'the ticket behind a live reservation launched', { signal: t.signal });
  assert.deepEqual(launched(box), ['fast'], 'the reservation itself has nothing to launch yet');
  fill(box, 'slow', slow);
  assert.deepEqual((await drained).started, ['fast', 'slow']);
});

test('clause 2: the watchdog counts live tickets only and an idle span with free slots is recorded; a full pool is never idle [C7,#5727]', async t => {
  const box = fixture(t);
  const { admission } = staleAdmission(new Set(['dead']));
  await queueJob(box, 'dead');
  assert.deepEqual((await drainHandoffQueue({ capacity: 1, pollMs: 20, admission })).started, []);
  assert.deepEqual(idleSpans(), [], 'a pass that refused a dead gate and then had nothing live is not idle');
  // Five requeues of the dead gate and one live gate; the slot pool fails until the test lets it recover.
  for (let index = 0; index < 5; index++) await queueJob(box, 'dead');
  await queueJob(box, 'live');
  let broken = true;
  const takeSlot = options => { if (broken) throw new Refused('SLOT_DB_LOCKED', 'the slot database stayed locked'); return takeResource(options); };
  const drained = drainHandoffQueue({ capacity: 1, pollMs: 20, stallMs: 300, takeSlot, admission });
  await waitForCondition(() => /no worker launched for \d+s with 1 queued and cap 1; last slot error SLOT_DB_LOCKED/u.test(dispatcherLog()), 'the stall names the one live ticket', { signal: t.signal });
  broken = false;
  assert.deepEqual((await drained).started, ['live']);
  const spans = idleSpans();
  assert.equal(spans.length, 1, 'one idle span from the first failed pass to the launch');
  assert.equal(spans[0].live, 1);
  assert.equal(spans[0].cap, 1);
  assert.equal(spans[0].lastError, 'SLOT_DB_LOCKED');
  assert.ok(spans[0].ms >= 300, `the span covers the stall: ${spans[0].ms} ms`);
  assert.equal(Date.parse(spans[0].to) - Date.parse(spans[0].from), spans[0].ms);
  // Every slot held by another worker: the line waits, but the dispatcher is not idle and logs no stall.
  const holder = await takeResource({ name: HANDOFF_WORKER_RESOURCE, capacity: 1, scope: 'machine', agent: 'other-worker' });
  await queueJob(box, 'queued');
  const before = dispatcherLog();
  let full = 0;
  const counted = async options => { try { return await takeResource(options); } catch (error) { if (error.code === 'HANDOFF_WORKERS_FULL') full += 1; throw error; } };
  const startedAt = Date.now();
  const waiting = drainHandoffQueue({ capacity: 1, pollMs: 20, stallMs: 100, takeSlot: counted });
  // Passes past twice the stall time, each one refused a slot by the full pool.
  await waitForCondition(() => full >= 5 && Date.now() - startedAt >= 250, 'the dispatcher met a full pool on passes past the stall time', { signal: t.signal });
  assert.deepEqual(launched(box), ['live'], 'nothing launched while every slot was held');
  assert.equal(dispatcherLog().slice(before.length).includes('no worker launched'), false, 'a full pool logs no stall');
  holder.release();
  assert.deepEqual((await waiting).started, ['queued']);
  assert.equal(idleSpans().length, 1, 'waiting on a full pool records no idle span');
});
