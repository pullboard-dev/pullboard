/** With gate.redFactLocation on, a pulled gate red from a static check names the file:line places it reported; off, the fact is unchanged [C7,#9083]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { cellBoard } from '../../../../store/tests/fixtures/cell.js';
import { cellClaim } from '../../../../store/tests/fixtures/cell.js';
import { cellItem } from '../../../../store/tests/fixtures/cell.js';
import { cellRepo } from '../../../../store/tests/fixtures/cell.js';
import { cellSeat } from '../../../../store/tests/fixtures/cell.js';
import * as store from '../../../../store/index.js';
import { settingsInventory } from '../../../../config/index.js';
import { boardJobQueueCall } from '../../../index.js';
import { claimJob } from '../../../index.js';
import { offerJob } from '../../../index.js';

const STATIC_TEXT = 'static checks are red; fix the named source before running proof:\n'
  + ['packages/a/src/one.js:12: no unused imports', 'packages/a/src/two.js:40: file too long', 'packages/b/src/three.js:7: bad name', 'packages/b/src/four.js:99: bad name'].join('\n');

/** Post one red gate receipt whose static part refused with STATIC_TEXT, with the setting passed as the board host reads it; returns the red fact's text. */
function redFact(t, setting) {
  const repo = cellRepo(t, { real: true });
  const board = cellBoard(t, repo.boardFile, undefined, { real: true, gitRoot: repo.root });
  board.gitRoot = repo.root;
  const seat = cellSeat(board, { lane: 'web', path: `${repo.root}/seat` });
  const item = cellItem(board, { lane: 'web', title: 'Build the page' });
  cellClaim(board, item.item_id, seat, { root: repo.root });
  const held = store.getItem(board, item.item_id);
  const head = repo.commit;
  const tree = 'b'.repeat(40);
  const job = `gate:${item.item_id}:red`;
  offerJob(board.db, { id: job, kind: 'gate', needs: [], item: item.item_id, candidate: head, base: head, now: 1,
    request: { run: ['true'], input: { data: {} }, submit: { agentId: seat.id, digest: held.item_frozen_digest, tree, files: [] } } });
  const lease = claimJob(board.db, { runner: 'r-red', capabilities: [], now: 2 });
  const posted = boardJobQueueCall(board, { action: 'receipt', job, runner: 'r-red', token: lease.token,
    receipt: { version: 1, status: 1, gate: { source: head, green: false, analysis: { refusals: [{ part: 'static', code: 'GATE_RED', message: STATIC_TEXT }] }, phases: [] } } }, { mode: 'pull', now: 3, ...(setting === undefined ? {} : { redLocation: setting }) });
  assert.equal(posted.applied.outcome, 'red');
  return store.itemThread(board, item.item_id).map(fact => fact.text ?? '').find(text => text.startsWith(`Gate job ${job} red`));
}

test('api.gate-red-location.gate-redfactlocation-static-red-names: clause 1: with gate.redFactLocation on, a static red names the first three file:line places and counts the rest [C7,#9083]', t => {
  const fact = redFact(t, true);
  assert.match(fact, /red at: packages\/a\/src\/one\.js:12, packages\/a\/src\/two\.js:40, packages\/b\/src\/three\.js:7; 1 more/u);
});

test('api.gate-red-location.gate-redfactlocation-off-unset-red: clause 2: with gate.redFactLocation off or unset, the red fact carries no location line [C7,#9083]', t => {
  assert.doesNotMatch(redFact(t, undefined), /red at:/u);
  assert.doesNotMatch(redFact(t, false), /red at:/u);
});

test('api.gate-red-location.gate-redfactlocation-described-setting-off: clause 3: gate.redFactLocation is a described setting, off by default [C7,#9083]', t => {
  const repo = cellRepo(t, { real: true });
  const saved = process.env.PULLBOARD_MACHINE_HOME;
  process.env.PULLBOARD_MACHINE_HOME = `${repo.root}/no-machine-home`;
  t.after(() => { if (saved === undefined) delete process.env.PULLBOARD_MACHINE_HOME; else process.env.PULLBOARD_MACHINE_HOME = saved; });
  const row = settingsInventory([], null, { defaultViewPort: () => 0, DEFAULT_VIEW_PORT: 0 }).settings.find(one => one.key === 'gate.redFactLocation');
  assert.ok(row, 'the setting is listed');
  assert.equal(row.default, false);
  assert.equal(row.value, false);
  assert.ok(row.label && row.description, 'it carries a label and a description');
});
