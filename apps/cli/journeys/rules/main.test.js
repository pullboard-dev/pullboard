/** pullboard rules replays the board's event log through the lifecycle rules, lists each disagreement by event id, and never writes the board [C7]. */
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { after } from 'node:test';
import { test } from 'node:test';
import { createE2eHelpers } from '../../tests/fixtures/e2e.js';
import { fileFixtureItem } from '../../tests/fixtures/testkit.js';

const e2e = createE2eHelpers();
after(e2e.cleanup);

/** A project with one item, then a recorded landing the rules refuse: the item merged while still open. */
function seeded() {
  const box = e2e.project();
  const id = fileFixtureItem(box, box.repo, { lane: 'web', title: 'Rules trial fixture item', criterion: 'The fixture is valid.', check: 'true', args: ['--specs', 'G1'] }).item_id;
  const file = join(box.repo, '.git', 'pullboard', 'board.sqlite');
  const db = new DatabaseSync(file);
  let rogue;
  try {
    rogue = Number(db.prepare("INSERT INTO event (event_at, event_by, event_kind, item_id, event_detail) VALUES ('2026-11-15T00:00:00.000Z', 'coordinator', 'merged', ?, ?)")
      .run(id, JSON.stringify({ commit: 'a'.repeat(40), forced: true, from: 'open' })).lastInsertRowid);
  } finally { db.close(); }
  return { box, id, file, rogue };
}

/** The board's rows and a digest of its item and event tables, read straight from its database. */
function snapshot(file) {
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    const events = db.prepare('SELECT event_id, event_at, event_by, event_kind, item_id, event_detail FROM event ORDER BY event_id').all();
    const items = db.prepare('SELECT * FROM item ORDER BY item_id').all();
    return createHash('sha256').update(JSON.stringify([events, items])).digest('hex') + `:${events.length}`;
  } finally { db.close(); }
}

test('clause 1: rules evaluates the lifecycle over the existing events and leaves the board byte for byte unchanged [C7]', async () => {
  const { box, file } = seeded();
  const before = snapshot(file);
  const bytes = createHash('sha256').update(readFileSync(file)).digest('hex');
  const ran = await box.runLocal(box.web, 'rules');
  assert.equal(ran.code, 0, `${ran.out}\n${ran.err}`);
  assert.match(ran.out, /^lifecycle rules v\d+ agree with \d+ of \d+ recorded moves \(\d+\.\d\d%\); \d+ disagree$/mu);
  assert.equal(snapshot(file), before, 'no event or item row changed');
  assert.equal(createHash('sha256').update(readFileSync(file)).digest('hex'), bytes, 'the database file is untouched');
});

test('clause 2: rules reports the agreement count and lists each disagreement with its event id [C7]', async () => {
  const { box, id, rogue } = seeded();
  const ran = await box.runLocal(box.web, 'rules', '--json');
  assert.equal(ran.code, 0, `${ran.out}\n${ran.err}`);
  const report = JSON.parse(ran.out);
  assert.equal(report.disagreementCount, 1);
  assert.equal(report.judged - report.agreed, 1);
  assert.equal(report.rate, report.agreed / report.judged);
  assert.deepEqual(report.disagreements.map(d => [d.event, d.item, d.kind]), [[rogue, id, 'merged: NOT_VERIFIED (forced from open)']]);
  const text = await box.runLocal(box.web, 'rules');
  assert.match(text.out, new RegExp(`^  event ${rogue}  #${id}  coordinator  merged: NOT_VERIFIED \\(forced from open\\)`, 'mu'));
});

test('clause 2: --limit prints the first N disagreements and says how many were left out [C7]', async () => {
  const { box } = seeded();
  const none = await box.runLocal(box.web, 'rules', '--limit', '0');
  assert.equal(none.code, 0, `${none.out}\n${none.err}`);
  assert.match(none.out, /\.\.\. 1 more; omit --limit to list them all/u);
  assert.doesNotMatch(none.out, /^disagreements:$/mu);
});
