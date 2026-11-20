/** show names the builder's parent session under its eligible-reviewers line, so no coordinator fact explains an exclusion [V1,B3,C7]. */
import assert from 'node:assert/strict';
import { join } from 'node:path';
import {
  after,
  test,
} from 'node:test';
import * as store from '../../../../packages/store/index.js';
import { parentSessionDigest } from '../../../../packages/items/index.js';
import { submitFixture } from '../../tests/fixtures/board/submit.js';
import { createE2eHelpers } from '../../tests/fixtures/e2e.js';
import { fixtureAdd } from '../../tests/fixtures/testkit.js';
import { fixtureJoin } from '../../tests/fixtures/testkit.js';
import { FIXTURE_MODEL_EARLIER } from '../../tests/fixtures/testkit.js';
import { openKitBoard } from '../../tests/fixtures/board.js';

const e2e = createE2eHelpers();
after(e2e.cleanup);
const { project, LIGHT_BRIEF } = e2e;

/** File item 1 on a fresh project and return the box. */
function filed() {
  const box = project('true');
  assert.equal(fixtureAdd(box.run, box.repo, 'web', 'Parent display', '--specs', 'G1', '--criterion', 'the original check passes', '--brief', LIGHT_BRIEF, '--check', 'true').code, 0);
  return box;
}

/** Join a fresh worktree as a web seat, under a declared parent when one is given; returns its path and seat id. */
async function joinSeat(box, name, parent) {
  const path = join(box.dir, name);
  box.git(box.repo, 'worktree', 'add', '-q', '--detach', path, 'main');
  const joined = await fixtureJoin(box.inProcess, path, 'web', '--model', FIXTURE_MODEL_EARLIER, '--route', 'strong', ...(parent ? ['--parent', parent] : []), '--json');
  assert.equal(joined.code, 0, joined.out + joined.err);
  return { path, id: JSON.parse(joined.out).agent };
}

/** Record a submit for the seat on item 1 without running a gate. */
function submitAs(box, agentId) {
  const board = openKitBoard(join(box.repo, '.git/pullboard/board.sqlite'));
  try { submitFixture(board, 1, { agentId, commit: 'a'.repeat(40), tree: 't' }); }
  finally { store.closeBoard(board); }
}

/** The plain show text for item 1. */
async function shown(box, ...flags) {
  const result = await box.inProcess(box.repo, 'show', '1', ...flags);
  assert.equal(result.code, 0, result.out + result.err);
  return result.out;
}

test('cli.journeys-show-parents.show-prints-the-shared-builder-parent: clause 1: show prints the shared builder parent label once under the eligible reviewers [V1,B3,C7]', async () => {
  const box = filed();
  const builder = await joinSeat(box, 'builder-one', 'coordinator:S');
  await joinSeat(box, 'sibling', 'coordinator:S');
  assert.equal((await box.inProcess(builder.path, 'claim', '1')).code, 0);
  submitAs(box, builder.id);
  const lines = (await shown(box)).split('\n');
  const at = lines.findIndex(line => line.startsWith('eligible reviewers:'));
  assert.ok(at >= 0, 'the eligible reviewers line prints');
  const parentLines = lines.filter(line => line.startsWith('builder parent session '));
  assert.equal(parentLines.length, 1, 'one line per builder parent, however many seats share it');
  assert.equal(lines.indexOf(parentLines[0]), at + 1, 'it prints directly under the eligible-reviewers line');
  const label = parentSessionDigest('coordinator:S').slice(0, 12);
  assert.ok(parentLines[0].includes(label), parentLines[0]);
  assert.ok(parentLines[0].includes(builder.id), `the builder is named: ${parentLines[0]}`);
});

test('cli.journeys-show-parents.a-reviewer-under-a-different-parent: clause 2: a reviewer under a different parent is listed eligible without any coordinator fact [V1,B3,C7]', async () => {
  const box = filed();
  const builder = await joinSeat(box, 'builder', 'coordinator:S');
  const other = await joinSeat(box, 'other-parent', 'coordinator:T');
  assert.equal((await box.inProcess(builder.path, 'claim', '1')).code, 0);
  submitAs(box, builder.id);
  const view = JSON.parse(await shown(box, '--json')).reviewEligibility;
  assert.ok(view.eligible.includes(other.id), JSON.stringify(view));
  assert.ok(!view.eligible.includes(builder.id));
  assert.deepEqual(view.authorParents, [{ parent: parentSessionDigest('coordinator:S').slice(0, 12), seats: [builder.id] }]);
  assert.match(await shown(box), new RegExp(`eligible reviewers: .*${other.id}`, 'u'));
});

test('cli.journeys-show-parents.a-seat-joined-with-no-parent: clause 3: a seat joined with no parent shows its parent as unknown and behaves as today [V1,B3,C7]', async () => {
  const box = filed();
  const builder = await joinSeat(box, 'no-parent');
  const other = await joinSeat(box, 'other-parent', 'coordinator:T');
  assert.equal((await box.inProcess(builder.path, 'claim', '1')).code, 0);
  submitAs(box, builder.id);
  const text = await shown(box);
  assert.ok(text.includes(`builder parent session: unknown (${builder.id})`), text);
  assert.match(text, new RegExp(`eligible reviewers: .*${other.id}`, 'u'));
});
