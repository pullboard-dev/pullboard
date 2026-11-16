/** @pullboard-test-input apps/cli/src/io/commands/show.js */
/** @pullboard-world-pin: the show clause reads the shipped show command source, since a test may not launch the CLI. */
/** A landed item keeps its landing receipt's timed phases, gate split into runner wait and tests, and show --json prints them [C7,#8960]. */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { cellBoard } from '../../../store/tests/fixtures/cell.js';
import { boardJobQueueCall } from '../../index.js';
import { claimJob } from '../../index.js';
import { offerJob } from '../../index.js';

const STAMP = '2026-11-16T12:00:00.000Z';
const MAIN = 'a'.repeat(40);
const TRUNK = 'b'.repeat(40);
const PHASES = [{ phase: 'merge', ms: 120 }, { phase: 'static checks', ms: 4000 }, { phase: 'cli smoke', ms: 900 },
  { phase: 'runner wait', ms: 3500 }, { phase: 'tests', ms: 41_000 }, { phase: 'push', ms: 700 }];

/** A board with item 7 verified, and one claimed land job offered for it; returns the board and a poster for the land receipt. */
function landing(t) {
  const board = cellBoard(t, ':memory:');
  board.db.prepare(`INSERT INTO item (item_id, item_lane, item_title, item_route, item_status, item_created_by, item_created_at, item_updated_at) VALUES (7, 'core', 'landed', 'strong', 'open', 'coordinator', ?, ?)`).run(STAMP, STAMP);
  board.db.prepare(`INSERT INTO verdict (item_id, verdict_by, verdict_decision, verdict_reason, verdict_note, verdict_commit, verdict_digest, verdict_head, verdict_at)
    VALUES (7, 'core-2', 'ACCEPT', 'CRITERION_MET', 'fixture', ?, ?, ?, ?)`).run(MAIN, 'd'.repeat(64), MAIN, STAMP);
  board.db.exec('INSERT INTO temp.moving VALUES (1)');
  board.db.prepare(`UPDATE item SET item_status='verified', item_commit=?, item_owner='core-1', item_lease_until='2099-01-01T00:00:00.000Z', item_frozen_digest=?, item_built_by='core-1', item_verified_by='core-2', item_verdict='ACCEPT' WHERE item_id=7`)
    .run(MAIN, 'd'.repeat(64));
  board.db.exec('DELETE FROM temp.moving');
  offerJob(board.db, { id: 'land:1:k', kind: 'land', base: MAIN, needs: [], payload: { items: [{ id: 7 }] }, now: 1 });
  const held = claimJob(board.db, { runner: 'r-land', capabilities: [], now: 2 });
  const post = receipt => boardJobQueueCall(board, { action: 'receipt', job: 'land:1:k', runner: 'r-land', token: held.token, receipt }, { mode: 'pull', now: 3 });
  return { board, post };
}

const stored = board => board.db.prepare("SELECT meta_value FROM board_meta WHERE meta_key = 'landing_phases:7'").get();

test('clause 1: applyLandingReceipt stores the landing receipt\'s phases, with the gate split from the runner, on the landed item [C7,#8960]', t => {
  const { board, post } = landing(t);
  post({ kind: 'land', outcome: 'landed', trunk: TRUNK, landed: [7], already: [], phases: PHASES });
  assert.equal(board.db.prepare('SELECT item_merged_commit FROM item WHERE item_id = 7').get().item_merged_commit, TRUNK);
  assert.deepEqual(JSON.parse(stored(board).meta_value), PHASES);
});

test('clause 2: show --json reads those phases for the landed item and prints them as landing_phases [C7,#8960]', t => {
  const source = readFileSync(new URL('../../../../apps/cli/src/io/commands/show.js', import.meta.url), 'utf8');
  assert.match(source, /landing_phases:\$\{id\}/u);
  assert.match(source, /item\.landing_phases = JSON\.parse\(/u);
  const { board, post } = landing(t);
  assert.equal(stored(board), undefined, 'an item not yet landed has none');
  post({ kind: 'land', outcome: 'landed', trunk: TRUNK, landed: [7], already: [], phases: [{ phase: 'merge', ms: 1.5 }, { phase: 'push', ms: 9 }, { ms: 3 }] });
  assert.deepEqual(JSON.parse(stored(board).meta_value), [{ phase: 'push', ms: 9 }], 'only whole-millisecond named phases are kept');
});
