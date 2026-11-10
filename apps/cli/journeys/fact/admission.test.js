/** A gate's own follow-up run, such as its main comparison, is admitted ahead of newer gates, within a bounded credit [C7]. */
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { test } from 'node:test';
import { orderedWaiters } from '../../../../packages/queue/index.js';
import { FOLLOW_UP_CREDIT_MS } from '../../../../packages/queue/index.js';
import { ARRIVAL_ORDER } from '../../../../packages/queue/index.js';
import { createE2eHelpers } from '../../tests/fixtures/e2e.js';
import { runFixtureChildAsync } from '../../tests/fixtures/child.js';

const NOW = Date.parse('2026-11-09T07:30:00.000Z');

/** One waiting row as the queue reads it, arriving `minutesAgo` before NOW. */
function waiter(ticket, kind, minutesAgo, extra = {}) {
  return { ticket, kind, landing: 0, since: new Date(NOW - minutesAgo * 60_000).toISOString(), followUpAware: 1, ...extra };
}

/** The line's kinds and tickets in admission order. */
function order(line) {
  return orderedWaiters(line, NOW, ARRIVAL_ORDER).map(row => `${row.kind}#${row.ticket}`);
}

test('clause 1: a main comparison passes newer gates and gates that arrived inside its credit, never a landing [C7]', () => {
  const line = [waiter(1, 'landing', 1, { landing: 1 }), waiter(2, 'submit', 6), waiter(3, 'submit', 5), waiter(4, 'review', 3), waiter(5, 'main-red', 2), waiter(6, 'submit', 1)];
  assert.deepEqual(order(line), ['landing#1', 'main-red#5', 'submit#2', 'submit#3', 'review#4', 'submit#6']);
});

test('clause 2: a gate that waited longer than the credit keeps its place ahead of a follow-up, so no new gate starves [C7]', () => {
  const credit = FOLLOW_UP_CREDIT_MS / 60_000;
  const line = [waiter(1, 'submit', credit + 5), waiter(2, 'submit', 4), waiter(3, 'main-red', 2), waiter(4, 'main-red', 1)];
  assert.deepEqual(order(line), ['submit#1', 'main-red#3', 'main-red#4', 'submit#2']);
});

test('clause 3: with any waiter from a client that does not know follow-ups, the line keeps its plain order [C7]', () => {
  const line = [waiter(1, 'submit', 5, { followUpAware: 0 }), waiter(2, 'main-red', 1)];
  assert.deepEqual(order(line), ['submit#1', 'main-red#2']);
});

test('clause 1: on a real pool a queued main comparison takes the freed slot before three earlier gates [C7]', async t => {
  const helpers = createE2eHelpers();
  t.after(helpers.cleanup);
  const box = helpers.project();
  mkdirSync(box.env.PULLBOARD_MACHINE_HOME, { recursive: true });
  for (const key of ['PULLBOARD_GATE_SLOT_HELD', 'PULLBOARD_GATE_SLOT_POOL', 'PULLBOARD_GATE_SLOT_TOKEN', 'PULLBOARD_BROWSER_SLOT_HELD']) delete box.env[key];
  const source = `import { takeResource } from ${JSON.stringify(new URL('../../../../packages/resources/index.js', import.meta.url).href)};
const root = process.cwd();
const base = { name: 'line', capacity: 1, scope: 'machine', root };
const holder = await takeResource({ ...base, agent: 'holder', kind: 'submit' });
const admitted = [];
const queued = [];
/** Queue one request and wait until its row is in the line, so arrival order is fixed. */
async function ask(agent, kind) {
  let seen;
  const waiting = new Promise(resolve => { seen = resolve; });
  const lease = takeResource({ ...base, agent, kind, onWait: () => seen() }).then(lease => { admitted.push(agent); lease.release(); });
  queued.push(lease);
  await waiting;
}
for (const agent of ['gate-a', 'gate-b', 'gate-c']) await ask(agent, 'submit');
await ask('comparison', 'main-red');
holder.release();
await Promise.all(queued);
process.stdout.write(JSON.stringify(admitted));
`;
  const result = await runFixtureChildAsync(process.execPath, ['--input-type=module', '-e', source], {
    cwd: box.repo, env: box.env, encoding: 'utf8', timeout: 30_000, // budget: one private pool and five local leases, no runners.
  });
  assert.equal(result.status, 0, `${result.context}\n${result.stdout}\n${result.stderr}`);
  assert.deepEqual(JSON.parse(result.stdout), ['comparison', 'gate-a', 'gate-b', 'gate-c']);
});
