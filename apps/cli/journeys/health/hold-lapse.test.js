/** An expired hold shows in health and in its owner's next, behind holds.requireOwner [C7,#8541]. */
import assert from 'node:assert/strict';
import {
  after,
  test,
} from 'node:test';
import { createE2eHelpers } from '../../tests/fixtures/e2e.js';
import { fixtureAdd } from '../../tests/fixtures/testkit.js';
import { fixtureSettledMachine } from '../../tests/fixtures/testkit.js';

const e2e = createE2eHelpers();
after(e2e.cleanup);

/** The wait reasons next answered with, from its JSON. */
function reasonsOf(run) { return JSON.parse(run.out.slice(run.out.indexOf('{'))).reasons ?? []; }

/** A project with one open web item held by the coordinator for the web lane, its deadline already past, and the setting as given. */
async function lapsedHold(requireOwner) {
  const box = e2e.sandbox();
  fixtureSettledMachine(box.env.PULLBOARD_MACHINE_HOME, { view: { background: false }, ...(requireOwner ? { holds: { requireOwner: true } } : {}) });
  const project = e2e.project('true', box);
  const added = fixtureAdd(project.run, project.repo, 'web', 'Held work', '--specs', 'G1', '--json');
  assert.equal(added.code, 0, added.err || added.out);
  const id = JSON.parse(added.out).item.item_id;
  const held = await project.runLocal(project.repo, 'hold', String(id), 'waiting on the web lane', '--owner', 'lane:web', '--deadline', '2020-01-01T00:00:00Z');
  assert.equal(held.code, 0, held.err || held.out);
  return { project, id };
}

test('cli.journeys-health-hold-lapse.an-expired-hold-appears-in-health: clause 1: an expired hold appears in health with its owner [C7,#8541]', async () => {
  const { project, id } = await lapsedHold(true);
  const report = JSON.parse((await project.runLocal(project.repo, 'health', '--json')).out);
  const lapsed = report.stuck.find(entry => entry.cause === 'HOLD_LAPSED');
  assert.ok(lapsed, 'health reports the lapsed hold');
  assert.equal(lapsed.item, id);
  assert.equal(lapsed.owner.who, 'lane:web');
});

test('cli.journeys-health-hold-lapse.an-expired-hold-appears-in-the: clause 2: an expired hold appears in the owner\'s next [C7,#8541]', async () => {
  const { project, id } = await lapsedHold(true);
  const next = await project.runLocal(project.web, 'next', '--json');
  assert.match(reasonsOf(next).join('\n'), new RegExp(`#${id} hold lapsed 2020-01-01`, 'u'));
});

test('cli.journeys-health-hold-lapse.with-holds-requireowner-off-an-expired: clause 1: with holds.requireOwner off an expired hold is not reported [C7,#8541]', async () => {
  const { project } = await lapsedHold(false);
  const report = JSON.parse((await project.runLocal(project.repo, 'health', '--json')).out);
  assert.equal(report.stuck.some(entry => entry.cause === 'HOLD_LAPSED'), false);
  const next = await project.runLocal(project.web, 'next', '--json');
  assert.doesNotMatch(reasonsOf(next).join('\n'), /hold lapsed/u);
});
