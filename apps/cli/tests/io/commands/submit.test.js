/** Submit runs the item's frozen check itself when a [test] clause waits on it, so builders never call check --yes [#11844]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { frozenCheckAtSubmit } from '../../../src/io/commands/submit.js';

const HEAD = 'b'.repeat(40);
const item = { item_id: 7, item_owner: 'seat', item_check: 'node --test web/x.test.js', item_frozen: null, item_criterion: '1. the count shows [test]\n2. it is wired [command]' };

test('cli.io-commands-submit.runs-frozen-check: clause 1: a claimed item with a frozen check and an unticked [test] clause has the check run once at the head, with no confirmation, and nothing runs when the clause is ticked or no [test] clause waits [C7,#11844]', async () => {
  const ran = [];
  const runCheck = async (check) => { ran.push(check); return { green: true, report: '' }; };
  const said = [];
  assert.equal(await frozenCheckAtSubmit({ item, thread: [], author: 'coordinator', head: HEAD, runCheck, say: line => said.push(line) }), true);
  assert.deepEqual(ran, ['node --test web/x.test.js']);
  assert.match(said[0], /submit runs the frozen check of #7: node --test web\/x\.test\.js/u);
  const ticked = [{ type: 'fact', kind: 'note', by: 'seat', text: `clause 1 [test]: green pullboard check run of node --test web/x.test.js at ${HEAD}` }];
  assert.equal(await frozenCheckAtSubmit({ item, thread: ticked, author: 'coordinator', head: HEAD, runCheck }), false);
  const commandOnly = { ...item, item_criterion: '1. it is wired [command]' };
  assert.equal(await frozenCheckAtSubmit({ item: commandOnly, thread: [], author: 'coordinator', head: HEAD, runCheck }), false);
  assert.equal(ran.length, 1);
});

test('cli.io-commands-submit.red-or-legacy-check: clause 2: a red frozen check refuses CHECK_RED naming the check and its first failing lines, and a check with no recorded author is not run [C7,#11844]', async () => {
  await assert.rejects(
    frozenCheckAtSubmit({ item, thread: [], author: 'coordinator', head: HEAD, runCheck: async () => ({ green: false, report: 'not ok 1 - the count shows\n  expected 2' }) }),
    error => error.code === 'CHECK_RED' && error.message.includes('node --test web/x.test.js') && error.message.includes('not ok 1 - the count shows'));
  let ran = false;
  assert.equal(await frozenCheckAtSubmit({ item, thread: [], author: null, head: HEAD, runCheck: async () => { ran = true; return { green: true, report: '' }; } }), false);
  assert.equal(ran, false);
});
