/** Health names each active seat that joined without a model, by seat id, and says nothing when every seat declared one [C7,#9696]. */
import assert from 'node:assert/strict';
import { join } from 'node:path';
import {
  after,
  test,
} from 'node:test';
import { closeBoard } from '../../../../../../packages/store/index.js';
import { register } from '../../../../../../packages/store/index.js';
import { FIXTURE_MODEL } from '../../../../../../packages/store/tests/fixtures/cell.js';
import { openKitBoard } from '../../../../../../packages/store/tests/fixtures/cell.js';
import { createE2eHelpers } from '../../../fixtures/e2e.js';

const e2e = createE2eHelpers();
after(e2e.cleanup);

/** A project whose board holds seats registered as `models` says: a model name, or null for none. Returns the seat ids in order. */
function projectWithSeats(models) {
  const box = e2e.project(undefined, undefined, { withWorktree: false });
  const board = openKitBoard(join(box.repo, '.git', 'pullboard', 'board.sqlite'));
  try {
    const ids = models.map((model, index) => register(board, { lane: 'web', path: `/seeded/seat-${index}`, route: 'strong', family: 'Fixture-Builder', model: FIXTURE_MODEL }));
    models.forEach((model, index) => {
      if (model === null) board.db.prepare('DELETE FROM board_meta WHERE meta_key = ?').run(`agent_model:${ids[index]}`);
      else if (model !== FIXTURE_MODEL) board.db.prepare('UPDATE board_meta SET meta_value = ? WHERE meta_key = ?').run(model, `agent_model:${ids[index]}`);
    });
    return { box, ids };
  } finally { closeBoard(board); }
}

/** The SEAT_NO_MODEL findings health reports, from its JSON. */
async function noModelFindings(box) {
  const health = await box.runLocal(box.repo, 'health', '--json');
  return JSON.parse(health.out).stuck.filter(entry => entry.cause === 'SEAT_NO_MODEL');
}

test('cli.journeys-health-seats-no-model.health-lists-each-seat-whose-recorded: clause 1: health lists each seat whose recorded model is missing or unknown, by seat id [C7,#9696]', async () => {
  const { box, ids } = projectWithSeats([null, 'unknown', FIXTURE_MODEL]);
  const found = await noModelFindings(box);
  assert.deepEqual(found.map(entry => entry.subject).sort(), [ids[0], ids[1]].sort());
});

test('cli.journeys-health-seats-no-model.a-board-whose-seats-all-declared: clause 2: a board whose seats all declared a model prints no such line [C7,#9696]', async () => {
  const { box } = projectWithSeats([FIXTURE_MODEL, FIXTURE_MODEL]);
  assert.deepEqual(await noModelFindings(box), []);
  const text = await box.runLocal(box.repo, 'health');
  assert.doesNotMatch(text.out, /joined without a model/u);
});
