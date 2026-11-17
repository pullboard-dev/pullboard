/** @pullboard-test-input source-cell apps/cli packages/gate */
/** The registered-worker submit against the ssh stand-in pull runner settles in bounded time, or names where it stands [C7,V4]. */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdirSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import { readdirSync } from 'node:fs';
import { watch } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { join } from 'node:path';
import { resolve } from 'node:path';
import { after } from 'node:test';
import { test } from 'node:test';
import { createE2eHelpers } from '../../tests/fixtures/e2e.js';
import { startFixtureLocalRunner } from '../../tests/fixtures/runner/local-start.js';
import { CLI_ENTRY } from '../../tests/fixtures/runner/entry.js';
import { HOST } from '../../../../packages/gate/tests/fixtures/runner/ssh.js';
import { installSshStandIn } from '../../../../packages/gate/tests/fixtures/runner/ssh.js';

const helpers = createE2eHelpers();
after(helpers.cleanup);
const CLI = resolve(import.meta.dirname, '../../pullboard.js');
// Budget: each pull-runner step (add --wait, submit --wait, the settle after it) must end well inside the 180 s file kill.
const STEP_MS = 60_000;

/** Every job row of the fixture board, read-only; a locked board reads as no rows this time. */
function jobRows(box) {
  // @pullboard-board-file journey: a read-only look at the jobs the real CLI queued, to name where a wait stands.
  try {
    const db = new DatabaseSync(join(box.repo, '.git', 'pullboard', 'board.sqlite'), { readOnly: true });
    try { return db.prepare('SELECT * FROM job').all().map(row => ({ ...row })); } finally { db.close(); }
  } catch (error) { return [`unread: ${error.message}`]; }
}

/** The stand-in runner's queue, running and done folders with their files, and whether its agent lock holder lives. */
function runnerFolders(root) {
  const out = {};
  for (const name of ['queue', 'running', 'done']) {
    const folder = join(root, name);
    out[name] = existsSync(folder) ? readdirSync(folder).map(id => {
      let files = [];
      try { files = readdirSync(join(folder, id)); } catch { /* not a folder */ }
      const exit = existsSync(join(folder, id, 'exit')) ? readFileSync(join(folder, id, 'exit'), 'utf8').trim() : null;
      const control = existsSync(join(folder, id, 'control.log')) ? readFileSync(join(folder, id, 'control.log'), 'utf8').split('\n').filter(Boolean).slice(-3) : [];
      return { id, files, exit, control };
    }) : 'absent';
  }
  const lock = join(root, 'agent.lock', 'pid');
  const pid = existsSync(lock) ? Number(readFileSync(lock, 'utf8')) : null;
  let alive = false;
  try { if (pid) { process.kill(pid, 0); alive = true; } } catch { /* gone */ }
  out.agent = { pid, alive };
  return out;
}

/** The box's live processes, by their command lines. */
function boxProcesses(box) {
  try {
    return execFileSync('ps', ['-axo', 'pid,ppid,etime,command'], { encoding: 'utf8' }).split('\n')
      .filter(line => line.includes(box.dir)).map(line => line.slice(0, 220));
  } catch (error) { return [`ps failed: ${error.message}`]; }
}

/** Log where the box stands on each change under the watched folders, at most once per 3 s; returns the stop. */
function watchState(label, folders, snapshot) {
  const started = Date.now();
  let last = 0;
  const seen = () => {
    if (Date.now() - last < 3_000) return;
    last = Date.now();
    process.stderr.write(`STATE ${label} +${((last - started) / 1000).toFixed(1)}s ${JSON.stringify(snapshot())}\n`);
  };
  const watchers = folders.flatMap(folder => { try { return [watch(folder, { recursive: true }, seen)]; } catch { return []; } });
  return () => { for (const watcher of watchers) watcher.close(); };
}

/** Run one CLI step in its own process, logging where the box stands as its folders change, and kill it at STEP_MS with that evidence. */
function step(box, label, cwd, args, snapshot, folders) {
  const started = Date.now();
  return new Promise(done => {
    const child = spawn(process.execPath, [CLI, ...args], { cwd, env: box.env, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '', err = '';
    child.stdout.on('data', part => { out += part; });
    child.stderr.on('data', part => { err += part; });
    const stopWatch = watchState(label, folders, snapshot);
    const cap = setTimeout(() => { child.kill('SIGKILL'); }, STEP_MS);
    child.on('close', (code, signal) => {
      stopWatch(); clearTimeout(cap);
      const seconds = (Date.now() - started) / 1000;
      process.stderr.write(`STEP ${label} ${seconds.toFixed(1)}s code=${code} signal=${signal}\nSTDERR ${label} ${err.split('\n').slice(-25).join('\n')}\n`);
      if (signal) process.stderr.write(`STATE ${label} at cap ${JSON.stringify(snapshot())}\n`);
      done({ code, signal, out, err, seconds });
    });
  });
}

/** The job rows not yet done once every row is done or STEP_MS has passed, read again on each change under the folders. */
function settled(box, folders, snapshot) {
  const started = Date.now();
  const stopWatch = watchState('settle', folders, snapshot);
  const openRows = () => jobRows(box).filter(row => typeof row !== 'object' || row.job_step !== 'done');
  return new Promise(done => {
    const watchers = [];
    const look = () => {
      const open = openRows();
      if (open.length && Date.now() - started < STEP_MS) return;
      for (const watcher of watchers) watcher.close();
      stopWatch(); clearTimeout(cap); done(open);
    };
    const cap = setTimeout(look, STEP_MS);
    for (const folder of folders) { try { watchers.push(watch(folder, { recursive: true }, look)); } catch { /* absent */ } }
    look();
  });
}

/** Require native CLI success before using a result as setup evidence. */
function succeeded(result) {
  assert.equal(result.code, 0, `${result.err}\n${result.out}`);
  return result;
}

test('clause 1: the registered-worker submit --wait over the ssh stand-in pull runner returns with its gate in under 60 s [C7,V4]', async () => {
  const t0 = Date.now(), tick = label => process.stderr.write(`TIMING ${((Date.now() - t0) / 1000).toFixed(1)}s ${label}\n`);
  const box = helpers.project('true');
  const paths = Object.fromEntries(['bin', 'worker', 'remoteHome', 'remoteMachine'].map(name => [name, join(box.dir, name)]));
  for (const path of Object.values(paths)) mkdirSync(path, { recursive: true });
  const requests = join(box.dir, 'runner-only-requests.jsonl');
  installSshStandIn({ bin: paths.bin, worker: paths.worker, home: paths.remoteHome, machineHome: paths.remoteMachine, requests });
  box.env.PATH = `${paths.bin}:${box.env.PATH}`;
  const root = join(paths.remoteHome, '.pullboard-runner');
  mkdirSync(root, { recursive: true });
  const folders = [root, box.dir, join(box.repo, '.git', 'pullboard'), box.env.PULLBOARD_MACHINE_HOME];
  const tail = (file, lines) => existsSync(file) ? readFileSync(file, 'utf8').split('\n').filter(Boolean).slice(-lines).map(line => line.slice(0, 400)) : [];
  const snapshot = () => ({ jobs: jobRows(box), runner: runnerFolders(root), ps: boxProcesses(box),
    requests: Object.fromEntries(readdirSync(box.dir).filter(name => name.startsWith('runner-only-requests')).map(name => [name, tail(join(box.dir, name), 3)])),
    localRunner: tail(join(box.env.PULLBOARD_MACHINE_HOME, 'local-runner', 'runner.log'), 8) });
  // The stand-in runner is this host, so its load reading is the real runner's: load-aware dispatch would hold every admission.
  succeeded(box.run(box.repo, 'settings', 'gate.loadAwareDispatch', 'off'));
  succeeded(box.run(box.repo, 'runner', 'add', HOST, '--slots', '1', '--browser', '1'));
  tick('after runner add');
  const added = succeeded(await step(box, 'add', box.repo, ['add', 'web', 'Registered runner-only submission', '--specs', 'G1',
    '--criterion', 'The native frozen check executes in its admitted registered worker.',
    '--check', 'printf RUNNER_ONLY_FROZEN_BODY', '--route', 'strong', '--wait', '--json'], snapshot, folders));
  tick('after add --wait');
  process.stderr.write(`STATE after add ${JSON.stringify(snapshot())}\n`);
  const id = JSON.parse(added.out).item.item_id;
  succeeded(box.run(box.web, 'claim', String(id), '--json'));
  tick('after claim');
  const built = helpers.commitFile(box, box.web, 'web/registered.txt', 'actual worker control\n', 'feat(web): registered runner-only control [G1]');
  assert.equal(built.status, 0, built.failure ?? built.stderr);
  tick('after commit');
  succeeded(box.run(box.repo, 'settings', 'gate.runnersOnly', 'on'));
  tick('after settings');
  // Under pull dispatch a submit offers its gate as a job row; with a runner registered, the CLI starts no local runner to take it.
  const local = startFixtureLocalRunner(box.env, box.repo, { entry: CLI_ENTRY });
  tick(`after local runner ${JSON.stringify(local)}`);
  const submitted = await step(box, 'submit', box.web, ['submit', String(id), '--wait', '--no-next', '--json'], snapshot, folders);
  tick('after submit --wait');
  assert.equal(submitted.signal, null, `submit --wait did not return in ${STEP_MS} ms`);
  succeeded(submitted);
  process.stderr.write(`SUBMIT OUT ${submitted.out.slice(0, 3000)}\n`);
  // The fixture's own settle after a submit waits for every job row to be done; it must end too.
  const open = await settled(box, folders, snapshot);
  tick('after settle');
  process.stderr.write(`AFTER SETTLE ${JSON.stringify(snapshot()).slice(0, 20000)}\n`);
  const shown = box.run(box.repo, 'show', String(id), '--json');
  process.stderr.write(`SHOW ${shown.out.slice(0, 6000)}\n`);
  assert.deepEqual(open, [], `job rows still open after ${STEP_MS} ms: ${JSON.stringify(snapshot())}`);
});
