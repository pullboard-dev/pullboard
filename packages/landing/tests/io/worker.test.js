/** @pullboard-test-input apps/cli/src/io/landing/automatic.js packages/landing/index.js */
/** A landing inside a runner's job sizes its shards from that runner's pool, and landings started together coalesce [B35,B3,R3]. */
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { mkdirSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import { rmSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { runFixtureChildAsync } from '../../../../apps/cli/tests/fixtures/child.js';
import { runFixtureGit } from '../../../../apps/cli/tests/fixtures/child.js';
import { executionServices } from '../../../../apps/cli/tests/fixtures/gate/execution.js';
import { takeResource } from '../../../resources/index.js';
import { withGateSlot } from '../../../gate/index.js';
import { automaticLandingDirectory } from '../../index.js';
import { resumeAutomaticLanding } from '../../index.js';
import { scheduleAutomaticLanding } from '../../index.js';

const WORKER = new URL('../../../../apps/cli/src/io/landing/automatic.js', import.meta.url);
const SCHEDULER = new URL('../../index.js', import.meta.url);

/** A private real repository and machine home; the machine home stands in for one runner's own ~/.pullboard. */
function machine(t, settings) {
  const dir = mkdtempSync(join(tmpdir(), 'pullboard-worker-capacity-'));
  const repo = join(dir, 'repo'), home = join(dir, 'machine');
  mkdirSync(repo);
  mkdirSync(home);
  runFixtureGit(['init', '-q', '-b', 'main'], { cwd: repo });
  writeFileSync(join(repo, 'README.md'), 'fixture\n');
  runFixtureGit(['add', '-A'], { cwd: repo });
  runFixtureGit(['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.com', 'commit', '-q', '-m', 'chore: fixture'], { cwd: repo });
  writeFileSync(join(home, 'settings.json'), JSON.stringify(settings));
  const previous = process.env.PULLBOARD_MACHINE_HOME;
  process.env.PULLBOARD_MACHINE_HOME = home;
  t.after(() => {
    if (previous === undefined) delete process.env.PULLBOARD_MACHINE_HOME;
    else process.env.PULLBOARD_MACHINE_HOME = previous;
    rmSync(dir, { recursive: true, force: true });
  });
  return { repo, home };
}

/** The job a remote landing machine dispatched holds one slot of the runner's recorded nine, with six browser slots. */
function runnerJob(box) {
  return takeResource({ name: 'gate', capacity: 9, browserCapacityProvider: () => 6, browser: true, scope: 'machine',
    root: box.repo, repo: box.repo, agent: 'pullboard-ssh-landing-job', kind: 'landing', landing: true });
}

/** A landing shard's own admission, exactly as the landing reshard takes it on that machine. */
function shard(box, browser) {
  return withGateSlot(box.repo, async lease => ({ capacity: lease.capacity, browser: lease.browser }),
    { executionServices, landing: true, remote: false, browser, kind: 'landing', agent: 'landing-shard', item: 'shard 2/6' });
}

test('a landing shard inside a runner job takes that runner\'s recorded gate and browser capacity [B35,B3,R3]', async t => {
  const box = machine(t, { gate: { browserByLaunch: true } });
  const job = await runnerJob(box);
  try {
    assert.deepEqual(await shard(box, false), { capacity: 9, browser: false }, 'no RESOURCE_CAPACITY_MISMATCH against the runner pool');
    assert.deepEqual(await shard(box, true), { capacity: 9, browser: true }, 'a browser shard uses the recorded browser capacity too');
  } finally { job.release(); }
});

test('a declared slot count still refuses a pool sized differently [B35,B3]', async t => {
  const box = machine(t, { gateSlots: 4, browserSlots: 1 });
  const job = await runnerJob(box);
  try {
    await assert.rejects(shard(box, false), error => error.code === 'RESOURCE_CAPACITY_MISMATCH', 'an explicit setting is never silently replaced');
  } finally { job.release(); }
});

/** Read this fixture's private pending wake record. */
function pending(root) {
  const file = join(automaticLandingDirectory(root), 'pending.json');
  return existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : null;
}

/** Schedule from a separate process, as an accept made in another checkout does. */
async function acceptElsewhere(root) {
  const source = `import { scheduleAutomaticLanding } from ${JSON.stringify(SCHEDULER.href)};\n`
    + `await scheduleAutomaticLanding(${JSON.stringify(root)}, new Date().toISOString(), new URL(${JSON.stringify(WORKER.href)}), { schedule: async () => {} });\n`;
  const result = await runFixtureChildAsync(process.execPath, ['--input-type=module', '-e', source], { cwd: root, env: process.env });
  assert.equal(result.status, 0, result.context);
}

test('two landings triggered at once produce one landing run, and a mid-landing accept lands in the same worker [B35,B3,R3]', async t => {
  const box = machine(t, { gate: { browserByLaunch: true } });
  const schedule = async () => {};
  const now = new Date().toISOString();
  await Promise.all([scheduleAutomaticLanding(box.repo, now, WORKER, { schedule }), scheduleAutomaticLanding(box.repo, now, WORKER, { schedule })]);
  const wakes = pending(box.repo);
  let active = 0, peak = 0, runs = 0, release, started;
  const holding = new Promise(resolve => { release = resolve; });
  const begun = new Promise(resolve => { started = resolve; });
  /** One landing run; the first holds until a second wake and a later accept have both arrived. */
  const land = async () => {
    active++; peak = Math.max(peak, active); runs++;
    started();
    try { if (runs === 1) await holding; } finally { active--; }
  };
  const first = resumeAutomaticLanding(box.repo, 'fixture-wake-1', wakes.dueAt, land, { wait: async () => true });
  await begun;
  // A second wake while the first landing runs leaves the record to it instead of starting another landing.
  assert.equal(await resumeAutomaticLanding(box.repo, 'fixture-wake-2', wakes.dueAt, land, { wait: async () => true }), false);
  await acceptElsewhere(box.repo);
  assert.equal(pending(box.repo).running?.pid, process.pid, 'the newer accept keeps the running landing\'s custody');
  release();
  assert.equal(await first, true);
  assert.equal(runs, 2, 'the two wakes ran once, and the mid-landing accept ran once after it');
  assert.equal(peak, 1, 'no two landings ever ran at the same time');
  assert.equal(pending(box.repo), null, 'nothing is left pending');
});
