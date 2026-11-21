/** @pullboard-test-input apps/cli/src/io/commands/join.js */
/** pullboard join --role with another value, or in the main checkout, is refused BAD_ROLE [C7,#10993]. */
import assert from 'node:assert/strict';
import { after } from 'node:test';
import { before } from 'node:test';
import { test } from 'node:test';
import { createE2eHelpers } from '../../../fixtures/e2e.js';
import { joinFixtureSeat } from '../../../fixtures/testkit.js';
import { freshSeat } from '../../../fixtures/join-seat.js';

const e2e = createE2eHelpers();
after(e2e.cleanup);
/** The one fixture project this file's case builds its seats in. */
let box;
before(() => { box = e2e.project(); });

test('cli.io-commands-join-role.clause-2-bad-role-refused: clause 2: --role with another value, or in the main checkout, is refused BAD_ROLE [C7,#10993]', async () => {
  const other = joinFixtureSeat(box, freshSeat(box, 'judge'), 'web', { role: 'judge' });
  assert.equal(other.code, 1);
  assert.match(other.err, /BAD_ROLE/u);
  const main = joinFixtureSeat(box, box.repo, 'web', { role: 'advisor' });
  assert.equal(main.code, 1);
  assert.match(main.err, /BAD_ROLE/u);
});
