/** A seat that joined without --family is reviewable once its session derives one [C7,V4]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as store from '../packages/store/index.js';
import { join } from 'node:path';
import { after } from 'node:test';
import { fixtureBoard } from './board-fixture.js';
import { createE2eHelpers } from './e2e-helpers.js';
import { submitFixture } from './board-submit-fixture.js';
import { fixtureJoin } from './testkit-fixture.js';

// Seats must declare a model; the fixture project's own join reads it from the runner's environment.
process.env.PULLBOARD_MODEL ??= 'Test Model';
const e2e = createE2eHelpers();
after(e2e.cleanup);

/** A board with a coordinator, an undeclared builder seat and a reviewer of another vendor. */
function setup(t) {
  const board = fixtureBoard(t);
  let now = new Date('2026-01-01T00:00:00.000Z');
  board.clock = { now: () => new Date(now) };
  store.register(board, { id: 'coordinator', lane: 'coordinator', path: '/fixture/main', family: 'human', session: 'sess-coord', model: 'm' });
  store.register(board, { id: 'core-1', lane: 'core', path: '/fixture/core-1', session: 'sess-build', model: 'm' });
  store.register(board, { id: 'core-2', lane: 'core', path: '/fixture/core-2', family: 'openai', session: 'sess-review', model: 'm' });
  const id = store.addItem(board, { by: 'coordinator', lane: 'core', title: 'Family fixture', criterion: 'prove it' });
  now = new Date(now.getTime() + 16 * 60_000);
  store.claim(board, id, { agentId: 'core-1', lane: 'core', leaseMs: 3_600_000, freeze: () => ({ text: '{}', digest: 'fixture-digest' }) });
  return { board, id };
}
const column = (board, seat) => board.db.prepare('SELECT agent_family AS f FROM agent WHERE agent_id=?').get(seat).f;

test('submit records the derived family of a seat whose own column is NULL [C7]', t => {
  const { board, id } = setup(t);
  // A peer of the same session declares the vendor; the builder's own column stays NULL.
  store.register(board, { id: 'core-3', lane: 'core', path: '/fixture/core-3', family: 'anthropic', session: 'sess-build', model: 'm' });
  assert.equal(column(board, 'core-1'), null);
  submitFixture(board, id, { agentId: 'core-1', commit: 'a'.repeat(40), tree: 'b'.repeat(40) });
  assert.equal(store.getItem(board, id).item_builder_family, 'anthropic');
});

test('review admission uses the builder seat current family when none was recorded [C7]', t => {
  const { board, id } = setup(t);
  submitFixture(board, id, { agentId: 'core-1', commit: 'a'.repeat(40), tree: 'b'.repeat(40) });
  assert.equal(store.getItem(board, id).item_builder_family, null, 'nothing was declared at submit');
  store.register(board, { id: 'core-1', lane: 'core', path: '/fixture/core-1', family: 'anthropic', model: 'm' });
  const options = { agentId: 'core-2', leaseMs: 3_600_000, policy: 'any', familyPolicy: 'require' };
  assert.doesNotThrow(() => store.reserveReview(board, id, options));
  assert.equal(store.getItem(board, id).item_review_by, 'core-2');
});

test('join --family on a seat with a NULL column writes it though its session derived it [C7]', t => {
  const { board } = setup(t);
  store.register(board, { id: 'core-3', lane: 'core', path: '/fixture/core-3', family: 'anthropic', session: 'sess-build', model: 'm' });
  assert.equal(column(board, 'core-1'), null);
  store.register(board, { id: 'core-1', lane: 'core', path: '/fixture/core-1', family: 'anthropic', model: 'm' });
  assert.equal(column(board, 'core-1'), 'anthropic');
});

test('the join CLI confirms the recorded family in its text and --json, on first join, without one, and on rejoin [C7]', () => {
  const box = e2e.project('true');
  const seat = name => {
    const dir = join(box.dir, name);
    box.git(box.repo, 'worktree', 'add', '-q', dir, '-b', `api/${name}`);
    return dir;
  };
  const none = seat('undeclared'), declared = seat('declared');
  const bare = fixtureJoin(box.run, none, 'api', '--model', 'Test Model', '--json');
  assert.equal(bare.code, 0, bare.err);
  assert.equal(JSON.parse(bare.out).family, null);
  assert.doesNotMatch(fixtureJoin(box.run, none, 'api', '--model', 'Test Model').out, /family/u);
  const first = fixtureJoin(box.run, declared, 'api', '--model', 'Test Model', '--family', 'anthropic');
  assert.equal(first.code, 0, first.err);
  assert.match(first.out, /joined as .*\(family anthropic\) in the api lane/u);
  assert.equal(JSON.parse(fixtureJoin(box.run, declared, 'api', '--model', 'Test Model', '--family', 'anthropic', '--json').out).family, 'anthropic');
  // A seat that joined bare, then rejoins naming a family: the response reports what is now recorded.
  const later = fixtureJoin(box.run, none, 'api', '--model', 'Test Model', '--family', 'openai');
  assert.match(later.out, /\(family openai\)/u);
  assert.equal(JSON.parse(fixtureJoin(box.run, none, 'api', '--model', 'Test Model', '--json').out).family, 'openai');
});
