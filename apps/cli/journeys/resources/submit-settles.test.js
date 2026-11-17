/** @pullboard-test-input source-cell apps/cli packages/gate */
/** A runner-only submit with the ssh stand-in registered settles its pulled gate in bounded time, or names where it stands; before #10303 it sat queued to the 180 s kill [C7,V4]. */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import { readdirSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { join } from 'node:path';
import { resolve } from 'node:path';
import { after } from 'node:test';
import { test } from 'node:test';
import { createE2eHelpers } from '../../tests/fixtures/e2e.js';
import { registerStandInAfterAdd } from '../../tests/fixtures/runner/registered.js';
import { serveBoardQueue } from '../../tests/fixtures/runner/registered.js';
import { settledGateJob } from '../../tests/fixtures/submit/settle.js';

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

/** Run one CLI step in its own process and kill it at STEP_MS, logging where the box stood then. */
function step(box, label, cwd, args, snapshot) {
  const started = Date.now();
  return new Promise(done => {
    const child = spawn(process.execPath, [CLI, ...args], { cwd, env: box.env, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '', err = '';
    child.stdout.on('data', part => { out += part; });
    child.stderr.on('data', part => { err += part; });
    const cap = setTimeout(() => { child.kill('SIGKILL'); }, STEP_MS);
    child.on('close', (code, signal) => {
      clearTimeout(cap);
      const seconds = (Date.now() - started) / 1000;
      process.stderr.write(`STEP ${label} ${seconds.toFixed(1)}s code=${code} signal=${signal}\n${signal || code ? `STDERR ${label} ${err.split('\n').slice(-25).join('\n')}\n` : ''}`);
      if (signal) process.stderr.write(`STATE ${label} at cap ${JSON.stringify(snapshot())}\n`);
      done({ code, signal, out, err, seconds });
    });
  });
}

/** Require native CLI success before using a result as setup evidence. */
function succeeded(result) {
  assert.equal(result.code, 0, `${result.err}\n${result.out}`);
  return result;
}

test('clause 1: a runner-only submit --wait with the ssh stand-in registered returns and its pulled gate settles green in under 60 s each [C7,V4]', async () => {
  const t0 = Date.now(), tick = label => process.stderr.write(`TIMING ${((Date.now() - t0) / 1000).toFixed(1)}s ${label}\n`);
  const box = helpers.project('true');
  const requests = join(box.dir, 'runner-only-requests.jsonl');
  let root = join(box.dir, 'remoteHome', '.pullboard-runner');
  const tail = (file, lines) => existsSync(file) ? readFileSync(file, 'utf8').split('\n').filter(Boolean).slice(-lines).map(line => line.slice(0, 400)) : [];
  const snapshot = () => ({ jobs: jobRows(box), runner: runnerFolders(root), ps: boxProcesses(box),
    requests: Object.fromEntries(readdirSync(box.dir).filter(name => name.startsWith('runner-only-requests')).map(name => [name, tail(join(box.dir, name), 3)])),
    localRunner: tail(join(box.env.PULLBOARD_MACHINE_HOME, 'local-runner', 'runner.log'), 8) });
  const registered = await registerStandInAfterAdd(box, { requests, add: async () => succeeded(await step(box, 'add', box.repo, ['add', 'web', 'Registered runner-only submission',
    '--specs', 'G1', '--criterion', 'The native frozen check executes in its admitted registered worker.',
    '--check', 'printf RUNNER_ONLY_FROZEN_BODY', '--route', 'strong', '--wait', '--json'], snapshot)) });
  root = registered.root;
  tick('after add --wait and runner add');
  const id = JSON.parse(registered.added.out).item.item_id;
  succeeded(box.run(box.web, 'claim', String(id), '--json'));
  const built = helpers.commitFile(box, box.web, 'web/registered.txt', 'actual worker control\n', 'feat(web): registered runner-only control [G1]');
  assert.equal(built.status, 0, built.failure ?? built.stderr);
  succeeded(box.run(box.repo, 'settings', 'gate.runnersOnly', 'on'));
  serveBoardQueue(box);
  tick('after claim, commit, settings and local runner');
  const submitted = await step(box, 'submit', box.web, ['submit', String(id), '--wait', '--no-next', '--json'], snapshot);
  tick('after submit --wait');
  assert.equal(submitted.signal, null, `submit --wait did not return in ${STEP_MS} ms`);
  const queued = JSON.parse(succeeded(submitted).out);
  assert.equal(queued.queued, true, 'a pulled submit returns once its gate job is offered');
  let job;
  try { job = await settledGateJob(box, id, { deadlineMs: STEP_MS }); }
  catch (error) { process.stderr.write(`STATE settle at cap ${JSON.stringify(snapshot())}\n`); throw error; }
  tick('after gate settled');
  assert.equal(job.id, queued.gateJob, 'the job the submit offered is the one that settled');
  assert.equal(job.gate?.green, true, JSON.stringify(job).slice(0, 2000));
  assert.equal(job.gate.check?.command, 'printf RUNNER_ONLY_FROZEN_BODY');
  assert.ok(job.gate.phases.some(phase => phase.role === 'check' && phase.tail.includes('RUNNER_ONLY_FROZEN_BODY')), 'the frozen check body ran');
  assert.deepEqual(jobRows(box).filter(row => row.job_step !== 'done'), [], 'no job row is left for the fixture settle to wait on');
});
