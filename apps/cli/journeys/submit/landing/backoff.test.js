/** @pullboard-test-input apps/cli/src/io/landing/automatic.js apps/cli/tests/fixtures/child.js packages/landing/index.js */
/** An idle lander backs off 60 s doubling to 5 minutes, and an accept, a green gate or a held-test commit wakes it at once [C7]. */
import assert from 'node:assert/strict';
import {
  createHash,
  randomUUID,
} from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import {
  dirname,
  join,
} from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  after,
  test,
} from 'node:test';
import { createE2eHelpers } from '../../../tests/fixtures/e2e.js';
import { onBoard } from '../../../tests/fixtures/land/board.js';
import { runFixtureChild } from '../../../tests/fixtures/child.js';
import { makeLandProjectFixtures } from '../../../tests/fixtures/land/project.js';
import {
  fileFixtureItem,
  joinFixtureSeat,
} from '../../../tests/fixtures/testkit.js';
import { waitForCondition } from '../../../tests/fixtures/runner/holders.js';
import * as store from '../../../../../packages/store/index.js';
import { automaticLandingDirectory } from '../../../../../packages/landing/index.js';

const e2e = createE2eHelpers();
after(e2e.cleanup);
const { sandbox, project, commitFile } = e2e;
const { landProject, itemWorktree, submitItem, acceptItem } = makeLandProjectFixtures({ sandbox, project, commitFile });

/** The test file whose recorded defect holds the fixture trunk. */
const HELD = 'web/held.test.js';
// The fixture runner reads RED and NAME: from the file text, so the held case is red for real when landing measures it (#3719).
const HELD_TEXT = "// RED NAME:held-case\nimport test from 'node:test'; test('held case', () => {});\n";

/** Read one of the fixture's private wake records, or null. */
function record(box, name = 'pending.json') {
  const file = join(automaticLandingDirectory(box.repo), name);
  return existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : null;
}

/** The landing lease requests the fixture board recorded, oldest first. */
function leaseRequests(box) {
  return onBoard(box, board => store.events(board)).filter(event => event.event_kind === 'landing_lease')
    .map(event => ({ ...JSON.parse(event.event_detail), at: event.event_at })).filter(detail => detail.action === 'request');
}

/** Stop the fixture's detached landers and timers, leaving their records as a crash would. */
function stopLanders(box) {
  for (const name of ['pending.json', 'timer.json']) {
    const saved = record(box, name);
    for (const pid of [saved?.pid, saved?.running?.pid]) {
      if (!Number.isSafeInteger(pid) || pid === process.pid) continue;
      try { process.kill(pid, 'SIGKILL'); } catch { /* already gone */ }
    }
  }
}

/** Run a real command on the trunk checkout; its post-command step is what wakes or recovers the lander. */
function command(box, ...args) {
  const result = box.run(box.repo, ...args);
  assert.equal(result.code, 0, result.out + result.err);
  return result;
}

/**
 * A real project with a recorded landing test defect on web/held.test.js, automatic landing on and one accepted item
 * waiting under a hold, so every real landing on it moves nothing. A defect no longer holds the trunk [C7,#5862].
 */
function heldTrunk(t) {
  const box = landProject();
  t.after(() => stopLanders(box));
  const entry = itemWorktree(box, 1);
  submitItem(box, entry);
  acceptItem(box, entry);
  mkdirSync(dirname(join(box.repo, HELD)), { recursive: true });
  writeFileSync(join(box.repo, HELD), HELD_TEXT);
  box.git(box.repo, 'add', HELD);
  box.git(box.repo, 'commit', '-q', '-m', 'test: add the fixture test the defect holds');
  const blob = box.git(box.repo, 'rev-parse', `HEAD:${HELD}`);
  onBoard(box, board => store.recordLandingTestDefect(board, { agentId: 'coordinator', test: HELD,
    hash: createHash('sha256').update(HELD_TEXT).digest('hex'), blob, trunkBlob: blob, names: ['held-case'], lane: 'web',
    batchId: randomUUID(), branch: box.git(box.repo, 'symbolic-ref', 'HEAD') }));
  command(box, 'hold', String(entry.item), '--reason', 'the fixture keeps one accepted item waiting');
  const path = join(box.repo, 'pullboard.json');
  const config = JSON.parse(readFileSync(path, 'utf8'));
  writeFileSync(path, JSON.stringify({ ...config, landing: { ...config.landing, manualOverride: false } }, null, 2));
  box.git(box.repo, 'add', 'pullboard.json');
  box.git(box.repo, 'commit', '-q', '-m', 'chore: the board lands accepted items');
  return { box, entry };
}

/** What the wake left behind, so a lander that never backs off names the record, the timer and its own log. */
function wakeState(box) {
  const log = join(automaticLandingDirectory(box.repo), 'worker.log');
  return JSON.stringify({ pending: record(box), timer: record(box, 'timer.json'), leases: leaseRequests(box).length,
    log: existsSync(log) ? readFileSync(log, 'utf8').slice(-1500) : null });
}

/** Let a real command wake the real lander on the held trunk, and wait until it refuses and backs off. */
async function backingOff(box) {
  command(box, 'list');
  // One read per poll: the lander and the commands rewrite the record, so a second read can see a newer one.
  let pending = null;
  await waitForCondition(() => (pending = record(box))?.backoff?.outcome === 'NOTHING_TO_LAND',
    'the woken lander lands nothing and backs off', { signal: AbortSignal.timeout(90_000), state: () => wakeState(box) });
  return { pending, requests: leaseRequests(box).length };
}

/**
 * Wait for the woken lander to land `id`, and prove its landing lease was requested before the back-off it interrupted
 * would have ended: an attempt that waited the back-off out would have started after it.
 */
async function landsBefore(box, { pending, requests }, id, label) {
  await waitForCondition(() => onBoard(box, board => Boolean(store.getItem(board, id).item_merged_commit)), label,
    { signal: AbortSignal.timeout(120_000), state: () => record(box) });
  const woken = leaseRequests(box).slice(requests);
  assert.ok(woken.length > 0, 'the wake requested a new landing lease');
  assert.ok(Date.parse(woken[0].at) < Date.parse(pending.backoff.retryAt), `the next attempt started at ${woken[0].at}, before the back-off ended at ${pending.backoff.retryAt}`);
}

/**
 * Resume the crashed lander's own pending record in a child, exactly as its timer would, through runLandingWake with the
 * real landing, an injected clock and a recording wait. `commits` maps a poll number to a real trunk commit the wait
 * makes at that poll; `idle` replaces landing with one that moves nothing.
 */
function resumeLander(box, { commits = {}, idle = false, pollMs = 5000 } = {}) {
  stopLanders(box);
  const source = [
    `import { runLandingWake, landingWakeMarks } from ${JSON.stringify(pathToFileURL(join(import.meta.dirname, '../../../src/io/landing/automatic.js')).href)};`,
    `import { resumeAutomaticLanding, automaticLandingDirectory } from ${JSON.stringify(pathToFileURL(join(import.meta.dirname, '../../../../../packages/landing/index.js')).href)};`,
    `import { runFixtureGit } from ${JSON.stringify(pathToFileURL(join(import.meta.dirname, '../../../tests/fixtures/child.js')).href)};`,
    "import { existsSync, readFileSync, writeFileSync } from 'node:fs'; import { join } from 'node:path'; import { randomUUID } from 'node:crypto';",
    'const { root, commits, idle, pollMs } = JSON.parse(process.argv[1]);',
    'const read = name => { const file = join(automaticLandingDirectory(root), name); return existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : null; };',
    'const job = read("pending.json"); const start = Date.now(); let clock = start, polls = 0, result = null; const backoffs = [];',
    'const ok = await resumeAutomaticLanding(root, randomUUID(), job.dueAt, async (actual, options) => {',
    '  result = await runLandingWake(actual, { ...options, now: () => clock, pollMs, ...(idle ? { land: async () => {} } : {}),',
    '    onBackoff: async next => { backoffs.push(next); await options.onBackoff(next); },',
    '    wait: async ms => { clock += ms; polls += 1; const change = commits[polls];',
    '      if (change) { writeFileSync(join(root, change.file), change.text); runFixtureGit(["add", change.file], { cwd: root }); runFixtureGit(["commit", "-q", "-m", change.message], { cwd: root }); } } });',
    '  return result;',
    '}, { wait: async () => true, marks: landingWakeMarks });',
    'console.log("RESULT " + JSON.stringify({ ok, job, result: result && { ...result, workerUrl: String(result.workerUrl) }, polls, backoffs, start, clock, pending: read("pending.json"), timer: read("timer.json") }));',
  ].join('\n');
  const run = runFixtureChild(process.execPath, ['--input-type=module', '-e', source, JSON.stringify({ root: box.repo, commits, idle, pollMs })],
    { cwd: box.repo, env: { ...box.env }, encoding: 'utf8' });
  assert.equal(run.status, 0, `${run.failure ?? run.stderr}\n${run.stdout}`);
  return JSON.parse(run.stdout.split('\n').find(line => line.startsWith('RESULT ')).slice('RESULT '.length));
}

test('clause 1: a landing that moves nothing waits 60 s and doubles to 5 minutes while the outcome repeats [C7]', { timeout: 420_000 }, async t => { // budget: seven real idle landings in a private repo; hang ceiling, not speed.
  const { box } = heldTrunk(t);
  // The real lander, woken by a command, lands nothing once and backs off 60 s.
  const first = await backingOff(box);
  assert.equal(first.pending.backoff.backoffMs, 60_000);
  assert.deepEqual(Object.keys(first.pending.backoff.marks.held), [HELD], 'the back-off watches the held test file');
  assert.equal(first.pending.dueAt, first.pending.backoff.retryAt, 'the pending wake is due when the back-off ends');
  // A lander that dies while backing off is restarted by the next command at its backed-off time, not at once.
  stopLanders(box);
  command(box, 'list');
  assert.equal(Date.parse(record(box, 'timer.json').dueAt), Date.parse(first.pending.backoff.retryAt), 'recovery keeps the back-off');
  assert.equal(leaseRequests(box).length, first.requests, 'the command started no landing');
  // Each further idle attempt, resumed from its own record on an injected clock, doubles the wait up to 5 minutes.
  const waits = [];
  for (let attempt = 0; attempt < 4; attempt++) {
    const observed = resumeLander(box);
    assert.equal(observed.backoffs.length, 1, 'the idle landing records one back-off');
    const next = observed.backoffs[0];
    assert.equal(next.outcome, 'NOTHING_TO_LAND');
    assert.equal(observed.clock - observed.start, next.backoffMs, 'the lander waited out the whole back-off');
    assert.equal(Date.parse(observed.pending.dueAt), observed.start + next.backoffMs, 'the next wake is no sooner than the back-off');
    assert.equal(observed.pending.backoff.backoffMs, next.backoffMs, 'the next record carries the back-off');
    assert.equal(observed.timer.dueAt, observed.pending.dueAt, 'its timer waits for it');
    waits.push(next.backoffMs);
  }
  assert.deepEqual([first.pending.backoff.backoffMs, ...waits], [60_000, 120_000, 240_000, 300_000, 300_000]);
  // With nothing ready, no attempt took a landing lease: the back-off alone paced them [C7,#5862].
  assert.equal(leaseRequests(box).length, first.requests, 'an idle attempt requests no landing lease');
  // A landing replaced by one that moves nothing keeps the same outcome, so the wait stays at its 5-minute ceiling.
  const idle = resumeLander(box, { idle: true });
  assert.equal(idle.backoffs[0].outcome, 'NOTHING_TO_LAND');
  assert.equal(idle.backoffs[0].backoffMs, 300_000);
  assert.throws(() => onBoard(box, board => store.landingLeaseMove(board, { agentId: 'coordinator', action: 'request', token: randomUUID(),
    branch: 'refs/heads/main', pid: process.pid, backoffMs: 600_000 })), error => error.code === 'LAND_LEASE_REQUEST');
});

test('clause 2: an accept verdict recorded by the real pullboard verify command during a back-off wakes the lander at once [C7]', { timeout: 300_000 }, async t => { // budget: real lander processes on an idle trunk; hang ceiling, not speed.
  const { box } = heldTrunk(t);
  const second = itemWorktree(box, 2);
  submitItem(box, second);
  const backed = await backingOff(box);
  // An ordinary command while the lander backs off starts nothing: the back-off holds.
  command(box, 'list');
  assert.equal(record(box).backoff?.retryAt, backed.pending.backoff.retryAt, 'a command without a wake trigger keeps the back-off');
  assert.equal(leaseRequests(box).length, backed.requests, 'no new landing starts');
  acceptItem(box, second);
  await landsBefore(box, backed, second.item, 'the accept wakes the lander, which lands the accepted item');
});

test('clause 3: a green gate that verifies an item, recorded by the real submit, wakes the lander at once during a back-off [C7]', { timeout: 300_000 }, async t => { // budget: real lander processes on an idle trunk; hang ceiling, not speed.
  const { box } = heldTrunk(t);
  const path = join(box.dir, 'machine-1');
  box.git(box.repo, 'worktree', 'add', '-q', '-b', 'web/machine-1', path, 'main');
  assert.equal(joinFixtureSeat(box, path, 'web').code, 0);
  const file = 'web/machine-1.txt';
  const id = fileFixtureItem(box, box.repo, { lane: 'web', title: 'Machine fixture', criterion: '1. the result is built [command]',
    check: `test -f ${file}`, args: ['--specs', 'G1'] }).item_id;
  const commands = join(box.dir, 'machine-commands.json');
  writeFileSync(commands, JSON.stringify([{ clause: 1, command: `test "$(cat ${file})" = built` }]));
  command(box, 'edit', String(id), '--machine-verified', 'on', '--machine-commands-file', commands, '--reason', 'Every clause has an executable check');
  assert.equal(box.run(path, 'claim', String(id)).code, 0);
  assert.equal(commitFile(box, path, file, 'built\n', 'feat(web): build the machine fixture [G1]').status, 0);
  const ticked = box.run(path, 'fact', String(id), 'note', `clause 1 [command]: test "$(cat ${file})" = built exits 0`);
  assert.equal(ticked.code, 0, ticked.out + ticked.err);
  const backed = await backingOff(box);
  const submitted = box.run(path, 'submit', String(id), '--no-next');
  assert.equal(submitted.code, 0, submitted.out + submitted.err);
  assert.match(submitted.out + submitted.err, /machine-verified #\d+/u, 'the green gate verified the item');
  assert.equal(onBoard(box, board => store.getItem(board, id).item_status), 'verified');
  await landsBefore(box, backed, id, 'the green gate wakes the lander, which lands the verified item');
});

test('clause 4: a commit to main that touches the held test file wakes the lander at once; another commit does not [C7]', { timeout: 300_000 }, async t => { // budget: real idle landings in a private repo; hang ceiling, not speed.
  const { box } = heldTrunk(t);
  await backingOff(box);
  const observed = resumeLander(box, { commits: {
    2: { file: 'web/unrelated.txt', text: 'unrelated\n', message: 'chore: an unrelated trunk change' },
    4: { file: HELD, text: `${HELD_TEXT}// corrected\n`, message: 'test: correct the held fixture test' },
  } });
  assert.equal(observed.backoffs[0].outcome, 'NOTHING_TO_LAND');
  assert.equal(observed.backoffs[0].backoffMs, 120_000, 'the repeated idle landing doubled the first back-off');
  assert.equal(observed.polls, 4, 'the unrelated commit kept the back-off; the held-file commit ended it at the next look');
  assert.ok(observed.clock - observed.start < observed.backoffs[0].backoffMs, 'the wake came before the back-off ended');
  assert.equal(observed.result.backoff, undefined, 'the woken attempt carries no back-off');
  assert.equal(Date.parse(observed.result.reloadAt), observed.clock + 1000, 'the next attempt is due at once');
  assert.equal(observed.pending?.backoff, undefined, 'the pending wake no longer carries the back-off');
  assert.match(box.git(box.repo, 'log', '-1', '--format=%s', '--', HELD), /correct the held fixture test/u, 'a real commit on the trunk changed the held file');
});
