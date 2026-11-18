/** A clause tick that starts with a clause number and names an evidence kind but is not "clause N [kind]: evidence" is refused TICK_FORMAT at write [C7,#10866]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { tickFormatProblem } from '../../../src/io/commands/fact.js';

test('cli.io-commands-fact.malformed-tick-refused: clause 2: a note such as "clause 1: [test] run <id>" is refused TICK_FORMAT naming the form and that a green pullboard test run ticks [test] clauses itself, and a note in the form is still recorded [C7,#10866]', () => {
  for (const text of ['clause 1: [test] run 6b1c0f2e-1111-4222-8333-444455556666 green', 'clause 3 [reasoning] no colon after the kind', 'Clause 2: [command] ran it']) {
    const refusal = tickFormatProblem('note', text);
    assert.equal(refusal?.code, 'TICK_FORMAT', text);
    assert.match(refusal.message, /clause N \[kind\]: evidence/u);
    assert.match(refusal.message, /green pullboard test run/u);
  }
  for (const text of ['clause 1 [test]: green run 6b1c0f2e, case cli.io-commands-fact.x', 'clause 4 [reasoning]: the wording is plain', 'clause 1: the test is simple', 'a note about [test] files']) {
    assert.equal(tickFormatProblem('note', text), null, text);
  }
  assert.equal(tickFormatProblem('diagnosis', 'clause 1: [test] run x'), null);
});
