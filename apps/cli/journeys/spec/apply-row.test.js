/** spec apply --row applies exactly one row's pending decision [C7]. */
/** @pullboard-test-input source-cell apps/cli apps/lib store */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { after } from 'node:test';
import { test } from 'node:test';
import { createE2eHelpers } from '../../tests/fixtures/e2e.js';
import { personNeedsState } from '../../../view/index.js';
import { parseSpec } from '../../../../packages/spec/index.js';

const fixtures = createE2eHelpers();
after(fixtures.cleanup);

/** Require a successful real command and retain its diagnostics on failure. */
function succeeds(result) {
  assert.equal(result.code, 0, `${result.out}\n${result.err}`);
  return result;
}

/** Read one requirement from the fixture's current SPEC bytes. */
function row(box, id) {
  return parseSpec(readFileSync(join(box.repo, 'SPEC.md'), 'utf8')).rows.find(entry => entry.id === id);
}

/** Propose a revision of an approved row and have the person approve it, leaving it pending apply. */
async function approvedProposal(box, target, text) {
  const draft = JSON.parse(succeeds(await box.runIn(box.web, 'spec', 'draft', text,
    '--revises', target, '--gate', 'true', '--reason', 'Reworded.', '--json')).out);
  succeeds(await box.runIn(box.repo, 'spec', 'approve', draft.id));
  return draft.id;
}

/** The row_apply events of the board, each with the decision event ids it applied. */
async function applyEvents(box) {
  const events = JSON.parse(succeeds(await box.runIn(box.repo, 'export')).out).tables.event;
  return { events, applies: events.filter(event => event.event_kind === 'row_apply').map(event => JSON.parse(event.event_detail).events) };
}

test('clause 1: spec apply --row writes only that row and records only its decision event [C7]', { timeout: 180_000 }, async () => {
  const box = fixtures.project('true');
  await approvedProposal(box, 'G1', 'The page renders accessibly.');
  await approvedProposal(box, 'G2', 'The API answers quickly.');
  succeeds(await box.runIn(box.repo, 'spec', 'apply', '--row', 'G1'));
  assert.equal(row(box, 'G1').text, 'The page renders accessibly.', 'the named row was applied');
  assert.equal(row(box, 'G2').text, 'The API answers.', 'the other row stayed as it was');
  const { events, applies } = await applyEvents(box);
  const decision = events.find(event => event.event_kind === 'row_decision' && event.event_detail.includes('"id":"G1"'));
  assert.ok(decision, 'the first proposal has its decision event');
  assert.deepEqual(applies, [[decision.event_id]], 'one row_apply event names only the first decision');
});

test('clause 2: the other approval is still pending after spec apply --row [C7]', { timeout: 180_000 }, async () => {
  const box = fixtures.project('true');
  const first = await approvedProposal(box, 'G1', 'The page renders accessibly.');
  const second = await approvedProposal(box, 'G2', 'The API answers quickly.');
  succeeds(await box.runIn(box.repo, 'spec', 'apply', '--row', 'G1'));
  assert.ok(!personNeedsState(box.repo).needs.some(entry => entry.id === first), 'the applied row leaves Needs you');
  assert.ok(personNeedsState(box.repo).needs.some(entry => entry.id === second), 'the other approval is still pending');
  const refused = await box.runIn(box.repo, 'spec', 'apply', '--row', 'G1');
  assert.notEqual(refused.code, 0, 'an id with no pending decision is refused, not a silent no-op');
  assert.match(`${refused.out}${refused.err}`, /no pending decision/u);
  succeeds(await box.runIn(box.repo, 'spec', 'apply', '--row', 'G2'));
  assert.equal(row(box, 'G2').text, 'The API answers quickly.', 'the second row applies when named in turn');
});

test('clause 3: spec apply with no --row applies every pending decision as before [C7]', { timeout: 180_000 }, async () => {
  const box = fixtures.project('true');
  await approvedProposal(box, 'G1', 'The page renders accessibly.');
  await approvedProposal(box, 'G2', 'The API answers quickly.');
  succeeds(await box.runIn(box.repo, 'spec', 'apply'));
  assert.equal(row(box, 'G1').text, 'The page renders accessibly.');
  assert.equal(row(box, 'G2').text, 'The API answers quickly.');
  const { applies } = await applyEvents(box);
  assert.equal(applies.length, 1, 'one apply event');
  assert.equal(applies[0].length, 2, 'it names both decisions');
});
