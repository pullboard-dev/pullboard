/** A pull runner whose trunk fetch fails hands the job back fast and can stop claiming, each behind its own setting, both off by default (#9024) [C7]. */
import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { serveRunner } from '../../../index.js';
import { runnerSettingOn } from '../../../index.js';
import { runTestGit } from '../../fixtures/git.js';
import { privateFixtureFiles } from '../../../../gate/tests/fixtures/child.js';

const BOARD = 'http://board.invalid/api/v1/boards/b?k=x';
const SHA = 'a'.repeat(40);
const SSH_DOWN = 'ssh: connect to host 100.109.124.33 port 22: Operation timed out';

/** A queue stand-in: `jobs` are claimed in order, each release and claim is kept, and the runner stops when `done` says so. */
function stubBoard(jobs, { done, stop }) {
  const pending = [...jobs], board = { claims: [], releases: [], actions: [] };
  board.fetchImpl = async (_url, { body }) => {
    const call = JSON.parse(body);
    board.actions.push(call.action);
    let reply = { recorded: true };
    if (call.action === 'claim') {
      const job = pending.shift();
      if (job) board.claims.push(job);
      reply = job ? { trunk: 'ssh://trunk.invalid/repo.git', claim: { job, kind: 'test', needs: [], run: ['node', '-e', '0'], candidate: SHA, base: null, attempt: 1, token: `r:${job}` } } : { claim: null };
    } else if (call.action === 'renew') reply = { renewed: true };
    else if (call.action === 'release') board.releases.push({ job: call.job, reason: call.reason });
    if (done(board)) stop.abort();
    return { status: 200, json: async () => reply };
  };
  return board;
}

/** A private runner cache folder, removed after the test. */
function runnerCache(t) {
  const { root } = privateFixtureFiles('pullboard-fetch-fail-');
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return join(root, 'cache');
}

/** Write a machine settings file holding the given object. */
function writeSettings(file, value) { writeFileSync(file, JSON.stringify(value)); }

/** Git whose trunk fetch is `fetchTrunk` and whose every other command is real git. */
function gitWith(fetchTrunk) { return { run: runTestGit, fetchTrunk }; }

test('drive.fetch-fail.with-runners-fetchfailfast-on-a: clause 1: with runners.fetchFailFast on, a job whose trunk fetch fails is released at once naming the fetch error, and the job behind it is released without a fetch of its own (#9024) [C7]', async t => {
  const stop = new AbortController();
  const board = stubBoard(['test:one', 'test:two'], { stop, done: b => b.releases.length === 2 });
  let fetches = 0;
  const git = gitWith(async () => { fetches += 1; return { status: 128, stdout: '', stderr: SSH_DOWN }; });
  await serveRunner({ git, board: BOARD, runner: 'r-fast', capabilities: [], cache: runnerCache(t), jobs: 2, cores: 2, signal: stop.signal, fetchImpl: board.fetchImpl,
    sleep: async () => {}, timing: { idleMs: 1 }, trunkPack: async () => null, fetchFailFast: true });
  assert.deepEqual(board.releases.map(r => r.job).sort(), ['test:one', 'test:two']);
  assert.match(board.releases.find(r => r.job === 'test:one').reason, /Operation timed out/u, 'the first release names the fetch error');
  assert.match(board.releases.find(r => r.job === 'test:two').reason, /Operation timed out/u, 'the second release names the same error');
  assert.equal(fetches, 2, 'one job fetched by id and by branches; the job behind it fetched nothing');
});

test('drive.fetch-fail.with-runners-fetchfailfast-on-a-2: clause 1: with runners.fetchFailFast on, a trunk fetch still running at the deadline sends the claim back naming the deadline (#9024) [C7]', async t => {
  const stop = new AbortController();
  const board = stubBoard(['test:hung'], { stop, done: b => b.releases.length === 1 });
  const git = gitWith(() => new Promise(() => {}));
  // The object store exists already, so the deadline can only fall in the fetch.
  const cache = runnerCache(t);
  await mkdir(cache, { recursive: true });
  await runTestGit(cache, ['init', '-q', '--bare', join(cache, 'git')]);
  await serveRunner({ git, board: BOARD, runner: 'r-hung', capabilities: [], cache, jobs: 1, cores: 2, signal: stop.signal, fetchImpl: board.fetchImpl,
    sleep: async () => {}, timing: { idleMs: 1, fetchFailMs: 40 }, trunkPack: async () => null, fetchFailFast: true });
  assert.equal(board.releases.length, 1);
  assert.match(board.releases[0].reason, /trunk fetch did not end within 0 s of the claim/u);
});

test('drive.fetch-fail.with-runners-drainonfetchfailure-on-a: clause 2: with runners.drainOnFetchFailure on, a runner claims no job after 3 trunk fetch failures in a row until a fetch succeeds (#9024) [C7]', async t => {
  const stop = new AbortController();
  // Five jobs wait; the runner may claim only the first three, then probes the trunk until it answers.
  const board = stubBoard(['test:1', 'test:2', 'test:3', 'test:4', 'test:5'], { stop, done: b => b.releases.length === 4 });
  let probes = 0, up = false;
  const git = { run: (cwd, args, input) => (args[0] === 'ls-remote' ? (probes += 1, Promise.resolve(probes >= 2 ? (up = true, { status: 0, stdout: '', stderr: '' }) : { status: 2, stdout: '', stderr: SSH_DOWN })) : runTestGit(cwd, args, input)),
    fetchTrunk: async () => ({ status: 128, stdout: '', stderr: SSH_DOWN }) };
  const lines = [];
  let claimsAtFirstProbe = null;
  const original = git.run;
  git.run = (cwd, args, input) => { if (args[0] === 'ls-remote' && claimsAtFirstProbe === null) claimsAtFirstProbe = board.claims.length; return original(cwd, args, input); };
  await serveRunner({ git, board: BOARD, runner: 'r-drain', capabilities: [], cache: runnerCache(t), jobs: 1, cores: 2, signal: stop.signal, fetchImpl: board.fetchImpl,
    sleep: async () => {}, say: line => lines.push(line), timing: { idleMs: 1, drainProbeMs: 0 }, trunkPack: async () => null, drainOnFetchFailure: true });
  assert.equal(claimsAtFirstProbe, 3, 'no job was claimed after the third failed fetch until the trunk was probed');
  assert.ok(probes >= 2 && up, 'the trunk was probed until it answered');
  assert.equal(board.claims.length, 4, 'claiming resumed once the probe answered, and not before');
  assert.ok(lines.some(line => /not claiming: 3 trunk fetches failed in a row/u.test(line)));
});

test('drive.fetch-fail.with-both-settings-off-every: clause 3: with both settings off, every job tries its own fetch and the runner keeps claiming after any number of failures (#9024) [C7]', async t => {
  const stop = new AbortController();
  const board = stubBoard(['test:1', 'test:2', 'test:3', 'test:4'], { stop, done: b => b.releases.length === 4 });
  let fetches = 0;
  const git = gitWith(async () => { fetches += 1; return { status: 128, stdout: '', stderr: SSH_DOWN }; });
  await serveRunner({ git, board: BOARD, runner: 'r-off', capabilities: [], cache: runnerCache(t), jobs: 1, cores: 2, signal: stop.signal, fetchImpl: board.fetchImpl,
    sleep: async () => {}, timing: { idleMs: 1 }, trunkPack: async () => null });
  assert.equal(board.claims.length, 4, 'all four jobs were claimed');
  assert.equal(fetches, 8, 'each of the four jobs fetched by id and by branches itself');
  assert.ok(board.releases.every(r => /Operation timed out/u.test(r.reason)));
});

test('drive.fetch-fail.both-settings-read-off-unless: clause 3: both settings read off unless the machine settings file says exactly true, and a flat key is read beside the runners list (#9024) [C7]', t => {
  const { root } = privateFixtureFiles('pullboard-fetch-fail-settings-');
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const file = join(root, 'settings.json');
  assert.equal(runnerSettingOn(file, 'runners.fetchFailFast'), false, 'no file');
  writeSettings(file, { runners: [{ host: 'a@b' }] });
  assert.equal(runnerSettingOn(file, 'runners.fetchFailFast'), false, 'unset');
  writeSettings(file, { runners: [{ host: 'a@b' }], 'runners.fetchFailFast': 'yes' });
  assert.equal(runnerSettingOn(file, 'runners.fetchFailFast'), false, 'not a boolean');
  writeSettings(file, { runners: [{ host: 'a@b' }], 'runners.fetchFailFast': true });
  assert.equal(runnerSettingOn(file, 'runners.fetchFailFast'), true);
  assert.equal(runnerSettingOn(file, 'runners.drainOnFetchFailure'), false);
});
