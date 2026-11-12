/** Back-off fixtures for the automatic lander journeys: an idle trunk, its wake records and a resumable lander [C7]. */
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
import { onBoard } from '../land/board.js';
import { runFixtureChild } from '../child.js';
import { waitForCondition } from '../runner/holders.js';
import { automaticLandingDirectory } from '../../../../../packages/landing/index.js';

/** The test file whose recorded defect holds the fixture trunk. */
export const HELD = 'web/held.test.js';
// The fixture runner reads RED and NAME: from the file text, so the held case is red for real when landing measures it (#3719).
export const HELD_TEXT = "// RED NAME:held-case\nimport test from 'node:test'; test('held case', () => {});\n";

/** Read one of the fixture's private wake records, or null. */
export function record(box, name = 'pending.json') {
  const file = join(automaticLandingDirectory(box.repo), name);
  return existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : null;
}

/** The landing lease requests the fixture board recorded, oldest first. */
export function leaseRequests(box) {
  return onBoard(box, board => board.enginePorts.store.events(board)).filter(event => event.event_kind === 'landing_lease')
    .map(event => ({ ...JSON.parse(event.event_detail), at: event.event_at })).filter(detail => detail.action === 'request');
}

/** Stop the fixture's detached landers and timers, leaving their records as a crash would. */
export function stopLanders(box) {
  for (const name of ['pending.json', 'timer.json']) {
    const saved = record(box, name);
    for (const pid of [saved?.pid, saved?.running?.pid]) {
      if (!Number.isSafeInteger(pid) || pid === process.pid) continue;
      try { process.kill(pid, 'SIGKILL'); } catch { /* already gone */ }
    }
  }
}

/** Run a real command on the trunk checkout; its post-command step is what wakes or recovers the lander. */
export function command(box, ...args) {
  const result = box.run(box.repo, ...args);
  assert.equal(result.code, 0, result.out + result.err);
  return result;
}

/**
 * A real project with a recorded landing test defect on web/held.test.js, automatic landing on and one accepted item
 * waiting under a hold, so every real landing on it moves nothing. A defect no longer holds the trunk [C7,#5862].
 */
export function heldTrunk(t, { landProject, itemWorktree, submitItem, acceptItem }) {
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
  onBoard(box, board => board.enginePorts.store.recordLandingTestDefect(board, { agentId: 'coordinator', test: HELD,
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
export function wakeState(box) {
  const log = join(automaticLandingDirectory(box.repo), 'worker.log');
  return JSON.stringify({ pending: record(box), timer: record(box, 'timer.json'), leases: leaseRequests(box).length,
    log: existsSync(log) ? readFileSync(log, 'utf8').slice(-1500) : null });
}

/** Let a real command wake the real lander on the held trunk, and wait until it refuses and backs off. */
export async function backingOff(box) {
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
export async function landsBefore(box, { pending, requests }, id, label) {
  await waitForCondition(() => onBoard(box, board => Boolean(board.enginePorts.store.getItem(board, id).item_merged_commit)), label,
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
export function resumeLander(box, { commits = {}, idle = false, pollMs = 5000 } = {}) {
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
