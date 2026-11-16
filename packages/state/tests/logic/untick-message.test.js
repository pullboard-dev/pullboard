/** The CLAUSE_UNTICKED refusal prints one filled-in tick command per unmet clause (#3174) [C7]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { clauseInspectionProblem } from '../../index.js';

const HEAD = 'b'.repeat(40);
const bar = '1. the count shows on a runner [test]\n2. it loads under 2 s [measurement]';
const item = { item_id: 77, item_owner: 'seat', item_check: '', item_brief: '', item_criterion: bar };
const options = { gateFiles: new Set(), head: HEAD };

/** The thread entries a seat's printed `pullboard fact <id> note "<text>"` commands would record. */
function recorded(message) {
  return [...message.matchAll(/pullboard fact 77 note "([^"]+)"/gu)].map(match => ({ type: 'fact', kind: 'note', by: 'seat', text: match[1] }));
}

test('clause 1: one message prints a filled-in fact command per unticked clause with its number and kind [C7]', () => {
  const problem = clauseInspectionProblem(item, [], options);
  assert.equal(problem?.code, 'CLAUSE_UNTICKED');
  assert.match(problem.message, /pullboard fact 77 note "clause 1 \[test\]: /u);
  assert.match(problem.message, /pullboard fact 77 note "clause 2 \[measurement\]: /u);
  assert.equal(recorded(problem.message).length, 2);
});

test('clause 2: recording exactly the printed notes makes the problem go away [C7]', () => {
  const printed = clauseInspectionProblem(item, [], options).message;
  assert.equal(clauseInspectionProblem(item, recorded(printed), options), null);
});
