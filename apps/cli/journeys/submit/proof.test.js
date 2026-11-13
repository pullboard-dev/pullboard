/**
 * Submit runs each cited spec row's gate test, so the frozen row clause has a named run in the review packet [V4,C7].
 * A real repo and board: row G1's gate is a committed test file, the item cites G1, and none of the item's own tests
 * cites the row, so only the gate test can prove it.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  ROW_GATE,
  submittedItem,
} from '../../tests/fixtures/submit/proof.js';

test('clause 1: a submit for an item citing a spec row runs that row\'s gate test file in its recorded proof [V4,C7]', { timeout: 240_000 }, async (t) => {
  const { packet, ranRowGate } = await submittedItem(t);
  assert.equal(ranRowGate, true, `submit ran ${ROW_GATE}, the gate of cited row G1`);
  const row = packet.clauses.find(clause => clause.id === 'G1');
  assert.ok(row, 'the packet lists the frozen G1 clause');
  assert.ok(row.runs.some(run => run.file === ROW_GATE && run.result === 'pass'), `the proof recorded a passing run of ${ROW_GATE}: ${JSON.stringify(row)}`);

  await t.test('clause 2: the review packet cites the row\'s gate run for the spec-row clause, so no clause is left without a run [V4,C7]', () => {
    assert.equal(row.gap, undefined, 'the G1 clause has no evidence gap');
    assert.ok(row.runs.some(run => run.why === "the row's gate test" && run.test === 'the row gate holds'), 'the run is the gate file\'s named, executed case');
    assert.deepEqual(packet.clauses.filter(clause => !clause.runs.length).map(clause => clause.n), [], 'every clause cites a recorded run');
  });
});

test('clause 2: a row gate run with only skipped cases, or none, leaves the spec-row clause unproved [V4,C7]', { timeout: 300_000 }, async (t) => {
  for (const [kind, cases] of [['all skipped', ["test('the row gate holds', { skip: true }, () => {});"]], ['zero cases', []]]) {
    await t.test(`clause 2: ${kind}`, async (t) => {
      const { packet, ranRowGate } = await submittedItem(t, cases);
      assert.equal(ranRowGate, true, `submit still ran ${ROW_GATE}`);
      const row = packet.clauses.find(clause => clause.id === 'G1');
      assert.deepEqual(row.runs, [], `a ${kind} gate run proves nothing: ${JSON.stringify(row)}`);
      assert.equal(row.gap, 'no recorded run');
    });
  }
});

