/** pullboard search prints the nearest items by TF-IDF score, says so when none match, and never writes the board [C7]. */
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { join } from 'node:path';
import { after } from 'node:test';
import { test } from 'node:test';
import { createE2eHelpers } from '../../tests/fixtures/e2e.js';
import { fileFixtureItem } from '../../tests/fixtures/testkit.js';

const e2e = createE2eHelpers();
after(e2e.cleanup);

/** A project with three items whose titles share no words. */
function seeded() {
  const box = e2e.project();
  const file = (title, criterion) => fileFixtureItem(box, box.repo, { lane: 'web', title, criterion, check: 'true', args: ['--specs', 'G1'] }).item_id;
  return {
    box,
    landing: file('Landing queue stalls when the runner quarantine fills', 'The landing queue drains after a runner quarantine.'),
    cockpit: file('Tidy the cockpit header gradient', 'The header shows the lane name in plain type.'),
    relay: file('Relay reconnects after a laptop sleeps', 'The relay link survives sleep.'),
  };
}

/** How many events the board holds, read straight from its database. */
function eventCount(box) {
  const db = new DatabaseSync(join(box.repo, '.git', 'pullboard', 'board.sqlite'), { readOnly: true });
  try { return db.prepare('SELECT COUNT(*) AS n FROM event').get().n; } finally { db.close(); }
}

test('clause 1: search lists the nearest item first with its id, score and title [C7]', async () => {
  const { box, landing, cockpit } = seeded();
  const found = await box.runLocal(box.web, 'search', 'quarantined runners stall the landing queue');
  assert.equal(found.code, 0, `${found.out}\n${found.err}`);
  const lines = found.out.trim().split('\n');
  assert.ok(lines.every(line => !line.startsWith('next:')), 'the results are the whole output');
  assert.match(lines[0], new RegExp(`^\\d\\.\\d{3}  #${landing}  \\w+  Landing queue stalls`), lines[0]);
  const scores = lines.map(line => Number(line.split('  ')[0]));
  assert.deepEqual(scores, [...scores].sort((a, b) => b - a), 'best first');
  const other = await box.runLocal(box.web, 'search', 'cockpit', 'header', 'gradient');
  assert.match(other.out.trim().split('\n')[0], new RegExp(`#${cockpit}  `));
});

test('clause 2: a query with no match prints one line saying so and exits 0 [C7]', async () => {
  const { box } = seeded();
  const none = await box.runLocal(box.web, 'search', 'zebra');
  assert.equal(none.code, 0, `${none.out}\n${none.err}`);
  assert.equal(none.out, 'no matching items\n');
});

test('clause 3: search writes nothing to the board [C7]', async () => {
  const { box } = seeded();
  const before = eventCount(box);
  for (const query of ['relay sleep', 'zebra', 'landing queue']) assert.equal((await box.runLocal(box.web, 'search', query)).code, 0);
  assert.equal(eventCount(box), before);
});
