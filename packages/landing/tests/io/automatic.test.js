/** @pullboard-test-input apps/cli/src/io/landing/automatic.js */
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
import { scheduleAutomaticLanding } from '../../index.js';
import { resumeAutomaticLanding } from '../../index.js';
import { recoverAutomaticLanding } from '../../index.js';
import { automaticLandingDirectory } from '../../index.js';
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
