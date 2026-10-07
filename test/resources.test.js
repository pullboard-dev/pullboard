/** Real-process resource queue and lease coverage [Q1,Q2,Q3]. */
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createInterface } from 'node:readline';
import { once } from 'node:events';
import { after, test } from 'node:test';

const TEMP = [];
const MODULE = pathToFileURL(resolve(import.meta.dirname, '../src/resources.js')).href;
const WORKER = `
import { takeResource } from ${JSON.stringify(MODULE)};
const [name, capacity, scope, root, agent] = process.argv.slice(1);
const lease = await takeResource({ name, capacity: Number(capacity), scope, root, agent, onWait: ({position, holders}) => console.log(JSON.stringify({waiting:position, holders})) });
console.log(JSON.stringify({acquired:agent}));
process.stdin.setEncoding('utf8');
for await (const line of process.stdin) { if (line.trim() === 'release') { lease.release(); break; } }
`;

/** Create isolated machine storage and a pair of real Git repositories. */
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'pullboard-resources-'));
  TEMP.push(dir);
  const home = join(dir, 'home');
  const first = join(dir, 'repo-a');
  const second = join(dir, 'repo-b');
  for (const repo of [first, second]) {
    mkdirSync(repo);
    const result = spawnSync('git', ['init', '-q', repo], { encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
  }
  return { dir, home, first, second, env: { ...process.env, PULLBOARD_HOME: home } };
}

/** Launch one independent process that takes a resource and waits for a release command. */
function worker(box, { name = 'gate', capacity = 1, scope = 'machine', root = box.first, agent }) {
  const child = spawn(process.execPath, ['--input-type=module', '-e', WORKER, name, String(capacity), scope, root, agent], {
    env: box.env, stdio: ['pipe', 'pipe', 'pipe'],
  });
  child.lines = createInterface({ input: child.stdout });
  child.errors = '';
  child.stderr.setEncoding('utf8').on('data', (chunk) => { child.errors += chunk; });
  return child;
}

/** Read the next worker event, failing promptly with its stderr if it exits unexpectedly. */
async function event(child) {
  const line = await new Promise((resolveLine, reject) => {
    const onLine = (value) => { clearTimeout(timer); child.removeListener('exit', onExit); resolveLine(value); };
    const onExit = (code, signal) => { clearTimeout(timer); child.lines.removeListener('line', onLine); reject(new Error(`worker exited ${code}/${signal}: ${child.errors}`)); };
    const timer = setTimeout(() => { child.lines.removeListener('line', onLine); child.removeListener('exit', onExit); reject(new Error(`worker timed out: ${child.errors}`)); }, 10_000);
    child.lines.once('line', onLine);
    child.once('exit', onExit);
  });
  return JSON.parse(line);
}

/** Ask a holder to release and wait for clean process exit. */
async function release(child) {
  child.stdin.end('release\n');
  const [code] = await once(child, 'exit');
  child.lines.close();
  assert.equal(code, 0, child.errors);
}

after(() => TEMP.forEach((dir) => rmSync(dir, { recursive: true, force: true })));

test('[Q1,Q2] capacity-one takers acquire in strict FIFO arrival order', async () => {
  const box = fixture();
  const holder = worker(box, { agent: 'holder' });
  assert.equal((await event(holder)).acquired, 'holder');
  const waiting = [];
  for (const agent of ['first', 'second', 'third']) {
    const child = worker(box, { agent });
    waiting.push(child);
    const state = await event(child);
    assert.equal(state.waiting, waiting.length, `${agent} reports its FIFO place`);
    assert.equal(state.holders[0].agent, 'holder', `${agent} says who holds the place`);
  }
  const order = [];
  let current = holder;
  for (const [index, child] of waiting.entries()) {
    await release(current);
    assert.equal((await event(child)).acquired, ['first', 'second', 'third'][index]);
    order.push(['first', 'second', 'third'][index]);
    current = child;
  }
  await release(current);
  assert.deepEqual(order, ['first', 'second', 'third']);
});

test('[Q3] SIGKILL of a holder frees its lease for the next process', async () => {
  const box = fixture();
  const holder = worker(box, { agent: 'doomed-holder' });
  assert.equal((await event(holder)).acquired, 'doomed-holder');
  const next = worker(box, { agent: 'successor' });
  const waiting = await event(next);
  assert.equal(waiting.waiting, 1);
  holder.kill('SIGKILL');
  await once(holder, 'exit');
  assert.equal((await event(next)).acquired, 'successor');
  await release(next);
});

test('[Q2,Q3] a SIGKILLed waiter is skipped while the next live waiter advances', async () => {
  const box = fixture();
  const holder = worker(box, { agent: 'holder' });
  assert.equal((await event(holder)).acquired, 'holder');
  const dead = worker(box, { agent: 'dead-waiter' });
  assert.equal((await event(dead)).waiting, 1);
  const live = worker(box, { agent: 'live-waiter' });
  assert.equal((await event(live)).waiting, 2);
  dead.kill('SIGKILL');
  await once(dead, 'exit');
  await release(holder);
  assert.equal((await event(live)).acquired, 'live-waiter');
  await release(live);
});

test('[Q1] machine scope is shared, repo scope stays local, and board scope names relay requirement', async () => {
  const box = fixture();
  const holder = worker(box, { agent: 'repo-a', root: box.first });
  assert.equal((await event(holder)).acquired, 'repo-a');
  const otherRepo = worker(box, { agent: 'repo-b', root: box.second });
  assert.equal((await event(otherRepo)).waiting, 1);
  await release(holder);
  assert.equal((await event(otherRepo)).acquired, 'repo-b');
  await release(otherRepo);
  const localA = worker(box, { name: 'repo-only', scope: 'repo', agent: 'repo-a', root: box.first });
  const localB = worker(box, { name: 'repo-only', scope: 'repo', agent: 'repo-b', root: box.second });
  assert.equal((await event(localA)).acquired, 'repo-a');
  assert.equal((await event(localB)).acquired, 'repo-b');
  await release(localA);
  await release(localB);
  const refused = spawnSync(process.execPath, ['--input-type=module', '-e', `import {takeResource} from ${JSON.stringify(MODULE)}; await takeResource({name:'x',capacity:1,scope:'board'});`], { env: box.env, encoding: 'utf8' });
  assert.notEqual(refused.status, 0);
  assert.match(refused.stderr, /BOARD_SCOPE_UNAVAILABLE.*relay/i);
});
