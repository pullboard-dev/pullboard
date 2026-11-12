/** @pullboard-test-input apps/cli/src/io/landing/automatic.js apps/cli/tests/fixtures/child.js packages/landing/index.js */
/** A waiting lander whose code is older than main's releases its place, names the change and hands over to a fresh lander [C7,#3467]. */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  after,
  test,
} from 'node:test';
import { createE2eHelpers } from '../../../tests/fixtures/e2e.js';
import { onBoard } from '../../../tests/fixtures/land/board.js';
import { runFixtureChild } from '../../../tests/fixtures/child.js';
import { makeLandProjectFixtures } from '../../../tests/fixtures/land/project.js';
import { waitForCondition } from '../../../tests/fixtures/runner/holders.js';
import * as store from '../../../../../packages/store/index.js';
import { automaticLandingDirectory } from '../../../../../packages/landing/index.js';
import { staleLanderReason } from '../../../src/io/landing/automatic.js';

const e2e = createE2eHelpers();
after(e2e.cleanup);
const { sandbox, project, commitFile } = e2e;
const { landProject, itemWorktree, submitItem, acceptItem } = makeLandProjectFixtures({ sandbox, project, commitFile });

/** The fixture's stand-in for the lander's own code; the real watch reads apps/cli/src/io/landing/automatic.js and packages/landing. */
const LANDER_FILE = 'packages/landing/lander.js';

/** Read one of the fixture's private wake records, or null. */
function record(box, name = 'pending.json') {
  const file = join(automaticLandingDirectory(box.repo), name);
  return existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : null;
}

/** True while a process id runs on this machine. */
function alive(pid) {
  try { process.kill(pid, 0); return true; } catch (error) { return error.code === 'EPERM'; }
}

/** Stop the fixture's detached landers and timers. */
function stopLanders(box) {
  for (const name of ['pending.json', 'timer.json']) {
    const saved = record(box, name);
    for (const pid of [saved?.pid, saved?.running?.pid]) {
      if (!Number.isSafeInteger(pid) || pid === process.pid) continue;
      try { process.kill(pid, 'SIGKILL'); } catch { /* already gone */ }
    }
  }
}

/** Commit one version of the fixture's lander code on the trunk and return its commit. */
function landerCode(box, text) {
  mkdirSync(join(box.repo, 'packages', 'landing'), { recursive: true });
  writeFileSync(join(box.repo, LANDER_FILE), text);
  box.git(box.repo, 'add', LANDER_FILE);
  box.git(box.repo, 'commit', '-q', '-m', 'chore: change the fixture lander code');
  return box.git(box.repo, 'rev-parse', 'HEAD');
}

test('a stale lander reason names both code commits and fits the landing_lease event [C7,#3467]', () => {
  const loaded = 'a'.repeat(40), current = 'b'.repeat(40);
  const reason = staleLanderReason(loaded, current);
  assert.match(reason, /^lander code a{12} is older than main's b{12} \(apps\/cli\/src\/io\/landing\/automatic\.js, packages\/landing\)$/u);
  assert.ok(reason.length <= 120, 'the lease event keeps 120 characters of a reason');
  assert.equal(staleLanderReason(loaded, loaded), null, 'the same code is not stale');
  assert.equal(staleLanderReason(null, current), null, 'a lander that cannot read its code never hands over on a guess');
  assert.equal(staleLanderReason(loaded, null), null);
});

test('clause 1 and clause 2: a waiting lander started before main changed its code releases its place naming the change and a fresh lander takes over and lands [C7,#3467]', { timeout: 300_000 }, async t => { // budget: one real submit, a 30 s code watch, a real replacement lander and its landing; hang ceiling only.
  const box = landProject();
  t.after(() => stopLanders(box));
  const path = join(box.repo, 'pullboard.json');
  const config = JSON.parse(readFileSync(path, 'utf8'));
  writeFileSync(path, JSON.stringify({ ...config, landing: { ...config.landing, manualOverride: false } }, null, 2));
  box.git(box.repo, 'add', 'pullboard.json');
  box.git(box.repo, 'commit', '-q', '-m', 'chore: the board lands accepted items');
  const loaded = landerCode(box, '// lander code the running lander loaded\n');
  const entry = itemWorktree(box, 1);
  submitItem(box, entry);
  acceptItem(box, entry);
  // A live holder keeps the trunk, so the lander under test waits in line without a landing lease.
  const branch = box.git(box.repo, 'symbolic-ref', 'HEAD');
  const token = randomUUID();
  const held = onBoard(box, board => store.landingLeaseMove(board, { agentId: 'coordinator', action: 'request', token, branch, pid: process.pid }));
  assert.equal(held.acquired, true);
  let released = false;
  const releaseHolder = () => {
    if (released) return;
    released = true;
    onBoard(box, board => store.landingLeaseMove(board, { agentId: 'coordinator', action: 'release', token, generation: held.generation }));
  };
  t.after(releaseHolder);

  // The lander resumes its own wake exactly as its timer would, through runLandingWake with the real landing and the
  // real 30 s watch; only where it reads its code is the fixture's. Main changes that code after it loaded.
  const source = [
    `import { runLandingWake, landingWakeMarks } from ${JSON.stringify(pathToFileURL(join(import.meta.dirname, '../../../src/io/landing/automatic.js')).href)};`,
    `import { resumeAutomaticLanding, scheduleAutomaticLanding } from ${JSON.stringify(pathToFileURL(join(import.meta.dirname, '../../../../../packages/landing/index.js')).href)};`,
    `import { runFixtureGit } from ${JSON.stringify(pathToFileURL(join(import.meta.dirname, '../../../tests/fixtures/child.js')).href)};`,
    "import { writeFileSync } from 'node:fs'; import { join } from 'node:path'; import { randomUUID } from 'node:crypto';",
    'const { root, file, worker } = JSON.parse(process.argv[1]);',
    "const codeCommit = () => runFixtureGit(['log', '-1', '--format=%H', 'HEAD', '--', 'apps/cli/src/io/landing/automatic.js', 'packages/landing'], { cwd: root }) || null;",
    'const job = await scheduleAutomaticLanding(root, new Date().toISOString(), new URL(worker), { schedule: async () => {} });',
    'const loaded = codeCommit();',
    "writeFileSync(join(root, file), '// lander code main has now\\n');",
    "runFixtureGit(['add', file], { cwd: root }); runFixtureGit(['commit', '-q', '-m', 'chore: main changes the lander code'], { cwd: root });",
    'const changed = codeCommit(); const changedAt = Date.now(); let result = null;',
    'const ok = await resumeAutomaticLanding(root, randomUUID(), job.dueAt, async (actual, options) => {',
    '  result = await runLandingWake(actual, { ...options, codeCommit, loaded });',
    '  return result;',
    '}, { wait: async () => true, marks: landingWakeMarks });',
    'console.log("RESULT " + JSON.stringify({ ok, loaded, changed, changedAt, endedAt: Date.now(), pid: process.pid, result: result && { ...result, workerUrl: String(result.workerUrl) } }));',
    'process.exit(0);',
  ].join('\n');
  const run = runFixtureChild(process.execPath, ['--input-type=module', '-e', source,
    JSON.stringify({ root: box.repo, file: LANDER_FILE, worker: pathToFileURL(join(import.meta.dirname, '../../../src/io/landing/automatic.js')).href })],
  { cwd: box.repo, env: { ...box.env }, encoding: 'utf8' });
  assert.equal(run.status, 0, `${run.failure ?? run.stderr}\n${run.stdout}`);
  const lander = JSON.parse(run.stdout.split('\n').find(line => line.startsWith('RESULT ')).slice('RESULT '.length));
  assert.equal(lander.loaded, loaded, 'the lander loaded the code main had when it started');
  assert.notEqual(lander.changed, loaded, 'main then changed the lander code');
  const reason = staleLanderReason(loaded, lander.changed);
  assert.equal(lander.result?.handover, reason, JSON.stringify(lander.result));
  assert.ok(lander.result.reloadAt, 'the lander hands over to a fresh worker');
  assert.ok(lander.endedAt - lander.changedAt < 120_000, `released ${lander.endedAt - lander.changedAt} ms after main changed its code`);

  // Clause 2: the exit wrote a landing_lease release whose reason names the code change, and its place is gone.
  const leases = onBoard(box, board => store.events(board)).filter(event => event.event_kind === 'landing_lease')
    .map(event => JSON.parse(event.event_detail));
  const release = leases.findLast(detail => detail.action === 'release' && typeof detail.reason === 'string');
  assert.equal(release?.reason, reason, JSON.stringify(leases.slice(-4)));
  assert.ok(release.reason.includes(lander.changed.slice(0, 12)) && release.reason.includes(loaded.slice(0, 12)));
  const queue = onBoard(box, board => store.landingLeaseState(board));
  assert.equal(queue.holder?.token, token, 'the live holder keeps the trunk');
  assert.equal(queue.line.some(row => row.pid === lander.pid), false, 'the stale lander left the line');

  // Clause 1: a new lander process takes over and, once the trunk is free, lands the waiting item.
  let pending = null;
  await waitForCondition(() => (pending = record(box))?.running?.pid && pending.running.pid !== lander.pid && alive(pending.running.pid),
    'a fresh lander process resumes the wake', { signal: AbortSignal.timeout(60_000), state: () => ({ pending: record(box), timer: record(box, 'timer.json') }) });
  releaseHolder();
  await waitForCondition(() => onBoard(box, board => store.getItem(board, entry.item))?.item_merged_commit,
    'the fresh lander lands the waiting item', { signal: AbortSignal.timeout(150_000), state: () => ({ pending: record(box), item: onBoard(box, board => store.getItem(board, entry.item)) }) });
});
