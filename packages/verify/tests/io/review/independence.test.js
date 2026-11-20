/** A relaxation witness stands for the family guard of the late review path, the same witness reviewerChecks reads [C7,#12478]. */
// fixture-subject: addItem (a verify unit test of reviewFamilyProblem over a seeded item; the board is opened through the store kit)
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import * as store from '../../../../store/index.js';
import { FIXTURE_MODEL } from '../../../../store/tests/fixtures/cell.js';
import { openKitBoard } from '../../../../store/tests/fixtures/cell.js';
import { submitFixture } from '../../../../store/tests/fixtures/submit.js';
import { privateFixtureFiles } from '../../../../gate/tests/fixtures/child.js';
import { fixtureMachineSettings } from '../../../../gate/tests/fixtures/testkit.js';
import { reviewFamilyProblem } from '../../../src/io/review/independence.js';
import { eligibilityProblem } from '../../../src/logic/review/eligibility.js';

/** Run `read` against a private machine home with review.relaxRequiredFamily set as given, restoring the home afterwards. */
function withRelax(on, read) {
  const { root: dir } = privateFixtureFiles('pullboard-family-problem-');
  const saved = process.env.PULLBOARD_MACHINE_HOME;
  process.env.PULLBOARD_MACHINE_HOME = join(dir, 'machine-home');
  try {
    mkdirSync(process.env.PULLBOARD_MACHINE_HOME, { recursive: true });
    fixtureMachineSettings(process.env.PULLBOARD_MACHINE_HOME, { review: { relaxRequiredFamily: on } });
    return read();
  } finally { if (saved === undefined) delete process.env.PULLBOARD_MACHINE_HOME; else process.env.PULLBOARD_MACHINE_HOME = saved; }
}

/** A board with an openai builder seat, an openai reviewer seat of another session, and one submitted item (requiring family anthropic when `reviewFamily`). */
function submittedBoard(t, reviewFamily) {
  const board = openKitBoard(':memory:', { now: () => new Date('2026-01-01T00:00:00.000Z') });
  t.after(() => store.closeBoard(board));
  for (const [id, lane, family, parent] of [['coordinator', 'coordinator', 'human', 'a'], ['core-1', 'core', 'openai', 'b'], ['core-2', 'core', 'openai', 'c']]) {
    store.register(board, { id, lane, path: `/fixture/${id}`, family, parentDigest: parent.repeat(64), model: FIXTURE_MODEL });
  }
  const id = store.addItem(board, { by: 'coordinator', lane: 'core', title: 'Review fixture', criterion: 'prove it', ...(reviewFamily ? { reviewFamily } : {}) });
  store.claim(board, id, { agentId: 'core-1', lane: 'core', leaseMs: 3_600_000, freeze: () => ({ text: '{}', digest: 'fixture-digest' }) });
  submitFixture(board, id, { agentId: 'core-1', commit: 'a'.repeat(40), tree: 'b'.repeat(40) });
  return { board, item: store.getItem(board, id) };
}

const WITNESS = { queueLength: 2, threshold: 2 };

test('verify.io-review-independence.family-problem-stands-with-witness: clause 1: with relaxRequiredFamilyEnabled() on and relaxationFor returning a witness, reviewFamilyProblem returns no refusal for a seat of another family on a require-family item [C7,#12478]', (t) => {
  const { board, item } = submittedBoard(t, 'anthropic');
  const seen = [];
  const relaxationFor = (found) => { seen.push(found.item_id); return WITNESS; };
  assert.equal(withRelax(true, () => reviewFamilyProblem(board, item, 'core-2', 'off', { relaxationFor })), null);
  assert.deepEqual(seen, [item.item_id], 'the witness is read for this item');
  assert.equal(withRelax(true, () => reviewFamilyProblem(board, item, 'core-2', 'require', { relaxationFor })), null, 'and under verify.family require');
});

test('verify.io-review-independence.family-problem-refuses-without-witness: clause 2: with the setting off, or relaxationFor absent or returning null, reviewFamilyProblem still returns the O2_FAMILY_MATCH refusal [C7,#12478]', (t) => {
  const { board, item } = submittedBoard(t, 'anthropic');
  const code = (on, options) => withRelax(on, () => reviewFamilyProblem(board, item, 'core-2', 'off', options))?.code;
  assert.equal(code(false, { relaxationFor: () => WITNESS }), 'O2_FAMILY_MATCH', 'setting off');
  assert.equal(code(true, undefined), 'O2_FAMILY_MATCH', 'relaxationFor absent');
  assert.equal(code(true, {}), 'O2_FAMILY_MATCH', 'relaxationFor absent in the options');
  assert.equal(code(true, { relaxationFor: () => null }), 'O2_FAMILY_MATCH', 'no witness');
});

test('verify.io-review-independence.eligibility-forwards-witness: clause 3: eligibilityProblem passes its requiredFamilyWitness through reviewFamilyEligibility, so the same witness decides both guards [C7,#12478]', (t) => {
  const { board, item } = submittedBoard(t, null);
  const agent = { agent_id: 'core-2', agent_route: 'strong' };
  const options = { policy: 'any', familyPolicy: 'require', relaxRequiredFamily: true };
  assert.equal(withRelax(true, () => eligibilityProblem(board, item, agent, options))?.code, 'SAME_FAMILY', 'a same-family seat is refused under require without a witness');
  const seen = [];
  const requiredFamilyWitness = (_board, found, agentId) => { seen.push([found.item_id, agentId]); return WITNESS; };
  assert.equal(withRelax(true, () => eligibilityProblem(board, item, agent, { ...options, requiredFamilyWitness })), null);
  assert.deepEqual(seen, [[item.item_id, 'core-2']], 'the family guard read the witness for this item and seat');
  assert.equal(withRelax(false, () => eligibilityProblem(board, item, agent, { ...options, requiredFamilyWitness }))?.code, 'SAME_FAMILY', 'the setting off still refuses');
});
