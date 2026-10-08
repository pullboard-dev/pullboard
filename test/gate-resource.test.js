/** Real CLI gate processes share the machine FIFO, skip cached trees and release after a crash [Q4,O5,O6]. */
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { after, test } from 'node:test';

const BIN = resolve(import.meta.dirname, '../bin/pullboard.js');
const TEMP = [];
const CHILDREN = new Set();

/** Quote a fixture path for the gate shell command. */
function quote(value) { return `'${value.replaceAll("'", "'\\''")}'`; }

/** Create one private machine home, event file and isolated Git environment. */
function fixture() {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'pullboard-gate-queue-')));
  TEMP.push(dir);
  const events = join(dir, 'events.log');
  const env = {
    ...process.env,
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_AUTHOR_NAME: 'Queue Test',
    GIT_AUTHOR_EMAIL: 'queue@example.invalid',
    GIT_COMMITTER_NAME: 'Queue Test',
    GIT_COMMITTER_EMAIL: 'queue@example.invalid',
    PULLBOARD_HOME: join(dir, 'home'),
  };
  return { dir, events, env };
}

/** Create a clean gate repo whose start and end record observable execution, optionally waiting for a release file. */
function gateRepo(box, name, delay = 0.25, releaseFile = null) {
  const root = join(box.dir, name);
  mkdirSync(root);
  const git = (...args) => spawnSync('git', args, { cwd: root, env: box.env, encoding: 'utf8' });
  assert.equal(git('init', '-q', '-b', 'main').status, 0);
  const wait = releaseFile ? `while [ ! -e ${quote(releaseFile)} ]; do sleep 0.02; done` : `sleep ${delay}`;
  const command = `printf '${name} start\\n' >> ${quote(box.events)}; ${wait}; printf '${name} end\\n' >> ${quote(box.events)}`;
  writeFileSync(join(root, 'pullboard.json'), JSON.stringify({ gate: command }));
  writeFileSync(join(root, 'SPEC.md'), '# Queue fixture\n');
  assert.equal(git('add', '-A').status, 0);
  assert.equal(git('commit', '-q', '-m', 'chore: queue fixture').status, 0);
  return root;
}

/** Launch a real gate CLI in its own process group and collect its output. */
function launch(box, root) {
  const child = spawn(process.execPath, [BIN, 'gate'], { cwd: root, env: box.env, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdoutText = '';
  child.stderrText = '';
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (chunk) => { child.stdoutText += chunk; });
  child.stderr.on('data', (chunk) => { child.stderrText += chunk; });
  CHILDREN.add(child);
  child.closed = new Promise((resolveClose) => child.once('close', (code, signal) => {
    CHILDREN.delete(child);
    resolveClose({ code, signal });
  }));
  return child;
}

/** Wait until an observable fixture state is reached, or fail with a useful timeout. */
async function waitFor(predicate, description, timeoutMs = 30_000) {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    const value = predicate();
    if (value) return value;
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 20));
  }
  throw new Error(`timed out waiting for ${description}`);
}

/** Read the current private event log. */
function events(box) {
  return existsSync(box.events) ? readFileSync(box.events, 'utf8').trim().split(/\r?\n/u).filter(Boolean) : [];
}

after(async () => {
  const running = [...CHILDREN];
  for (const child of running) {
    try { process.kill(-child.pid, 'SIGKILL'); } catch { /* The fixture process already ended. */ }
  }
  await Promise.all(running.map((child) => child.closed));
  TEMP.forEach((dir) => rmSync(dir, { recursive: true, force: true }));
});

test('[Q4,O5,O6] gate processes run one at a time in FIFO order when machine slots are one', async () => {
  const box = fixture();
  const releaseFirst = join(box.dir, 'release-first');
  const roots = ['first', 'second', 'third'].map((name) => gateRepo(box, name, name === 'first' ? 0.1 : 0.2, name === 'first' ? releaseFirst : null));
  const setting = spawnSync(process.execPath, [BIN, 'settings', 'gateSlots', '1', '--json'], { cwd: roots[0], env: box.env, encoding: 'utf8' });
  assert.equal(setting.status, 0, setting.stderr);
  assert.equal(JSON.parse(setting.stdout).settings.gateSlots, 1);
  const first = launch(box, roots[0]);
  await waitFor(() => events(box).includes('first start') && !events(box).includes('first end'), 'first gate to remain active', 30_000);
  const second = launch(box, roots[1]);
  await waitFor(() => second.stdoutText.includes('place 1'), 'second gate to enter the FIFO line');
  assert.match(second.stdoutText, /1 running/);
  assert.ok(second.stdoutText.includes(roots[0]), 'wait report names the repo holding the slot');
  const third = launch(box, roots[2]);
  await waitFor(() => third.stdoutText.includes('place 2'), 'third gate to enter behind the second');
  assert.ok(events(box).includes('first start') && !events(box).includes('first end'), 'both successors queued while the first gate still held its slot');
  writeFileSync(releaseFirst, 'release\n');
  const results = await Promise.all([first.closed, second.closed, third.closed]);
  assert.deepEqual(results.map(({ code }) => code), [0, 0, 0], `${first.stderrText}${second.stderrText}${third.stderrText}`);
  const starts = events(box).filter((line) => line.endsWith(' start')).map((line) => line.split(' ')[0]);
  assert.deepEqual(starts, ['first', 'second', 'third']);
  let running = 0;
  let maximum = 0;
  for (const line of events(box)) {
    if (line.endsWith(' start')) running += 1;
    else running -= 1;
    maximum = Math.max(maximum, running);
  }
  assert.equal(maximum, 1);
});

test('[Q4] an exact-tree cached gate starts while another machine gate holds the only slot', async () => {
  const box = fixture();
  const cachedRoot = gateRepo(box, 'cached', 0.1);
  const releaseHolder = join(box.dir, 'release-holder');
  const holderRoot = gateRepo(box, 'holder', 0.1, releaseHolder);
  assert.equal(spawnSync(process.execPath, [BIN, 'settings', 'gateSlots', '1'], { cwd: holderRoot, env: box.env }).status, 0);
  const warm = spawnSync(process.execPath, [BIN, 'gate'], { cwd: cachedRoot, env: box.env, encoding: 'utf8' });
  assert.equal(warm.status, 0, warm.stderr);
  const priorCount = events(box).filter((line) => line.startsWith('cached ')).length;
  const holder = launch(box, holderRoot);
  await waitFor(() => events(box).includes('holder start') && !events(box).includes('holder end'), 'uncached holder gate to remain active', 30_000);
  const refusedChange = spawnSync(process.execPath, [BIN, 'settings', 'gateSlots', '2', '--json'], { cwd: cachedRoot, env: box.env, encoding: 'utf8' });
  assert.equal(refusedChange.status, 1);
  assert.equal(JSON.parse(refusedChange.stdout).error.code, 'RESOURCE_BUSY');
  assert.equal(JSON.parse(readFileSync(join(box.env.PULLBOARD_HOME, 'settings.json'), 'utf8')).gateSlots, 1);
  const cached = spawnSync(process.execPath, [BIN, 'gate'], { cwd: cachedRoot, env: box.env, encoding: 'utf8', timeout: 30_000 });
  assert.equal(cached.status, 0, cached.stderr);
  assert.match(cached.stdout, /already passed/);
  assert.ok(events(box).includes('holder start') && !events(box).includes('holder end'), 'cached gate returned while the other machine gate still held its slot');
  assert.equal(events(box).filter((line) => line.startsWith('cached ')).length, priorCount, 'cached gate command did not run again');
  writeFileSync(releaseHolder, 'release\n');
  assert.equal((await holder.closed).code, 0, holder.stderrText);
  assert.ok(events(box).includes('holder end'), 'the holder exits only after the test releases it');
});

test('[Q4] SIGKILL during a gate releases its machine slot for the next process', async () => {
  const box = fixture();
  const deadRoot = gateRepo(box, 'dead', 20);
  const nextRoot = gateRepo(box, 'next', 0.1);
  assert.equal(spawnSync(process.execPath, [BIN, 'settings', 'gateSlots', '1'], { cwd: deadRoot, env: box.env }).status, 0);
  const dead = launch(box, deadRoot);
  await waitFor(() => events(box).includes('dead start'), 'gate to hold a slot before it is killed');
  const next = launch(box, nextRoot);
  await waitFor(() => next.stdoutText.includes('place 1'), 'successor gate to queue');
  process.kill(-dead.pid, 'SIGKILL');
  assert.equal((await dead.closed).signal, 'SIGKILL');
  const result = await Promise.race([
    next.closed,
    new Promise((_, reject) => setTimeout(() => reject(new Error('successor did not acquire the freed slot')), 5_000)),
  ]);
  assert.equal(result.code, 0, next.stderrText);
  assert.ok(events(box).includes('next start'));
});
