/** @pullboard-test-input apps/cli/src/io/commands/join.js */
/** pullboard join --role advisor is carried and refused as the bar says, and a plain join is unchanged [C7,#10993]; join --json carries level beside route, equal to it, on a new registration and on an already-joined seat [C7,#10969]. */
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { after } from 'node:test';
import { test } from 'node:test';
import { createE2eHelpers } from '../../fixtures/e2e.js';
import { runCliInProcess } from '../../fixtures/process.js';
import { joinFixtureSeat } from '../../fixtures/testkit.js';

/** A light-tier model name: the fixture join adds no route for it, so a repeated join names none. */
const LIGHT_MODEL = 'Fixture Haiku';
const e2e = createE2eHelpers();
after(e2e.cleanup);

/** The same run with the --route pair dropped, so join repeats the seat's lane and model alone and answers already joined. */
function withoutRoute(box) {
  return (cwd, ...args) => {
    const at = args.indexOf('--route');
    return runCliInProcess(at < 0 ? args : [...args.slice(0, at), ...args.slice(at + 2)], { cwd, env: box.env });
  };
}

test('cli.io-commands-join-level.join-json-carries-level-beside-route: clause 1: join --json carries level equal to route, route kept as an alias, on both result paths [C7,#10969]', async () => {
  const box = e2e.project();
  const seat = join(box.dir, 'web-2');
  box.git(box.repo, 'worktree', 'add', '-q', seat, '-b', 'web/two');
  const registered = joinFixtureSeat(box, seat, 'web', { model: LIGHT_MODEL, route: 'light' });
  assert.equal(registered.code, 0, registered.err);
  const fresh = JSON.parse(registered.out);
  assert.equal(fresh.route, 'light');
  assert.equal(fresh.level, fresh.route);
  const repeated = await joinFixtureSeat(box, seat, 'web', { model: LIGHT_MODEL, run: withoutRoute(box) });
  assert.equal(repeated.code, 0, repeated.err);
  const already = JSON.parse(repeated.out);
  assert.equal(already.alreadyJoined, true);
  assert.equal(already.route, 'light');
  assert.equal(already.level, already.route);
});

/** A new worktree of the fixture project on its own branch, not yet joined. */
function freshSeat(box, name) {
  const seat = join(box.dir, name);
  box.git(box.repo, 'worktree', 'add', '-q', seat, '-b', `web/${name}`);
  return seat;
}

test('cli.io-commands-join-role.clause-1-join-role-advisor: clause 1: join --role advisor carries role advisor in --json and ends the text line with the lane as an advisor [C7,#10993]', async () => {
  const box = e2e.project();
  const joined = joinFixtureSeat(box, freshSeat(box, 'advice'), 'web', { role: 'advisor' });
  assert.equal(joined.code, 0, joined.err);
  assert.equal(JSON.parse(joined.out).role, 'advisor');
  const seat = freshSeat(box, 'advice-text');
  const text = await runCliInProcess(['join', 'web', '--role', 'advisor'], { cwd: seat, env: box.env });
  assert.equal(text.status, 0, text.stderr);
  assert.match(text.stdout, /in the web lane as an advisor/u);
});

test('cli.io-commands-join-role.clause-2-bad-role-refused: clause 2: --role with another value, or in the main checkout, is refused BAD_ROLE [C7,#10993]', async () => {
  const box = e2e.project();
  const other = joinFixtureSeat(box, freshSeat(box, 'judge'), 'web', { role: 'judge' });
  assert.equal(other.code, 1);
  assert.match(other.err, /BAD_ROLE/u);
  const main = joinFixtureSeat(box, box.repo, 'web', { role: 'advisor' });
  assert.equal(main.code, 1);
  assert.match(main.err, /BAD_ROLE/u);
});

test('cli.io-commands-join-role.clause-3-plain-join-unchanged: clause 3: a join without --role has no role key in --json and the old text line [C7,#10993]', async () => {
  const box = e2e.project();
  const plain = joinFixtureSeat(box, freshSeat(box, 'plain'), 'web');
  assert.equal(plain.code, 0, plain.err);
  assert.equal(Object.hasOwn(JSON.parse(plain.out), 'role'), false);
  const text = await runCliInProcess(['join', 'web'], { cwd: freshSeat(box, 'plain-text'), env: box.env });
  assert.equal(text.status, 0, text.stderr);
  assert.doesNotMatch(text.stdout, /advisor/u);
  assert.match(text.stdout, /in the web lane/u);
});
