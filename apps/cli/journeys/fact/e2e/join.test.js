/** The e2e project fixture joins with an explicit fixture model and shows the refusal when join fails [C7]. */
import assert from 'node:assert/strict';
import {
  after,
  test,
} from 'node:test';
import { createE2eHelpers } from '../../../tests/fixtures/e2e.js';

const helpers = createE2eHelpers();
after(helpers.cleanup);

test('clause 1: project() joins web with --model fixture-model and passes with PULLBOARD_MODEL unset [C7]', () => {
  const box = helpers.sandbox();
  delete box.env.PULLBOARD_MODEL;
  const made = helpers.project(undefined, box);
  assert.equal(made.web.endsWith('web-1'), true);
});

test('clause 2: a failed project() join shows the command stderr in the assertion message [C7]', () => {
  const box = helpers.sandbox();
  delete box.env.PULLBOARD_MODEL;
  const real = box.run;
  const failing = { ...box, run: (cwd, ...args) => args[0] === 'join' ? { code: 1, out: '', err: 'JOIN_REFUSED forced stderr text' } : real(cwd, ...args) };
  assert.throws(() => helpers.project(undefined, failing), /JOIN_REFUSED forced stderr text/u);
});
