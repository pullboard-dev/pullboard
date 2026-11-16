/** `pullboard stats` prints an item's runner cost next to its token cost once a rate card is set [C7]. */
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { mkdirSync } from 'node:fs';
import { after } from 'node:test';
import { test } from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { createE2eHelpers } from '../../tests/fixtures/e2e.js';
import { fileFixtureItem } from '../../tests/fixtures/testkit.js';
import { FIXTURE_MODEL } from '../../tests/fixtures/testkit.js';
import { fixtureMachineSettings } from '../../tests/fixtures/testkit.js';

const helpers = createE2eHelpers();
after(helpers.cleanup);

const MINUTE = 60_000;
const BIG_CARD = { price: 0, months: 1, watts: 1000, kwhPrice: 6 };

/** A project with one item holding token cost and two check-run receipts, both on the runner "big". */
async function costedItem() {
  const box = helpers.project('true', undefined, { withWorktree: false });
  const item = await fileFixtureItem(box, box.repo, { lane: 'web', title: 'Runner cost fixture', run: box.runLocal });
  const id = item.item_id;
  // Seeds the recorded token cost and check-run receipts that the CLI then reads.
  const db = new DatabaseSync(join(box.repo, '.git', 'pullboard', 'board.sqlite'));
  try {
    db.prepare('INSERT INTO board_meta(meta_key, meta_value) VALUES(?, ?)')
      .run(`cost:${id}:a`, JSON.stringify({ item: id, agent: 'coordinator', observedAt: 0, records: [{ model: FIXTURE_MODEL, inputTokens: 10, outputTokens: 5 }] }));
    for (const [check, minutes] of [['a', 10], ['b', 2]]) {
      db.prepare("INSERT INTO event(event_at, event_by, event_kind, item_id, event_detail) VALUES('2026-11-16T00:00:00.000Z', 'coordinator', 'proof-run', ?, ?)")
        .run(id, JSON.stringify({ receipt: { id: check, kind: 'check', runner: 'big', durationMs: minutes * MINUTE } }));
    }
  } finally { db.close(); }
  return { box, id };
}

/** The usage line `pullboard stats` prints for one item. */
async function itemLine(box, id) {
  const result = await box.runLocal(box.repo, 'stats');
  assert.equal(result.code, 0, result.out + result.err);
  return result.out.split('\n').find(line => line.startsWith(`usage items ${id}:`));
}

test('clause 1: stats prints an item runner cost next to its token cost when a rate card is set [C7]', async () => {
  const { box, id } = await costedItem();
  const before = await itemLine(box, id);
  assert.match(before, /output 5/u);
  assert.doesNotMatch(before, /runner cost/u, 'without a rate card the line is unchanged');
  mkdirSync(box.env.PULLBOARD_MACHINE_HOME, { recursive: true });
  fixtureMachineSettings(box.env.PULLBOARD_MACHINE_HOME, { runnerRates: { big: BIG_CARD } });
  const line = await itemLine(box, id);
  assert.match(line, /output 5/u, 'the token figures are still on the line');
  assert.match(line, /; runner cost USD 1\.200000 \(12\.0 min on big\)$/u);
});
