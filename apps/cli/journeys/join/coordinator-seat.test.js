/** With join.coordinatorSeat on, a lane worktree joins the coordinator lane and commits paths no lane owns; off, join refuses NO_LANE [C7,#10573]. @pullboard-test-input source-cell apps/cli packages/config packages/store */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { crossLaneFixture } from '../../tests/fixtures/e2e.js';
import { fixtureMachineSettings } from '../../../../packages/gate/tests/fixtures/testkit.js';
import { fixtureProjectPolicy } from '../../../../packages/gate/tests/fixtures/testkit.js';

const FIXTURE_MODEL = ['fixture', 'coordinator'].join('-');

/** Turn join.coordinatorSeat on in the fixture's machine settings. */
function allowCoordinatorSeat(box) {
  const home = box.env.PULLBOARD_MACHINE_HOME;
  const kept = JSON.parse(readFileSync(join(home, 'settings.json'), 'utf8'));
  fixtureMachineSettings(home, { ...kept, join: { ...kept.join, coordinatorSeat: true } });
}

/** Make a fresh worktree beside the fixture's repo and run join coordinator there. */
async function joinCoordinatorFrom(box, name) {
  const seat = join(box.dir, name);
  box.git(box.repo, 'worktree', 'add', '-q', '--detach', seat, 'main');
  const joined = await box.runAsLocal(`session-${name}`, seat, 'join', 'coordinator', '--parent', `parent-${name}`, '--model', FIXTURE_MODEL, '--route', 'strong', '--json');
  return { seat, joined };
}

test('cli.journeys-join-coordinator-seat.on-registers-coordinator-n: clause 1: with join.coordinatorSeat on, join coordinator in a worktree registers coordinator-<n> and the main checkout stays the coordinator [C7,#10573]', async t => {
  const box = crossLaneFixture(t);
  allowCoordinatorSeat(box);
  const { seat, joined } = await joinCoordinatorFrom(box, 'coordseat');
  assert.equal(joined.code, 0, joined.out + joined.err);
  const document = box.json(joined);
  assert.match(document.agent, /^coordinator-\d+$/u);
  assert.equal(document.lane, 'coordinator');
  const agents = box.json(await box.runAsLocal('session-coordseat', seat, 'status', '--json')).agents;
  assert.equal(agents.find(agent => agent.agent_id === document.agent).agent_lane, 'coordinator');
  assert.ok(agents.some(agent => agent.agent_id === 'coordinator'), 'the main checkout seat is still the board coordinator');
});

test('cli.journeys-join-coordinator-seat.seat-stages-spec-and-hook-passes: clause 2: that seat stages SPEC.md and pullboard hook pre-commit passes with no outside-lane refusal [C7,#10573]', async t => {
  const box = crossLaneFixture(t);
  allowCoordinatorSeat(box);
  const { seat, joined } = await joinCoordinatorFrom(box, 'coordspec');
  assert.equal(joined.code, 0, joined.out + joined.err);
  fixtureProjectPolicy(seat, { config: JSON.parse(readFileSync(join(seat, 'pullboard.json'), 'utf8')), spec: readFileSync(join(seat, 'SPEC.md'), 'utf8') + '\nA note no lane owns.\n' });
  box.git(seat, 'add', 'SPEC.md');
  const hook = await box.runAsLocal('session-coordspec', seat, 'hook', 'pre-commit');
  assert.equal(hook.code, 0, hook.out + hook.err);
  assert.doesNotMatch(hook.out + hook.err, /outside/iu);
});

test('cli.journeys-join-coordinator-seat.off-still-refuses-no-lane: clause 3: with join.coordinatorSeat off, join coordinator in a worktree still refuses NO_LANE [C7,#10573]', async t => {
  const box = crossLaneFixture(t);
  const { joined } = await joinCoordinatorFrom(box, 'coordoff');
  assert.notEqual(joined.code, 0, 'join is refused');
  assert.match(joined.out + joined.err, /NO_LANE/u);
});
