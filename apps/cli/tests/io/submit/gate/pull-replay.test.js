/** A real submit's pulled gate job replays a changed move table when gate.tableReplay is on, and only then [C7,#8121]. */
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { rmSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { offerSubmitGate } from '../../../../src/io/submit/pull.js';
import { emptyRepo } from '../../../fixtures/blueprint.js';
import { fixtureMachineSettings } from '../../../fixtures/testkit.js';

const FILES = ['packages/moves/src/logic/table/hop.table.js', 'README.md'];

/** A private repository with a board file, and a machine home whose settings turn the replay on or off. */
function fixture(t, tableReplay) {
  const box = emptyRepo({ mode: 'inprocess' });
  const home = box.env.PULLBOARD_MACHINE_HOME;
  const previous = process.env.PULLBOARD_MACHINE_HOME;
  process.env.PULLBOARD_MACHINE_HOME = home;
  t.after(() => { if (previous === undefined) delete process.env.PULLBOARD_MACHINE_HOME; else process.env.PULLBOARD_MACHINE_HOME = previous; rmSync(box.dir, { recursive: true, force: true }); });
  mkdirSync(home, { recursive: true });
  mkdirSync(join(box.repo, '.git', 'pullboard'), { recursive: true });
  writeFileSync(join(box.repo, '.git', 'pullboard', 'board.sqlite'), '');
  fixtureMachineSettings(home, { gate: { tableReplay } });
  return box.repo;
}

/** Offer the item's gate through the pulled entry with a replay hook that records its calls; the offer stops after the replay on the bare context. */
async function offer(root, replay) {
  const calls = [];
  const tableReplay = async ({ root: tree, changed }) => { calls.push({ tree, changed }); return replay?.(); };
  const submission = { held: { item_id: 8121 }, files: FILES };
  const outcome = await offerSubmitGate({ info: { root } }, submission, { tableReplay }).then(() => null, error => error);
  return { calls, outcome };
}

test('clause 1: with gate.tableReplay on, the pulled gate job of a submit that changes a move table runs the replay [C7,#8121]', async t => {
  const root = fixture(t, true);
  const { calls } = await offer(root);
  assert.deepEqual(calls, [{ tree: root, changed: FILES }]);
});

test('clause 1: with gate.tableReplay on, a replay disagreement refuses the pulled submit before any job is offered [C7,#8121]', async t => {
  const root = fixture(t, true);
  const { outcome } = await offer(root, () => { throw Object.assign(new Error('hop disagrees with the board on 2 recorded moves'), { code: 'TABLE_REPLAY' }); });
  assert.equal(outcome.code, 'TABLE_REPLAY');
});

test('clause 2: with gate.tableReplay off, the pulled gate job runs no replay [C7,#8121]', async t => {
  const root = fixture(t, false);
  const { calls, outcome } = await offer(root);
  assert.deepEqual(calls, []);
  assert.notEqual(outcome?.code, 'TABLE_REPLAY');
});
