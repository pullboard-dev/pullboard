/** @pullboard-test-input apps/cli/src/io/commands/join.js */
/** pullboard join --role advisor is carried, and a plain join is unchanged [C7,#10993]. */
import assert from 'node:assert/strict';
import { after } from 'node:test';
import { before } from 'node:test';
import { test } from 'node:test';
import { createE2eHelpers } from '../../fixtures/e2e.js';
import { runCliInProcess } from '../../fixtures/process.js';
import { joinFixtureSeat } from '../../fixtures/testkit.js';
import { freshSeat } from '../../fixtures/join-seat.js';

const e2e = createE2eHelpers();
after(e2e.cleanup);
/** The one fixture project the two cases share: each makes its own seats, under distinct worktree names and branches. */
let box;
before(() => { box = e2e.project(); });

test('cli.io-commands-join-role.clause-1-join-role-advisor: clause 1: join --role advisor carries role advisor in --json and ends the text line with the lane as an advisor [C7,#10993]', async () => {
  const joined = joinFixtureSeat(box, freshSeat(box, 'advice'), 'web', { role: 'advisor' });
  assert.equal(joined.code, 0, joined.err);
  assert.equal(JSON.parse(joined.out).role, 'advisor');
  const seat = freshSeat(box, 'advice-text');
  const text = await runCliInProcess(['join', 'web', '--role', 'advisor'], { cwd: seat, env: box.env });
  assert.equal(text.status, 0, text.stderr);
  assert.match(text.stdout, /in the web lane as an advisor/u);
});

test('cli.io-commands-join-role.clause-3-plain-join-unchanged: clause 3: a join without --role has no role key in --json and the old text line [C7,#10993]', async () => {
  const plain = joinFixtureSeat(box, freshSeat(box, 'plain'), 'web');
  assert.equal(plain.code, 0, plain.err);
  assert.equal(Object.hasOwn(JSON.parse(plain.out), 'role'), false);
  const text = await runCliInProcess(['join', 'web'], { cwd: freshSeat(box, 'plain-text'), env: box.env });
  assert.equal(text.status, 0, text.stderr);
  assert.doesNotMatch(text.stdout, /advisor/u);
  assert.match(text.stdout, /in the web lane/u);
});
