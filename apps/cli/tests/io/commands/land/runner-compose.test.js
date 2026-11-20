/** A landing with landing.runnerOnlyCompose on lands one real item: main holds its commit and the item reads landed [C7,#8993]. */
import assert from 'node:assert/strict';
import { after } from 'node:test';
import { test } from 'node:test';
import { createE2eHelpers } from '../../../fixtures/e2e.js';
import { makeLandProjectFixtures } from '../../../fixtures/land/project.js';
import { settleLand } from '../../../fixtures/land/settle.js';
import { fixtureSettledMachine } from '../../../../../../packages/gate/tests/fixtures/testkit.js';

const helpers = createE2eHelpers();
after(helpers.cleanup);

let landed = null;

/** Land one verified item once for both clauses, since a landing is the slow step of this journey. Why: two landings took the whole file past its time limit. */
function landOne() {
  landed ??= landOneItem();
  return landed;
}

/** Land one verified item through the landing step with landing.runnerOnlyCompose on, as `land` offers and a runner settles it. */
async function landOneItem() {
  const fixtures = makeLandProjectFixtures(helpers);
  const box = fixtures.landProject();
  // The commit (with test.inProcessHooks on), submit and accept run in this process, and the machine turns the setting on [C7,#8993].
  fixtureSettledMachine(box.env.PULLBOARD_MACHINE_HOME, { landing: { runnerOnlyCompose: true }, test: { inProcessHooks: true } });
  const entry = await fixtures.itemWorktreeLocal(box, 1);
  await fixtures.commitItemLocal(box, entry);
  await fixtures.submitItemLocal(box, entry);
  await fixtures.acceptItemLocal(box, entry);
  const before = box.git(box.repo, 'rev-parse', 'main');
  const offered = await box.runLocal(box.repo, 'land', '--json');
  assert.equal(offered.code, 0, offered.err + offered.out);
  const result = await settleLand(box, JSON.parse(offered.out));
  return { box, entry, before, result };
}

test('cli.journeys-land-landing-runner-compose.main-holds-the-landed-commit: clause 1: with landing.runnerOnlyCompose on, a landing lands one real item and main then holds the item commit [C7,#8993]', async () => {
  const { box, entry, before, result } = await landOne();
  assert.equal(result.batch.state, 'landed', JSON.stringify(result.landJob?.receipt));
  assert.notEqual(box.git(box.repo, 'rev-parse', 'main'), before, 'main moved');
  assert.equal(box.tryGit(box.repo, 'merge-base', '--is-ancestor', entry.commit, 'main').status, 0, 'main holds the item commit');
});

test('cli.journeys-land-landing-runner-compose.the-item-reads-landed: clause 2: after that landing the item reads landed on the board [C7,#8993]', async () => {
  const { box, entry } = await landOne();
  const shown = await box.runLocal(box.repo, 'show', String(entry.item), '--json');
  assert.equal(shown.code, 0, shown.err);
  assert.ok(JSON.parse(shown.out).item_merged_commit, shown.out);
});
