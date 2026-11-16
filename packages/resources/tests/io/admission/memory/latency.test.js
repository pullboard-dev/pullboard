/** A line of fresh requests is admitted fast while many live holders and waiters fill the machine queue [C7]. */
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { test } from 'node:test';
import { cellProject } from '../../../../../store/tests/fixtures/cell.js';
import { runFixtureChildAsync } from '../../../../../gate/tests/fixtures/child.js';

const HOLDERS = 40;
const REQUESTS = 20;

/**
 * Fill a real private machine queue with live holder and waiter processes, then release a line of fresh requesters at
 * once, each on a free resource, and report every requester's admission latency. Why: each queue turn used to read
 * every holder's identity with its own ps inside the write transaction, so a fresh line of 20 took about 10 s here.
 */
async function measuredLine(t) {
  const box = cellProject(t);
  mkdirSync(box.env.PULLBOARD_MACHINE_HOME, { recursive: true });
  for (const key of ['PULLBOARD_GATE_SLOT_HELD', 'PULLBOARD_GATE_SLOT_POOL', 'PULLBOARD_GATE_SLOT_TOKEN', 'PULLBOARD_BROWSER_SLOT_HELD']) delete box.env[key];
  const index = JSON.stringify(new URL('../../../../index.js', import.meta.url).href);
  const requester = `import { takeResource } from ${index};
const go = await new Promise(resolve => process.stdin.once('data', resolve));
const asked = Date.now();
const lease = await takeResource({ name: 'free-' + process.argv[1], capacity: 1, scope: 'machine', root: process.cwd(), agent: 'line-' + process.argv[1] });
process.stdout.write(JSON.stringify({ latencyMs: Date.now() - asked, sinceGoMs: Date.now() - Number(String(go)) }));
lease.release();`;
  const source = `import { spawn, execFileSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { takeResource } from ${index};
const root = process.cwd();
const sleepers = Array.from({ length: ${HOLDERS} }, () => spawn('sleep', ['120'], { stdio: 'ignore' }));
const requesters = [];
try {
  /** The start identity a lease records for a live PID, in the form the queue compares. */
  const started = pid => execFileSync('/bin/ps', ['-o', 'lstart=', '-p', String(pid)], { encoding: 'utf8', env: { ...process.env, TZ: 'UTC', LC_ALL: 'C', LANG: 'C' } }).trim().split(/\\s+/u).join(' ');
  const first = await takeResource({ name: 'busy', capacity: ${HOLDERS}, scope: 'machine', root, agent: 'schema' });
  const pool = first.pool;
  first.release();
  const db = new DatabaseSync(pool);
  const now = Date.now();
  for (const [index, sleeper] of sleepers.entries()) {
    const identity = started(sleeper.pid);
    db.prepare("INSERT INTO holder(token, name, pid, started, agent, repo, since, heartbeat) VALUES (?, 'busy', ?, ?, ?, ?, ?, ?)").run('h' + index, sleeper.pid, identity, 'holder-' + index, root, new Date().toISOString(), now);
    db.prepare("INSERT INTO waiter(token, name, pid, started, agent, repo, since, heartbeat) VALUES (?, 'busy', ?, ?, ?, ?, ?, ?)").run('w' + index, sleeper.pid, identity, 'waiter-' + index, root, new Date().toISOString(), now);
  }
  db.close();
  const ready = [];
  for (let index = 0; index < ${REQUESTS}; index++) {
    const child = spawn(process.execPath, ['--input-type=module', '-e', ${JSON.stringify(requester)}, String(index)], { cwd: root, env: process.env, stdio: ['pipe', 'pipe', 'inherit'] });
    let out = '';
    child.stdout.on('data', chunk => { out += chunk; });
    requesters.push(child);
    ready.push(new Promise((resolve, reject) => child.on('close', code => code === 0 ? resolve(JSON.parse(out)) : reject(new Error('requester ' + index + ' exited ' + code)))));
  }
  // Let every requester load its modules first, so the line measures the queue, not Node startup.
  await new Promise(resolve => setTimeout(resolve, 1500));
  const go = String(Date.now());
  for (const child of requesters) child.stdin.end(go);
  const results = await Promise.all(ready);
  const check = new DatabaseSync(pool);
  const kept = check.prepare("SELECT COUNT(*) AS n FROM holder WHERE name = 'busy'").get().n;
  const waiting = check.prepare("SELECT COUNT(*) AS n FROM waiter WHERE name = 'busy'").get().n;
  check.close();
  process.stdout.write(JSON.stringify({ results, kept, waiting }));
} finally {
  for (const child of [...requesters, ...sleepers]) child.kill('SIGKILL');
}
`;
  const result = await runFixtureChildAsync(process.execPath, ['--input-type=module', '-e', source], {
    cwd: box.repo, env: box.env, encoding: 'utf8', timeout: 60_000, // budget: owns 40 sleepers and 20 requesters; the old per-turn probes took about 10 s here.
  });
  assert.equal(result.status, 0, `${result.context}\n${result.stdout}\n${result.stderr}`);
  return JSON.parse(result.stdout);
}

test('a line of 20 fresh requests beside 40 live holders and 40 waiters is admitted within 3 s, each turn probing nothing [C7]', async t => {
  const { results, kept, waiting } = await measuredLine(t);
  assert.equal(results.length, REQUESTS, 'every queued requester is polled and admitted');
  assert.equal(kept, HOLDERS, 'no live holder is freed by the cached sweep');
  assert.equal(waiting, HOLDERS, 'no live waiter is dropped by the cached sweep');
  const latencies = results.map(row => row.sinceGoMs).sort((a, b) => a - b);
  t.diagnostic(`admission latency ms: median ${latencies[Math.floor(latencies.length / 2)]}, max ${latencies.at(-1)}`);
  // One ps per holder in every turn put the last of 20 cold requesters about 10 s back; a cache-only sweep keeps it near 1 s.
  assert.ok(latencies.at(-1) < 3_000, `the slowest admission took ${latencies.at(-1)}ms: ${latencies.join(', ')}`);
});
