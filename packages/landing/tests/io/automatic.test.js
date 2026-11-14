/** @pullboard-test-input apps/cli/src/io/landing/automatic.js */
/** @pullboard-world-pin: the #6817 case reads the committed tree, where no source outside the scheduler may call it. */
/** Deferred landing has durable, authenticated custody independent of a third acceptance [B35,B3,R3]. */
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { rmSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { test } from 'node:test';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import * as landing from '../../index.js';
import * as scheduler from '../../src/io/automatic/scheduler.js';
import { scheduleAutomaticLanding } from '../../src/io/automatic/scheduler.js';
import { resumeAutomaticLanding } from '../../src/io/automatic/scheduler.js';
import { recoverAutomaticLanding } from '../../src/io/automatic/scheduler.js';
import { automaticLandingDirectory } from '../../src/io/automatic/scheduler.js';
import { runFixtureGit } from '../../../../apps/cli/tests/fixtures/child.js';

/** An isolated real Git repository gives each private pending record its actual common directory. */
function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'pullboard-automatic-wake-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  runFixtureGit(['init', '-q'], { cwd: root });
  return root;
}

const worker = new URL('../../../../apps/cli/src/io/landing/automatic.js', import.meta.url);
const dueAt = '2099-01-01T00:00:00.000Z';

/** Read only this fixture's private wake record; it is not a board proof receipt. */
function pending(root) { return JSON.parse(readFileSync(join(automaticLandingDirectory(root), 'pending.json'), 'utf8')); }

test('a deferred acceptance persists one wake and resumes once without another acceptance [B35,B3,R3]', async t => {
  const root = fixture(t), timers = [];
  const job = await scheduleAutomaticLanding(root, dueAt, worker, { schedule: async (...args) => timers.push(args) });
  assert.equal(timers.length, 1);
  assert.equal(pending(root).id, job.id);
  assert.equal(pending(root).dueAt, dueAt);
  let runs = 0;
  await resumeAutomaticLanding(root, 'fixture-token', dueAt, async actual => { assert.equal(actual, root); runs++; }, { wait: async () => true });
  assert.equal(runs, 1);
  assert.equal(existsSync(join(automaticLandingDirectory(root), 'pending.json')), false);
});

test('an unauthenticated wake cannot run landing or consume its pending work [B35,B3,R3]', async t => {
  const root = fixture(t);
  const job = await scheduleAutomaticLanding(root, dueAt, worker, { schedule: async () => {} });
  let runs = 0;
  assert.equal(await resumeAutomaticLanding(root, 'wrong-token', dueAt, async () => { runs++; }, { wait: async () => false }), false);
  assert.equal(runs, 0);
  assert.equal(pending(root).id, job.id);
});

test('an early wake retains a newer deferral, and a failed callback retains recoverable work [B35,B3,R3]', async t => {
  const root = fixture(t), schedule = async () => {};
  const first = await scheduleAutomaticLanding(root, dueAt, worker, { schedule });
  await resumeAutomaticLanding(root, 'fixture-token', dueAt, async () => {
    assert.equal(await recoverAutomaticLanding(root, worker), false, 'active native landing keeps its custody');
    await scheduleAutomaticLanding(root, dueAt, worker, { schedule });
  }, { wait: async () => true });
  assert.notEqual(pending(root).id, first.id);
  await assert.rejects(resumeAutomaticLanding(root, 'fixture-token', dueAt, async () => { throw new Error('native admission unavailable'); }, { wait: async () => true }), /native admission unavailable/u);
  assert.match(pending(root).error, /native admission unavailable/u);
});

// Moved from packages/sentinels/tests/liveness.test.js: the scheduler's own recovery, imported from its own cell.
test('clause 1, clause 2: a dead landing worker mid-batch is replaced and the adoption names its pid and the gap [C7]', async t => {
  const root = fixture(t), schedule = async () => {}, timers = [];
  await scheduleAutomaticLanding(root, dueAt, worker, { schedule });
  const file = join(automaticLandingDirectory(root), 'pending.json');
  const gone = 4194301;
  writeFileSync(file, JSON.stringify({ ...pending(root), running: { pid: gone, started: 'Mon Jan  1 00:00:00 2001', at: new Date(Date.now() - 100_000).toISOString() } }));
  assert.equal(await recoverAutomaticLanding(root, worker, { schedule: async (...args) => timers.push(args) }), true);
  assert.equal(timers.length, 1, 'a replacement wake is scheduled by the sweep');
  assert.equal(pending(root).adopted.pid, gone);
  assert.ok(pending(root).adopted.gapSeconds >= 100, 'the unattended gap is recorded in seconds');
  assert.equal(pending(root).running, undefined, 'the dead worker no longer holds custody');
  let seen;
  await resumeAutomaticLanding(root, 'fixture-token', dueAt, async (_root, _wake, adopted) => { seen = adopted; }, { wait: async () => true });
  assert.equal(seen.pid, gone, 'the replacement receives the adoption to record on the batch');
});


test('#6817 clauses 1-2: index.js exports nothing from the scheduler and no source outside it calls its timer, owner or wake [C7,#6817]', () => {
  const exported = Object.keys(scheduler).filter(name => landing[name] === scheduler[name]);
  assert.deepEqual(exported, []);
  const root = fileURLToPath(new URL('../../../../', import.meta.url));
  const names = ['scheduleAutomaticLanding', 'resumeAutomaticLanding', 'recoverAutomaticLanding', 'mainLandingWorker'];
  let found = '';
  try { found = execFileSync('git', ['grep', '-l', '-w', ...names.flatMap(name => ['-e', name]), '--', '*.js'], { cwd: root, encoding: 'utf8' }); }
  catch (error) { if (error.status !== 1) throw error; }
  const callers = found.split('\n').filter(Boolean)
    .filter(file => file !== 'packages/landing/src/io/automatic/scheduler.js' && !/(^|\/)(tests|journeys)\//u.test(file) && !file.endsWith('.test.js'));
  assert.deepEqual(callers, []);
});
