/** Next, verify and the review routing share one family check, so an alias of the builder's family is refused alike everywhere [C7,#3781]. */
// fixture-subject: addItem (a store-level unit of the shared family check; no kit seam builds a board with an alias-family reviewer)
import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as store from '../../../../packages/store/src/io/board.js';
import { getItem } from '../../../../packages/store/src/io/board/query.js';
import { eligibilityProblem } from '../../../../packages/verify/src/logic/review/eligibility.js';
import { fixtureBoard } from '../../tests/fixtures/board.js';
import { submitFixture } from '../../tests/fixtures/board/submit.js';

/** The model name the fixture seats register with. */
const FIXTURE_MODEL = ['fixture', 'model'].join('-');

/** The engine just below the review independence engine, where the original require rule still applies. */
const LEGACY_ENGINE = 147;

/** A board whose item #id was built by a seat of the Claude family and submitted under verify.family require. */
function builtByClaude(t, engine) {
  const board = fixtureBoard(t);
  store.register(board, { id: 'coordinator', lane: 'coordinator', path: '/fixture/coordinator', family: 'human', parentDigest: 'a'.repeat(64), model: FIXTURE_MODEL });
  const seats = { builder: ['core-1', 'Claude'], alias: ['core-2', 'anthropic'], other: ['core-3', 'openai'], twin: ['core-4', 'Claude'] };
  for (const [name, [seat, family]] of Object.entries(seats)) {
    store.register(board, { id: seat, lane: 'core', path: `/fixture/${name}`, family, parentDigest: seat.slice(-1).repeat(64), model: FIXTURE_MODEL });
  }
  const id = store.addItem(board, { by: 'coordinator', lane: 'core', title: 'Review fixture', criterion: 'prove it' });
  store.claim(board, id, { agentId: 'core-1', lane: 'core', leaseMs: 3_600_000,
    freeze: () => ({ text: JSON.stringify({ policy: { verify: { family: 'require' } } }), digest: 'fixture-digest' }) });
  submitFixture(board, id, { agentId: 'core-1', commit: String(id).padStart(40, 'a'), tree: 'b'.repeat(40) });
  if (engine) board.executionEngineVersion = engine;
  return { board, id };
}

/** What the reservation guard and the eligibility listing each say about one reviewer. */
function verdicts(board, id, reviewer) {
  const item = getItem(board, id);
  const guard = store.reviewerChecks(board, { agentId: reviewer, policy: 'any', familyPolicy: 'require' }).familyAllows(item);
  const listed = eligibilityProblem(board, item, { agent_id: reviewer, agent_route: 'strong' }, { policy: 'any', familyPolicy: 'require' });
  return { guard: guard?.code ?? null, listed: listed?.code ?? null };
}

test('cli.journeys-queue-family-one-check.a-reviewer-whose-family-is-an: clause 1: a reviewer whose family is an alias of the builder\'s family is refused alike by next, verify and the routing [C7,#3781]', t => {
  for (const engine of [undefined, LEGACY_ENGINE]) {
    const { board, id } = builtByClaude(t, engine);
    const sameFamily = engine ? 'core-4' : 'core-2';
    const { guard, listed } = verdicts(board, id, sameFamily);
    assert.match(guard ?? '', /^(SAME_FAMILY|O2_FAMILY_MATCH)$/, `guard at engine ${engine ?? 'current'}`);
    assert.equal(listed, guard, `listing at engine ${engine ?? 'current'}`);
  }
});

test('cli.journeys-queue-family-one-check.a-reviewer-of-a-different-family: clause 2: a reviewer of a different family is offered by next and accepted by verify alike [C7,#3781]', t => {
  for (const engine of [undefined, LEGACY_ENGINE]) {
    const { board, id } = builtByClaude(t, engine);
    const { guard, listed } = verdicts(board, id, 'core-3');
    assert.equal(guard, null, `guard at engine ${engine ?? 'current'}`);
    assert.equal(listed, null, `listing at engine ${engine ?? 'current'}`);
  }
});
