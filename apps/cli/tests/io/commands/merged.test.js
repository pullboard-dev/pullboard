/** pullboard merged passes slices.composeLanding to the store, so a parent's landing closes its slices only when the setting is on [C7,#2397,#11354]. */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { after } from 'node:test';
import { test } from 'node:test';
import { createE2eHelpers } from '../../fixtures/e2e.js';
import { withFixtureBoard } from '../../fixtures/board.js';
import { fileFixtureItem } from '../../fixtures/testkit.js';
import { fixtureProjectPolicy } from '../../fixtures/testkit.js';

const e2e = createE2eHelpers();
after(e2e.cleanup);

/** A project with the setting as given, one open parent and one submitted slice of it. */
function landingBox(composeLanding) {
  const box = e2e.project('true');
  if (composeLanding !== undefined) {
    const config = { ...JSON.parse(readFileSync(join(box.repo, 'pullboard.json'), 'utf8')), slices: { composeLanding } };
    fixtureProjectPolicy(box.repo, { config });
    box.git(box.repo, 'add', 'pullboard.json');
    box.git(box.repo, 'commit', '-q', '-m', 'chore: set slices.composeLanding');
  }
  const parent = fileFixtureItem(box, box.repo, { lane: 'web', title: 'Parent' }).item_id;
  const slice = fileFixtureItem(box, box.repo, { lane: 'web', title: 'Slice' }).item_id;
  const file = join(box.repo, '.git', 'pullboard', 'board.sqlite');
  withFixtureBoard(file, board => {
    // The status guard admits a write only while the move token is set, as moveItem sets it, so the fixture states a submitted slice this way.
    board.db.exec('INSERT INTO temp.moving (token) VALUES (1)');
    try { board.db.prepare("UPDATE item SET item_parent_id = ?, item_status = 'submitted', item_built_by = 'fixture-seat', item_commit = ?, item_frozen_digest = 'fixture' WHERE item_id = ?").run(parent, 'c'.repeat(40), slice); } finally { board.db.exec('DELETE FROM temp.moving'); }
    board.db.prepare('INSERT INTO board_meta(meta_key, meta_value) VALUES (?, ?)').run(`item-slice:${slice}`, '{}');
  });
  return { box, parent, slice, file };
}

/** The parent's landing as the lander records it, and the slice's row afterwards. */
async function land({ box, parent, slice, file }) {
  const commit = box.git(box.repo, 'rev-parse', 'HEAD').trim();
  const merged = await box.runLocal(box.repo, 'merged', String(parent), commit, '--forced', 'landed by hand', '--waive-proof', 'fixture', '--json');
  assert.equal(merged.code, 0, merged.out + merged.err);
  const row = withFixtureBoard(file, board => board.db.prepare('SELECT item_status, item_withdrawn_reason FROM item WHERE item_id = ?').get(slice));
  return { commit, row };
}

test('cli.io-commands-merged.compose-landing-on: clause 1: with slices.composeLanding on, pullboard merged records the parent landed and withdraws its submitted slice as landed with the parent [C7,#2397]', async () => {
  const given = landingBox(true);
  const { commit, row } = await land(given);
  assert.equal(row.item_status, 'withdrawn');
  assert.equal(row.item_withdrawn_reason, `landed with parent #${given.parent} at ${commit.slice(0, 12)}`);
});

test('cli.io-commands-merged.compose-landing-off: clause 2: with the setting off, the same landing leaves the slice submitted [C7,#2397]', async () => {
  const { row } = await land(landingBox());
  assert.equal(row.item_status, 'submitted');
});
