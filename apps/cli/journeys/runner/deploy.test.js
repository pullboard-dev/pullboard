/** Pull mode deploys in one command: the board API listens for runners with a key, and runner serve installs as a login service [P7,O5]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { execFileSync } from 'node:child_process';
import { chmodSync } from 'node:fs';
import { existsSync } from 'node:fs';
import { mkdirSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import { statSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { networkInterfaces } from 'node:os';
import { join } from 'node:path';
import { resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { apiHttpBox } from '../../tests/fixtures/api.js';
import { apiHttpFixture } from '../../tests/fixtures/api.js';
import { startFixtureChild } from '../../tests/fixtures/child.js';
import { runFixtureChild } from '../../tests/fixtures/child.js';
import { fixtureMachineSettings } from '../../tests/fixtures/testkit.js';
import { jobView } from '../../../../packages/jobs/index.js';
import { offerJob } from '../../../../packages/api/index.js';

const BIN = resolve(import.meta.dirname, '../../pullboard.js');

/** This host's first non-loopback IPv4 address, the kind of address a board on a LAN listens on, or null. */
function lanAddress() {
  for (const entries of Object.values(networkInterfaces())) {
    for (const entry of entries ?? []) if (entry.family === 'IPv4' && !entry.internal) return entry.address;
  }
  return null;
}

/** Start the real `pullboard serve --json` and resolve its startup document; it stops when the test ends. */
async function startServe(t, box, args = []) {
  // Process-level: serve is a long-lived child stopped by signal.
  const child = startFixtureChild(process.execPath, [BIN, 'serve', ...args, '--json'], { cwd: box.root, env: box.env, stdio: ['ignore', 'pipe', 'pipe'] });
  const closed = new Promise(done => child.once('close', done));
  const stop = async () => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM'); await closed; };
  t.after(stop);
  let stdout = '', stderr = '';
  child.stderr.setEncoding('utf8').on('data', part => { stderr += part; });
  const document = await new Promise((ready, fail) => {
    const timer = setTimeout(() => fail(new Error(`serve did not start: ${stderr}`)), 30_000); // budget: hang ceiling for one serve startup.
    child.stdout.setEncoding('utf8').on('data', part => {
      stdout += part;
      try { const parsed = JSON.parse(stdout); clearTimeout(timer); ready(parsed); } catch { /* the envelope spans chunks */ }
    });
    child.once('close', code => { clearTimeout(timer); fail(new Error(`serve exited ${code}: ${stderr}`)); });
  });
  return { document, stop };
}

/** One POST to a board's job queue, as a runner sends it. */
function jobCall(url, body, key) {
  return fetch(`${url}/jobs`, { method: 'POST', signal: AbortSignal.timeout(10_000),
    headers: { 'content-type': 'application/json', ...(key ? { 'x-pullboard-key': key } : {}) }, body: JSON.stringify(body) });
}

test('clause 1: the serve.address setting makes the board API listen on that address with the machine\'s board key, refusing requests without it, and loopback stays the default [P7,O5]', { timeout: 120_000 }, // budget: three serve startups.
async (t) => {
  const address = lanAddress();
  if (!address) { t.skip('this host has no non-loopback IPv4 interface'); return; }
  const box = apiHttpFixture(t);
  mkdirSync(box.env.PULLBOARD_MACHINE_HOME, { recursive: true });

  const loopback = await startServe(t, box);
  assert.equal(new URL(loopback.document.url).hostname, '127.0.0.1', 'with no setting the API stays on loopback');
  assert.equal(loopback.document.boards, undefined, 'a loopback API offers no runner URL');
  await loopback.stop();

  fixtureMachineSettings(box.env.PULLBOARD_MACHINE_HOME, { serve: { address, port: 0 }, gate: { runnerDispatch: 'pull' } });
  const served = await startServe(t, box);
  const listing = new URL(served.document.url);
  assert.equal(listing.hostname, address, 'the API listens on the chosen address');
  const key = readFileSync(served.document.keyFile, 'utf8').trim();
  assert.equal(listing.searchParams.get('k'), key, 'the API takes the machine\'s board key');
  assert.equal(statSync(served.document.keyFile).mode & 0o777, 0o600, 'only the owner reads the board key');
  assert.equal(served.document.boards.length, 1, 'off loopback only this repo\'s board is served');
  const board = served.document.boards[0].runnerUrl;
  assert.equal(board, `${listing.origin}/api/v1/boards/${served.document.boards[0].id}`);

  const bare = await fetch(`${listing.origin}/api/v1/boards`, { signal: AbortSignal.timeout(10_000) });
  assert.equal(bare.status, 401, 'a request without the key is refused');
  assert.equal((await bare.json()).error.code, 'AUTH_REQUIRED');
  const wrong = await jobCall(board, { action: 'claim', runner: 'r-lan', capabilities: ['node22'] }, `${key}x`);
  assert.equal(wrong.status, 401, 'a runner with a wrong key is refused');
  const claim = await jobCall(board, { action: 'claim', runner: 'r-lan', capabilities: ['node22'] }, key);
  assert.equal(claim.status, 200, 'a runner with the key reaches the job queue at the chosen address');
  assert.equal((await claim.json()).claim, null);
  await served.stop();

  const again = await startServe(t, box, ['--port', '0']);
  assert.equal(new URL(again.document.url).searchParams.get('k'), key, 'the board key lasts across restarts, so installed runners keep working');
  await again.stop();
  const flagged = await startServe(t, box, ['--address', '127.0.0.1']);
  assert.equal(new URL(flagged.document.url).hostname, '127.0.0.1', 'the --address flag overrides the setting');
  assert.notEqual(new URL(flagged.document.url).searchParams.get('k'), key, 'loopback keeps its per-session secret');
});

/**
 * A runner reached by an ssh stand-in: commands run here with the runner's own HOME, and launchctl only records its
 * calls, so nothing is installed on this machine's real launchd.
 */
function fakeRunner(dir) {
  const bin = join(dir, 'runner-bin');
  const home = join(dir, 'runner-home');
  const root = join(dir, 'runner-root');
  const log = join(dir, 'launchctl.log');
  mkdirSync(bin); mkdirSync(home); mkdirSync(root);
  writeFileSync(join(bin, 'ssh'), `#!/bin/sh\nwhile [ "$1" != "--" ]; do shift; done\nshift 2\nHOME='${home}' PATH='${bin}':"$PATH" exec /bin/sh -c "$1"\n`);
  writeFileSync(join(bin, 'launchctl'), `#!/bin/sh\nprintf '%s\\n' "$*" >> '${log}'\n`);
  chmodSync(join(bin, 'ssh'), 0o755); chmodSync(join(bin, 'launchctl'), 0o755);
  return { bin, home, root, log, plist: join(home, 'Library', 'LaunchAgents', 'dev.pullboard.runner-serve.plist') };
}

/** The string values in a plist's ProgramArguments array. */
function programArguments(plist) {
  const array = /<key>ProgramArguments<\/key>\s*<array>([\s\S]*?)<\/array>/u.exec(plist)[1];
  return [...array.matchAll(/<string>([^<]*)<\/string>/gu)].map(match => match[1].replaceAll('&lt;', '<').replaceAll('&gt;', '>').replaceAll('&amp;', '&'));
}

test('clause 2: runner install-serve installs runner serve on a registered runner as a launchd login agent that restarts on exit, and --remove removes it [P7]', { timeout: 120_000 }, // budget: two CLI runs, a git fetch and one job.
async (t) => {
  const box = await apiHttpBox(t);
  const runner = fakeRunner(box.dir);
  fixtureMachineSettings(box.env.PULLBOARD_MACHINE_HOME, { gate: { runnerDispatch: 'pull' },
    runners: [{ host: 'runner-a', slots: 1, browser: 0, node: process.execPath, root: runner.root }] });
  // A trunk remote apart from the board host, holding a candidate the job runs.
  const git = (cwd, ...args) => execFileSync('git', args, { cwd, env: box.env, encoding: 'utf8' }).trim();
  const trunk = join(box.dir, 'trunk.git');
  const source = join(box.dir, 'source');
  git(box.dir, 'clone', '-q', '--bare', box.root, trunk);
  git(box.dir, 'clone', '-q', trunk, source);
  writeFileSync(join(source, 'check.js'), "console.log('ran on the installed runner');\n");
  git(source, 'add', 'check.js');
  git(source, 'commit', '-q', '-m', 'candidate');
  git(source, 'push', '-q', trunk, 'HEAD:refs/heads/candidate');
  const commit = git(source, 'rev-parse', 'HEAD');
  const config = join(box.root, 'pullboard.json');
  writeFileSync(config, JSON.stringify({ ...JSON.parse(readFileSync(config, 'utf8')), trunk: { remote: trunk } }, null, 2));
  const env = { ...box.env, PATH: `${runner.bin}:${box.env.PATH}` };
  delete env.PULLBOARD_BOARD_KEY;
  // Process-level: install-serve drives launchd and a PATH-shimmed runner.
  const cli = (...args) => runFixtureChild(process.execPath, [BIN, 'runner', ...args, '--json'], { cwd: box.root, env, encoding: 'utf8' });

  const unknown = cli('install-serve', 'runner-z', '--board', `${box.origin}${box.path}?k=${box.key}`);
  assert.notEqual(unknown.status, 0);
  assert.match(unknown.stdout + unknown.stderr, /RUNNER_NOT_REGISTERED/u, 'only a registered runner is installed');

  const installed = cli('install-serve', 'runner-a', '--board', `${box.origin}${box.path}?k=${box.key}`);
  assert.equal(installed.status, 0, installed.stdout + installed.stderr);
  const { service } = JSON.parse(installed.stdout);
  assert.equal(service.loaded, true);
  assert.equal(service.plist, runner.plist, 'a login agent in the runner user\'s LaunchAgents');
  const uid = process.getuid();
  assert.ok(readFileSync(runner.log, 'utf8').split('\n').includes(`bootstrap gui/${uid} ${runner.plist}`), 'launchd loads it in the login session');
  const plist = readFileSync(runner.plist, 'utf8');
  assert.match(plist, /<key>KeepAlive<\/key><true\/>/u, 'launchd restarts it whenever it exits');
  assert.match(plist, /<key>RunAtLoad<\/key><true\/>/u, 'it starts at login');
  assert.ok(plist.includes(`<key>StandardOutPath</key><string>${join(runner.root, 'serve', 'serve.log')}</string>`), 'it logs to the runner root');
  assert.ok(!plist.includes(box.key), 'the key is never in the plist');
  const keyFile = join(runner.root, 'serve', 'board.key');
  assert.equal(readFileSync(keyFile, 'utf8').trim(), box.key);
  assert.equal(statSync(keyFile).mode & 0o777, 0o600);
  const args = programArguments(plist);
  assert.equal(args[0], process.execPath, 'it runs with the runner\'s registered Node');
  assert.equal(args[2], `${box.origin}${box.path}`);

  // What launchd runs claims a job from the board, fetches its commit from the trunk remote and posts the receipt.
  const db = new DatabaseSync(join(box.root, '.git', 'pullboard', 'board.sqlite'));
  t.after(() => db.close());
  offerJob(db, { id: 'gate:installed', kind: 'gate', needs: ['node22'], candidate: commit, run: [process.execPath, 'check.js'] });
  const path = /<key>PATH<\/key><string>([^<]*)<\/string>/u.exec(plist)[1];
  const service$ = startFixtureChild(args[0], args.slice(1), { cwd: join(runner.root, 'serve'), env: { HOME: runner.home, PATH: path }, stdio: ['ignore', 'pipe', 'pipe'] });
  const exited = new Promise(done => service$.once('close', (code, signal) => done({ code, signal })));
  let output = '';
  service$.stderr.setEncoding('utf8').on('data', part => { output += part; });
  t.after(() => { if (service$.exitCode === null) service$.kill('SIGKILL'); });
  // The service logs each posted receipt; the test waits for that line, or for the service to exit.
  await new Promise(done => {
    service$.stdout.setEncoding('utf8').on('data', part => { output += part; if (output.includes('posted gate:installed')) done(); });
    service$.once('close', done);
  });
  assert.equal(jobView(db, 'gate:installed').step, 'done', output);
  const { receipt } = jobView(db, 'gate:installed').steps.find(step => step.name === 'receipt').payload;
  assert.equal(receipt.status, 0);
  assert.match(receipt.tail, /ran on the installed runner/u);
  service$.kill('SIGTERM');
  assert.deepEqual(await exited, { code: 0, signal: null }, 'the service stops cleanly on SIGTERM');

  const removed = cli('install-serve', 'runner-a', '--remove');
  assert.equal(removed.status, 0, removed.stdout + removed.stderr);
  assert.ok(readFileSync(runner.log, 'utf8').split('\n').includes(`bootout gui/${uid}/dev.pullboard.runner-serve`), 'the running service is stopped');
  assert.equal(existsSync(runner.plist), false, 'the login agent is gone');
  assert.equal(existsSync(join(runner.root, 'serve')), false, 'its files and key are gone');
});
