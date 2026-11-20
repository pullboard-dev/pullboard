/** A check-less accept reads ticks a caller proved carry the same work as the submitted head, and nothing else [C7,#11162]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { checklistEvidenceProblem } from '../../src/logic/clauses.js';
import { clauseInspectionSummary } from '../../src/logic/clauses.js';

const A = 'a'.repeat(40);
const B = 'b'.repeat(40);
const bar = '1. the reader is exported from packages/config/index.js [command]\n2. the setting is described in packages/config/src/io/settings/descriptions.js [command]';
const item = { item_id: 88, item_owner: 'seat-b', item_built_by: 'seat-b', item_check: '', item_criterion: bar };
const ticks = (by, head) => [1, 2].map(number => ({ type: 'fact', kind: 'note', by, text: `clause ${number} [command]: git grep -n reader packages/config/index.js run on ${head.slice(0, 12)}` }));

test('state.logic-clauses.same-work-head-counts: clause 1: a tick citing a sha in sameWorkHeads counts as if it cited head, for a check-less item ticked at A by an earlier holder [C7,#11162]', () => {
  const thread = ticks('seat-a', A);
  assert.equal(checklistEvidenceProblem(item, thread, { head: B, sameWorkHeads: [A] }), null);
});

test('state.logic-clauses.no-same-work-still-refuses: clause 2: with no sameWorkHeads, an empty list or a list omitting A, the item still refuses CLAUSE_UNTICKED, and a tick written before the criterion was edited never counts [C7,#11162]', () => {
  const thread = ticks('seat-a', A);
  for (const heads of [{ head: B }, { head: B, sameWorkHeads: [] }, { head: B, sameWorkHeads: ['c'.repeat(40)] }]) {
    const problem = checklistEvidenceProblem(item, thread, heads);
    assert.equal(problem?.code, 'CLAUSE_UNTICKED');
    assert.match(problem.message, /clause 1 .*has no evidence/u);
    assert.match(problem.message, /clause 2 .*has no evidence/u);
  }
  const edited = [...ticks('seat-b', B), { type: 'move', detail: { criterion: `${bar}\n3. something new in packages/config/index.js [command]` } }];
  assert.equal(checklistEvidenceProblem({ ...item, item_criterion: `${bar}\n3. something new in packages/config/index.js [command]` }, edited, { head: B })?.code, 'CLAUSE_UNTICKED');
});

test('state.logic-clauses.summary-names-an-unticked-clause: clause 1: clauseInspectionSummary names a clause with no tick and no gate-run file as no evidence, keeps the ticked clause as before, and does not throw [C7,#11966]', () => {
  const both = { ...item, item_criterion: '1. the reader is exported [command]\n2. the setting is described [command]' };
  const thread = [{ type: 'fact', kind: 'note', by: 'seat-b', text: `clause 1 [command]: git grep -n reader packages/config/index.js run on ${A.slice(0, 12)}` }];
  assert.equal(clauseInspectionSummary(both, thread, { head: A }), `inspection, clause by clause: 1. the reader is exported [command] -> command: git grep -n reader packages/config/index.js run on ${A.slice(0, 12)} | 2. the setting is described [command] -> no evidence`);
});
