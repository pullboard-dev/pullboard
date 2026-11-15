/** A runner job never leaves a Chrome-like process running after it ends, and a start clears what an earlier job left [C7,#7811]. */
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { serveRunner } from '../../../index.js';
import { reapJob } from '../../../src/io/pull.js';
import { pathProcesses } from '../../../src/io/leftovers.js';
import { alive } from '../../fixtures/stub-chrome.js';
import { stub } from '../../fixtures/stub-chrome.js';
import { testGit as pullGit } from '../../fixtures/git.js';
import { privateFixtureFiles } from '../../../../../apps/cli/tests/fixtures/child.js';

const BOARD = 'http://board.invalid/api/v1/boards/b?k=x';

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

test('#7813 clause 1: a work-tree folder that is a prefix of another work-tree folder does not match it [C7]', async () => {
  const rows = async () => ' 21 1 node /c/pull/work/runner-a-0/apps/cli/x.js\n 22 1 node /c/pull/work/runner-a-01/apps/cli/x.js\n 23 1 node /c/pull/env/job-1/tmp/p\n 24 5 node /c/pull/work/runner-a-0/apps/cli/y.js\n';
  assert.deepEqual(await pathProcesses('/c/pull/work/runner-a-0', { rows }), [21, 24]);
  assert.deepEqual(await pathProcesses(['/c/pull/env', '/c/pull/work'], { rows, orphans: true }), [21, 22, 23]);
});

test('#7813 clause 1: the sweep after a job ends removes orphaned test processes naming the job work tree, and only that one [C7]', async t => {
  const { root } = privateFixtureFiles('pullboard-leftover-');
  const mine = join(root, 'pull', 'work', 'runner-a-0'), prefixed = join(root, 'pull', 'work', 'runner-a-01'), env = join(root, 'pull', 'env', 'job-1');
  mkdirSync(mine, { recursive: true }); mkdirSync(env, { recursive: true });
  const tree = join(mine, 'apps', 'cli', 'tests', 'x.test.js');
  const stubs = [await stub(tree, true, ''), await stub(join(prefixed, 'apps', 'cli', 'x.test.js'), true, '')];
  t.after(() => { rmSync(root, { recursive: true, force: true }); for (const { pid } of stubs) try { process.kill(pid, 'SIGKILL'); } catch { /* gone */ } });
  const found = await reapJob('job-1', undefined, { folder: [env, mine], graceMs: 300 });
  assert.deepEqual(found, [stubs[0].pid]);
  await stubs[0].closed;
  assert.equal(alive(stubs[1].pid), true, 'a process naming a sibling work folder whose name only starts the same is never touched');
});

test('#7813 clause 1: a runner start kills orphaned processes naming its work folder, and spares another cache, a live parent and the rest [C7]', async t => {
  const { root } = privateFixtureFiles('pullboard-leftover-');
  const cache = join(root, 'pull'), foreign = join(root, 'other', 'pull');
  const left = join(cache, 'work', 'runner-old-1', 'apps', 'cli', 'tests', 'x.test.js');
  mkdirSync(join(cache, 'work', 'runner-old-1'), { recursive: true });
  const dead = [await stub(left, true, ''), await stub(left, true, '')];
  const alien = await stub(join(foreign, 'work', 'runner-old-1', 'x.test.js'), true, ''), live = await stub(left, false, '');
  t.after(() => { rmSync(root, { recursive: true, force: true }); for (const { pid } of [...dead, alien, live]) try { process.kill(pid, 'SIGKILL'); } catch { /* gone */ } });
  const said = [];
  const fetchImpl = async () => ({ status: 200, json: async () => ({ claim: null }) });
  await serveRunner({ git: pullGit, board: BOARD, runner: 'r-leftover', capabilities: [], cache, once: true, fetchImpl, say: line => said.push(line) });
  assert.ok(said.includes('killed 2 leftover process(es) of earlier jobs'), said.join('\n'));
  await Promise.all(dead.map(entry => entry.closed));
  assert.equal(alive(alien.pid), true, 'a process naming another runner cache survives');
  assert.equal(alive(live.pid), true, "a process with a live parent, another serve's job, survives");
});

test('#7819 clause 1: the environment words of a process count only when asked, and a sibling job folder never matches [C7]', async () => {
  const rows = async environment => (environment
    ? ' 31 1 node /l/pull/land/apps/cli/pullboard.js runner local TMPDIR=/c/env/job-1/tmp/x\n 32 1 node /l/pull/land/apps/cli/pullboard.js view TMPDIR=/c/env/job-10/tmp/x\n'
    : ' 31 1 node /l/pull/land/apps/cli/pullboard.js runner local\n 32 1 node /l/pull/land/apps/cli/pullboard.js view\n');
  assert.deepEqual(await pathProcesses('/c/env/job-1', { rows }), []);
  assert.deepEqual(await pathProcesses('/c/env/job-1', { rows, environment: true }), [31]);
});

test('#7819 clause 1: the sweep after a job ends removes an orphaned local runner that names only the land clone and carries the job folder in its environment [C7]', async t => {
  const { root } = privateFixtureFiles('pullboard-leftover-');
  const mine = join(root, 'env', 'job-1'), other = join(root, 'env', 'job-2'), land = join(root, 'land', 'apps', 'cli', 'pullboard.js');
  mkdirSync(join(mine, 'tmp'), { recursive: true }); mkdirSync(join(other, 'tmp'), { recursive: true });
  const stubs = [await stub(land, true, '', { TMPDIR: join(mine, 'tmp') }), await stub(land, true, '', { TMPDIR: join(other, 'tmp') })];
  t.after(() => { rmSync(root, { recursive: true, force: true }); for (const { pid } of stubs) try { process.kill(pid, 'SIGKILL'); } catch { /* gone */ } });
  const found = await reapJob('job-1', undefined, { folder: mine, graceMs: 300 });
  assert.deepEqual(found, [stubs[0].pid]);
  await stubs[0].closed;
  assert.equal(alive(stubs[1].pid), true, "a process whose environment names another job's folder is never touched");
});
