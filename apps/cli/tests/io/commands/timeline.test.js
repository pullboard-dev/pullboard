/** pullboard timeline on the fixture board: one item's stages, then the fleet's medians and shares, read only [C7,#12148]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fixture } from '../../fixtures/next/take.js';
import { cli } from '../../fixtures/next/take.js';
import { runCliInProcess } from '../../fixtures/process.js';
import * as store from '../../../../../packages/store/index.js';

/** Run the real command with a person-facing text view. */
const text = (box, ...args) => runCliInProcess(args, { cwd: box.root, env: { ...process.env, PULLBOARD_FIXTURE_BOARD: '1' } });

test('cli.journey.timeline-item: clause 1: pullboard timeline <id> and --json print the stages of an item that was added, claimed and submitted [C7,#12148]', async t => {
  const box = await fixture(t);
  const id = box.add('Timeline item');
  box.advance(30_000);
  box.claim(id);
  box.advance(60_000);
  box.submit(id);
  const shown = await cli(box, box.root, ['timeline', String(id)]);
  assert.equal(shown.code, 0, shown.out + shown.err);
  const document = shown.document;
  assert.equal(document.version, 1);
  assert.equal(document.item, id);
  assert.deepEqual(document.rows.map(row => row.stage), ['filed', 'claimed', 'submitted']);
  assert.ok(document.summary.total_ms >= 90_000);
  assert.ok(Array.isArray(document.unmapped));
  const plain = await text(box, 'timeline', String(id));
  assert.equal(plain.status, 0, plain.stdout + plain.stderr);
  assert.equal(plain.stdout.split('\n').filter(line => /\b(filed|claimed|submitted)\b/u.test(line) && /\+|\d{4}-\d\d-\d\dT/u.test(line)).length, 3);
  assert.match(plain.stdout, /total .*UNACCOUNTED/u);
});

test('cli.journey.timeline-fleet: clause 2: pullboard timeline --fleet --since 3h and --json list both items with stage medians and bucket shares [C7,#12148]', async t => {
  const box = await fixture(t);
  const first = box.add('First timeline item');
  const second = box.add('Second timeline item');
  box.advance(30_000);
  box.claim(first);
  box.claim(second, box.seats.actor);
  const fleet = await cli(box, box.root, ['timeline', '--fleet', '--since', '3h']);
  assert.equal(fleet.code, 0, fleet.out + fleet.err);
  assert.equal(fleet.document.version, 1);
  assert.equal(fleet.document.summary.items >= 2, true);
  assert.ok(fleet.document.summary.stages.filed.median_ms >= 0);
  assert.ok(Object.keys(fleet.document.summary.share.buckets).length > 0);
  const plain = await text(box, 'timeline', '--fleet', '--since', '3650d');
  assert.equal(plain.status, 0, plain.stdout + plain.stderr);
  assert.match(plain.stdout, /bucket share/u);
  assert.match(plain.stdout, /slowest #/u);
});

test('cli.journey.timeline-merged-and-recorded: clause 3: pullboard timeline on an item merged ten minutes after its commit shows merged at the commit time and recorded at the record time [C7,#12156]', async t => {
  const box = await fixture(t);
  const id = box.add('Landed by hand');
  const committedAt = box.clock.now().getTime();
  box.advance(10 * 60_000);
  store.merged(box.board, id, { agentId: 'coordinator', commit: 'c'.repeat(40), forced: 'landed by hand', waiveProof: 'test fixture', mergedAt: committedAt });
  const recordedAt = box.board.db.prepare("SELECT event_at FROM event WHERE event_kind = 'merged' AND item_id = ?").get(id).event_at;
  assert.equal(Date.parse(recordedAt) - committedAt, 10 * 60_000, 'the record trails the commit by ten minutes');
  const plain = await text(box, 'timeline', String(id));
  assert.equal(plain.status, 0, plain.stdout + plain.stderr);
  const lines = plain.stdout.split('\n');
  assert.ok(lines.some(line => line.startsWith(new Date(committedAt).toISOString()) && /\bmerged\b/u.test(line)), `merged is placed at the commit time:\n${plain.stdout}`);
  assert.ok(lines.some(line => line.startsWith(new Date(recordedAt).toISOString()) && /\brecorded\b/u.test(line)), `recorded is placed at the record time:\n${plain.stdout}`);
});
