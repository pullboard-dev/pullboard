/** @pullboard-test-input apps/cli/src/io/commands/join.js */
/** pullboard join --role advisor is carried and refused as the bar says, and a plain join is unchanged [C7,#10993]; join --json carries level beside route, equal to it, on a new registration and on an already-joined seat [C7,#10969]. */
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { boardFilePath } from '../../../../../packages/store/index.js';
import { closeBoard } from '../../../../../packages/store/index.js';
import { openBoardForRead } from '../../../../../packages/store/index.js';
import { after } from 'node:test';
import { before } from 'node:test';
import { test } from 'node:test';
import { createE2eHelpers } from '../../fixtures/e2e.js';
import { runCliInProcess } from '../../fixtures/process.js';
import { joinFixtureSeat } from '../../fixtures/testkit.js';
import { FIXTURE_MODEL } from '../../fixtures/testkit.js';
import { FIXTURE_MODEL_EARLIER } from '../../fixtures/testkit.js';
import { fileFixtureItem } from '../../fixtures/testkit.js';
import { freshSeat } from '../../fixtures/join-seat.js';
import { withoutRoute } from '../../fixtures/join-seat.js';

/** A light-tier model name: the fixture join adds no route for it, so a repeated join names none. */
const LIGHT_MODEL = 'Fixture Haiku';
const e2e = createE2eHelpers();
after(e2e.cleanup);
/** The one fixture project the four cases share: each makes its own seats, under distinct worktree names and branches. */
let box;
before(() => { box = e2e.project(); });

test('cli.io-commands-join-level.join-json-carries-level-beside-route: clause 1: join --json carries level equal to route, route kept as an alias, on both result paths [C7,#10969]', async () => {
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

test('cli.io-commands-join-role.clause-1-join-role-advisor: clause 1: join --role advisor carries role advisor in --json and ends the text line with the lane as an advisor [C7,#10993]', async () => {
  const joined = joinFixtureSeat(box, freshSeat(box, 'advice'), 'web', { role: 'advisor' });
  assert.equal(joined.code, 0, joined.err);
  assert.equal(JSON.parse(joined.out).role, 'advisor');
  const seat = freshSeat(box, 'advice-text');
  const text = await runCliInProcess(['join', 'web', '--role', 'advisor'], { cwd: seat, env: box.env });
  assert.equal(text.status, 0, text.stderr);
  assert.match(text.stdout, /in the web lane as an advisor/u);
});

test('cli.io-commands-join-role.clause-2-bad-role-refused: clause 2: --role with another value, or in the main checkout, is refused BAD_ROLE [C7,#10993]', async () => {
  const other = joinFixtureSeat(box, freshSeat(box, 'judge'), 'web', { role: 'judge' });
  assert.equal(other.code, 1);
  assert.match(other.err, /BAD_ROLE/u);
  const main = joinFixtureSeat(box, box.repo, 'web', { role: 'advisor' });
  assert.equal(main.code, 1);
  assert.match(main.err, /BAD_ROLE/u);
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

test('cli.join.abilities-flag: clause 1: join --abilities browser,gui names both in the join result, and --abilities gpu is refused USAGE naming browser and gui [U136,#11476]', async () => {
  const joined = await runCliInProcess(['join', 'web', '--abilities', 'browser,gui', '--json'], { cwd: freshSeat(box, 'abilities'), env: box.env });
  assert.equal(joined.status, 0, joined.stderr);
  assert.deepEqual(JSON.parse(joined.stdout).abilities, ['browser', 'gui']);
  // Real path: the join wrote the list where next reads a seat's abilities (the agent_abilities:<id> board meta, #11477).
  const board = openBoardForRead(boardFilePath(join(box.repo, '.git')));
  try {
    const stored = board.db.prepare('SELECT meta_value FROM board_meta WHERE meta_key = ?').get(`agent_abilities:${JSON.parse(joined.stdout).agent}`);
    assert.deepEqual(JSON.parse(stored.meta_value), ['browser', 'gui']);
  } finally { closeBoard(board); }
  const refused = await runCliInProcess(['join', 'web', '--abilities', 'gpu'], { cwd: freshSeat(box, 'abilities-bad'), env: box.env });
  assert.notEqual(refused.status, 0);
  assert.match(refused.stderr, /USAGE/u);
  assert.match(refused.stderr, /browser/u);
  assert.match(refused.stderr, /gui/u);
});

test('cli.io-commands-join.existing-seat-moves: clause 1: join in a joined seat with another lane and the same model moves it, in --json and in the say line [C7,#12022]', async () => {
  const seat = freshSeat(box, 'mover');
  const first = await joinFixtureSeat(box, seat, 'web', { model: FIXTURE_MODEL });
  assert.equal(first.code, 0, first.err);
  const moved = await runCliInProcess(['join', 'api', '--model', FIXTURE_MODEL, '--route', 'strong', '--json'], { cwd: seat, env: box.env });
  assert.equal(moved.status, 0, moved.stderr);
  const result = JSON.parse(moved.stdout);
  assert.equal(result.lane, 'api');
  assert.equal(result.moved, true);
  assert.equal(result.from, 'web');
  const text = await runCliInProcess(['join', 'web', '--model', FIXTURE_MODEL, '--route', 'strong'], { cwd: seat, env: box.env });
  assert.equal(text.status, 0, text.stderr);
  assert.match(text.stdout, /moved .* from api to web/u);
});

test('cli.io-commands-join.move-refusal-reaches-builder: clause 2: a LANE_HELD refusal is printed with its next line and a non-zero exit, and a different model still refuses ALREADY_JOINED [C7,#12022]', async () => {
  const seat = freshSeat(box, 'holder');
  const first = await joinFixtureSeat(box, seat, 'web', { model: FIXTURE_MODEL });
  assert.equal(first.code, 0, first.err);
  fileFixtureItem(box, box.repo, { lane: 'web', title: 'Held page', criterion: 'the held page exists', args: ['--specs', 'G1'] });
  const claimed = await runCliInProcess(['claim', '--json'], { cwd: seat, env: box.env });
  assert.equal(claimed.status, 0, claimed.stderr);
  const held = await runCliInProcess(['join', 'api', '--model', FIXTURE_MODEL, '--route', 'strong'], { cwd: seat, env: box.env });
  assert.notEqual(held.status, 0);
  assert.match(held.stderr, /LANE_HELD/u);
  assert.match(held.stderr, /next:/u);
  const other = await runCliInProcess(['join', 'api', '--model', FIXTURE_MODEL_EARLIER, '--route', 'strong'], { cwd: seat, env: box.env });
  assert.notEqual(other.status, 0);
  assert.match(other.stderr, /ALREADY_JOINED/u);
});
