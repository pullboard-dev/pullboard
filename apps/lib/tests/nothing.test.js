/** A check that already passes on main names the check that would prove the work, and a hold leaves the agent a step [V2,C7]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { closeBoard } from '../../../packages/store/index.js';
import { openBoard } from '../index.js';
import { refuseProvesNothing } from '../../../packages/verify/index.js';
import { sayCheckBaseline } from '../../../packages/gate/index.js';

/** The #849 shape: an item whose whole-suite check is green on main before any work. */
function provesNothing(overrides = {}) {
  return { item_id: 4, item_status: 'open', item_title: 'Show the cart total', item_check: 'npm test', item_criterion: 'The cart shows its total.',
    item_brief: '', item_check_baseline: { result: 'green', main: 'a'.repeat(40), command: 'npm test' }, ...overrides };
}

test('the green-baseline warning names a check that runs the new test file [V2,C7]', () => {
  const lines = [];
  sayCheckBaseline({ say: (line) => lines.push(line) }, provesNothing());
  const warning = lines.find((line) => line.includes('CRITERION_PROVES_NOTHING'));
  assert.ok(warning, lines.join('\n'));
  assert.match(warning, /pullboard edit 4 --check "node --test test\/show-the-cart-total\.test\.js"/u, 'the concrete fix is a paste-ready command');
  const named = [];
  sayCheckBaseline({ say: (line) => named.push(line) }, provesNothing({ item_check: 'node apps/cli/src/io/run/tests.js', item_check_baseline: { result: 'green', main: 'a'.repeat(40), command: 'node apps/cli/src/io/run/tests.js' },
    item_criterion: 'Tests in test/cart-total.test.js pass; the first fails before the change.' }));
  assert.match(named.join('\n'), /--check "node apps\/cli\/src\/io\/run\/tests\.js test\/cart-total\.test\.js"/u, 'the named test file and the project runner are used');
});

test('a held item leaves the agent one step it can take itself [V2,C7]', (t) => {
  const board = openBoard(':memory:');
  t.after(() => closeBoard(board));
  assert.throws(() => refuseProvesNothing(() => ({ checks: { provesNothing: 'hold' } }), board, provesNothing()), (error) => {
    assert.equal(error.code, 'CRITERION_PROVES_NOTHING');
    assert.match(error.message, /#4 is held/u);
    assert.match(error.next, /pullboard shout coordinator --kind question --decision "#4 is held because its check passes on main; please set: pullboard edit 4 --check 'node --test test\/show-the-cart-total\.test\.js'"/u,
      'the agent can ask for the concrete check without the person');
    return true;
  });
});
