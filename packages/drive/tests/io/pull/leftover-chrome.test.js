/** A runner job never leaves a Chrome-like process running after it ends, and a start clears what an earlier job left [C7,#7811]. */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdirSync } from 'node:fs';
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { serveRunner } from '../../../index.js';
import { reapJob } from '../../../src/io/pull.js';
import { pathProcesses } from '../../../src/io/leftovers.js';
import { testGit as pullGit } from '../../fixtures/git.js';
import { privateFixtureFiles } from '../../../../../apps/cli/tests/fixtures/child.js';

const BOARD = 'http://board.invalid/api/v1/boards/b?k=x';
/** A stand-in for Chrome: it prints its pid, names its profile in its arguments, hides its environment from any marker, and ignores SIGTERM as a hung helper does. */
const STUB = "process.on('SIGTERM', () => {}); console.log(process.pid); setInterval(() => {}, 1000);";
/** Spawns the stub detached and exits, so init owns the stub while it keeps this process's stdout pipe open. */
const LAUNCHER = "const { spawn } = require('node:child_process'); spawn(process.execPath, ['-e', process.argv[1], process.argv[2]], { detached: true, stdio: ['ignore', 'inherit', 'ignore'] }).unref();";

/** Whether a pid is still a live process. */
const alive = pid => { try { process.kill(pid, 0); return true; } catch { return false; } };

/**
 * Start a stub whose command line names `profile`; `orphaned` leaves it parentless, as a killed serve's job does.
 * `closed` settles once the stub is gone, because it holds the pipe the test reads its pid from.
 */
async function stub(profile, orphaned = false) {
  const arg = `--user-data-dir=${profile}`;
  const child = orphaned ? spawn(process.execPath, ['-e', LAUNCHER, STUB, arg], { stdio: ['ignore', 'pipe', 'ignore'] })
    : spawn(process.execPath, ['-e', STUB, arg], { detached: true, stdio: ['ignore', 'pipe', 'ignore'] });
  const [first] = await once(child.stdout, 'data');
  if (orphaned) await once(child, 'exit');
  return { pid: Number(String(first).trim()), closed: once(child, 'close') };
}

test('#7811 clause 1: the sweep after a job ends removes a detached browser that names the job folder, and only that one [C7]', async t => {
  const { root } = privateFixtureFiles('pullboard-leftover-');
  const mine = join(root, 'env', 'job-1', 'tmp', 'profile'), other = join(root, 'env', 'job-2', 'tmp', 'profile');
  mkdirSync(mine, { recursive: true });
  const stubs = [await stub(mine), await stub(mine), await stub(other)];
  t.after(() => { rmSync(root, { recursive: true, force: true }); for (const { pid } of stubs) try { process.kill(pid, 'SIGKILL'); } catch { /* gone */ } });
  const found = await reapJob('job-1', undefined, { folder: join(root, 'env', 'job-1'), graceMs: 300 });
  assert.deepEqual(found.sort(), [stubs[0].pid, stubs[1].pid].sort());
  await Promise.all([stubs[0].closed, stubs[1].closed]);
  assert.equal(alive(stubs[2].pid), true, 'a process naming another job folder is never touched');
});

test('#7811 clause 1: a job folder that is a prefix of another job folder does not match it [C7]', async () => {
  const rows = async () => ' 11 1 chrome --user-data-dir=/r/env/job-1/tmp/p\n 12 1 chrome --user-data-dir=/r/env/job-10/tmp/p\n';
  assert.deepEqual(await pathProcesses('/r/env/job-1', { rows }), [11]);
});

test('#7811 clause 2: a runner start kills orphaned browsers under its env folder, logs the count and spares everything else [C7]', async t => {
  const { root } = privateFixtureFiles('pullboard-leftover-');
  const cache = join(root, 'pull');
  const left = join(cache, 'env', 'test-old-1', 'tmp', 'profile'), elsewhere = join(root, 'not-env', 'profile');
  mkdirSync(left, { recursive: true }); mkdirSync(elsewhere, { recursive: true });
  const dead = [await stub(left, true), await stub(left, true)], alien = await stub(elsewhere, true), live = await stub(left);
  t.after(() => { rmSync(root, { recursive: true, force: true }); for (const { pid } of [...dead, alien, live]) try { process.kill(pid, 'SIGKILL'); } catch { /* gone */ } });
  const said = [];
  const fetchImpl = async () => ({ status: 200, json: async () => ({ claim: null }) });
  await serveRunner({ git: pullGit, board: BOARD, runner: 'r-leftover', capabilities: [], cache, once: true, fetchImpl, say: line => said.push(line) });
  assert.ok(said.includes('killed 2 leftover process(es) of earlier jobs'), said.join('\n'));
  await Promise.all(dead.map(entry => entry.closed));
  assert.equal(alive(alien.pid), true, 'a browser of another path survives: the sweep never matches every Chrome');
  assert.equal(alive(live.pid), true, "a process with a live parent, another serve's job, survives");
});
