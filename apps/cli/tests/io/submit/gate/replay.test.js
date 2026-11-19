/** An item submit replays a changed move table when gate.tableReplay is on, and only then [C7,#8117]. */
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { rmSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { runSubmitGateWithRunnerPlan } from '../../../../src/io/submit/gate.js';
import { submitTableReplay } from '../../../../src/io/submit/gate.js';
import { runSubmitGate } from '../../../../../../packages/gate/index.js';
import { emptyRepo } from '../../../fixtures/blueprint.js';
import { fixtureMachineSettings } from '../../../fixtures/testkit.js';

const CHANGED = ['packages/moves/src/logic/table/hop.table.js', 'README.md'];
/** Stops the gate right after the replay step, so a test proves what ran before planning without running a gate. */
const reached = new Error('the gate went on to plan');
const planners = { plan: () => { throw reached; }, admission: async () => ({ browser: false, gui: false }) };

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
  const root = box.repo;
  return root;
}

/** The moves cell's report with a fixed answer per table, recording what it was asked. */
function fakeReplay(byTable, calls) {
  return async ({ name }) => {
    calls.push(name);
    const events = byTable[name] ?? [];
    return { total: 5, agreed: 5 - events.length, disagreed: events.length, disagreements: events.map(event => ({ event })) };
  };
}

/** Run the real gate entry with the submit's replay hook until it plans, which the stub planner turns into `reached`. */
const gate = (root, tableReplay) => runSubmitGate(root, { gate: 'true' }, { staticChecked: true, changed: CHANGED, tableReplay, planners });

test('cli.io-submit-gate-replay.with-gate-tablereplay-on-a-submit-that: clause 1: with gate.tableReplay on, a submit that changes a move table runs the table replay [C7,#8117]', async t => {
  const root = fixture(t, true);
  const calls = [];
  await assert.rejects(gate(root, submitTableReplay(root, fakeReplay({}, calls))), error => error === reached);
  assert.deepEqual(calls, ['hop']);
});

test('cli.io-submit-gate-replay.with-gate-tablereplay-on-a-replay-disagreement: clause 2: with gate.tableReplay on, a replay disagreement refuses the submit with TABLE_REPLAY [C7,#8117]', async t => {
  const root = fixture(t, true);
  await assert.rejects(gate(root, submitTableReplay(root, fakeReplay({ hop: [7, 9] }, []))), error => error.code === 'TABLE_REPLAY' && /hop disagrees with the board on 2 recorded moves/u.test(error.message));
});

test('cli.io-submit-gate-replay.with-gate-tablereplay-off-a-submit-that: clause 3: with gate.tableReplay off, a submit that changes a move table runs no replay [C7,#8117]', async t => {
  const root = fixture(t, false);
  const calls = [];
  await assert.rejects(gate(root, submitTableReplay(root, fakeReplay({ hop: [7] }, calls))), error => error === reached);
  assert.deepEqual(calls, []);
});

test('cli.io-submit-gate-replay.the-item-submit-gate-entry-hands-runsubmitgate: the item submit gate entry hands runSubmitGate the replay hook unless the caller gave one [C7,#8117]', () => {
  const seen = [];
  const take = (root, config, options) => seen.push(options.tableReplay);
  const own = () => {};
  runSubmitGateWithRunnerPlan(take, '/controller', {}, {}, {});
  runSubmitGateWithRunnerPlan(take, '/controller', {}, {}, { tableReplay: own });
  assert.equal(typeof seen[0], 'function');
  assert.equal(seen[1], own);
});
