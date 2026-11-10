/** With many concurrent holders, every resource pool write holds the database briefly and waits about 2 s at most, even behind an abandoned turn [C7]. */
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { test } from 'node:test';
import { createE2eHelpers } from '../../tests/fixtures/e2e.js';
import { runFixtureChildAsync } from '../../tests/fixtures/child.js';

const HOLDERS = 30;
const RENEWS = 10;
const index = JSON.stringify(new URL('../../../../packages/resources/index.js', import.meta.url).href);

/** One holder process: take a lease, renew it, and report its longest wait and its longest write transaction. */
const holder = `import { DatabaseSync } from 'node:sqlite';
let began = 0, hold = 0;
const exec = DatabaseSync.prototype.exec;
DatabaseSync.prototype.exec = function (sql) {
  if (/^\\s*BEGIN IMMEDIATE/u.test(sql)) began = performance.now();
  const result = exec.call(this, sql);
  if (/^\\s*(COMMIT|ROLLBACK)/u.test(sql) && began) { hold = Math.max(hold, performance.now() - began); began = 0; }
  return result;
};
const { takeResource } = await import(${index});
await new Promise(resolve => process.stdin.once('data', resolve));
let wait = 0;
let at = performance.now();
const lease = await takeResource({ name: 'held-' + process.argv[1], capacity: 1, scope: 'machine', root: process.cwd(), agent: 'holder-' + process.argv[1] });
wait = Math.max(wait, performance.now() - at);
for (let renew = 0; renew < ${RENEWS}; renew++) {
  at = performance.now();
  lease.renew();
  wait = Math.max(wait, performance.now() - at);
}
lease.release();
process.stdout.write(JSON.stringify({ wait: Math.round(wait), hold: Math.round(hold) }));`;

test('30 concurrent holders behind an abandoned turn whose PID is live each write in under 100 ms and wait under 2.5 s [C7]', async t => {
  const helpers = createE2eHelpers();
  t.after(helpers.cleanup);
  const box = helpers.project();
  mkdirSync(box.env.PULLBOARD_MACHINE_HOME, { recursive: true });
  for (const key of ['PULLBOARD_GATE_SLOT_HELD', 'PULLBOARD_GATE_SLOT_POOL', 'PULLBOARD_GATE_SLOT_TOKEN', 'PULLBOARD_BROWSER_SLOT_HELD']) delete box.env[key];
  const source = `import { spawn } from 'node:child_process';
import { closeSync, existsSync, openSync, utimesSync } from 'node:fs';
import { join } from 'node:path';
import { takeResource } from ${index};
const root = process.cwd();
const setup = await takeResource({ name: 'setup', capacity: 1, scope: 'machine', root, agent: 'setup' });
const queue = setup.pool + '.writes';
setup.release();
// A waiter killed mid-wait left its turn first in line, and a long-lived process now has its PID.
const reused = spawn('sleep', ['120'], { stdio: 'ignore' });
const abandoned = join(queue, '0'.repeat(23) + '1-000000-t-' + reused.pid + '-0-deadbeef-r');
closeSync(openSync(abandoned, 'w'));
const stale = new Date(Date.now() - 10_000);
utimesSync(abandoned, stale, stale);
const children = [];
try {
  const done = [];
  for (let index = 0; index < ${HOLDERS}; index++) {
    const child = spawn(process.execPath, ['--input-type=module', '-e', ${JSON.stringify(holder)}, String(index)], { cwd: root, env: process.env, stdio: ['pipe', 'pipe', 'inherit'] });
    let out = '';
    child.stdout.on('data', chunk => { out += chunk; });
    children.push(child);
    done.push(new Promise((resolve, reject) => child.on('close', code => code === 0 ? resolve(JSON.parse(out)) : reject(new Error('holder ' + index + ' exited ' + code)))));
  }
  await new Promise(resolve => setTimeout(resolve, 1500));
  for (const child of children) child.stdin.end('go');
  const results = await Promise.all(done);
  process.stdout.write(JSON.stringify({ wait: Math.max(...results.map(row => row.wait)), hold: Math.max(...results.map(row => row.hold)), abandonedLeft: existsSync(abandoned) }));
} finally { for (const child of [...children, reused]) child.kill('SIGKILL'); }
`;
  const result = await runFixtureChildAsync(process.execPath, ['--input-type=module', '-e', source], {
    cwd: box.repo, env: box.env, encoding: 'utf8', timeout: 60_000, // budget: 30 holders and one sleeper; an unbounded wait behind the abandoned turn hung here for 300 s.
  });
  assert.equal(result.status, 0, `${result.context}\n${result.stdout}\n${result.stderr}`);
  const { wait, hold, abandonedLeft } = JSON.parse(result.stdout);
  t.diagnostic(`longest write wait ${wait} ms, longest write transaction ${hold} ms`);
  assert.equal(abandonedLeft, false, 'the abandoned turn is cleared, not waited on');
  assert.ok(hold < 100, `the longest write transaction held the database ${hold} ms`);
  assert.ok(wait < 2_500, `the longest write waited ${wait} ms`);
});
