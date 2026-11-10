/** A cells plan the cut tooling cannot read refuses the submit as CELLS_SUBMIT, never crashing the remote analysis [C7]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readableCuts } from '../../index.js';
import { importCuts } from '../../../../packages/codemap/src/logic/cuts.js';
import { Refused } from '../../../../packages/kernel/index.js';

/** A renumbered plan whose cut link still names an importer ordered after its target, as #3689's did. */
const RENUMBERED = { cells: [
  { name: 'jobs', order: 5, paths: [], cuts: [{ cell: 'resources', edges: [] }] },
  { name: 'resources', order: 6, paths: [], cuts: [] },
] };

test('clause 1: a cut check that throws on the candidate plan refuses CELLS_SUBMIT with its message and next step [C7]', () => {
  assert.throws(() => importCuts(RENUMBERED), /cut links must name an earlier importing cell/u, 'the real cut tooling throws on this plan');
  assert.throws(() => readableCuts('candidate', 'jobs', () => importCuts(RENUMBERED)), error => error instanceof Refused
    && error.code === 'CELLS_SUBMIT'
    && /candidate cells plan cannot be cut-checked for jobs: cut links must name an earlier importing cell/u.test(error.message)
    && /renumber the cuts with the cells/u.test(error.message));
  assert.throws(() => readableCuts('accepted main', 'jobs', () => importCuts(RENUMBERED)), error => error.code === 'CELLS_SUBMIT' && /tell the coordinator/u.test(error.message),
    'the accepted side names the coordinator, not the builder');
});

test('clause 2: a readable plan returns its cut result, and a refusal from the tooling passes through unchanged [C7]', () => {
  assert.deepEqual(readableCuts('candidate', 'jobs', () => ['jobs: a problem']), ['jobs: a problem']);
  const own = new Refused('CELLS_PLAN_CELL', 'no import-cut group');
  assert.throws(() => readableCuts('candidate', 'jobs', () => { throw own; }), error => error === own);
});
