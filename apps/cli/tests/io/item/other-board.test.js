/** pullboard add asks where an item belongs when its bar names files under another registered board's root [C7,#10779]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { registerProject } from '../../../../../packages/seats/index.js';
import { createE2eHelpers } from '../../fixtures/e2e.js';
import { fixtureAdd } from '../../fixtures/testkit.js';

const CHECK = 'node --test web/handler.test.js';

/** Two real local boards on one machine: `own` is where items are filed, `other` is registered in own's machine registry. */
function twoBoards(t) {
  const helpers = createE2eHelpers();
  t.after(helpers.cleanup);
  const own = helpers.project('true');
  const other = helpers.project('true');
  const before = process.env.PULLBOARD_HOME;
  process.env.PULLBOARD_HOME = own.env.PULLBOARD_HOME;
  try { registerProject(other.repo); } finally {
    if (before === undefined) delete process.env.PULLBOARD_HOME; else process.env.PULLBOARD_HOME = before;
  }
  return { own, other, add: (...args) => fixtureAdd(own.runLocal, own.repo, 'web', 'Handler', '--check', CHECK, '--json', ...args) };
}

/** A one-clause bar whose clause names the given file. */
const bar = (file) => ['--criterion', `1. the handler in ${file} returns the canonical result [test]`];

test('cli.add.other-board.asks-with-three-moves: clause 1: an item naming a path in another registered board stops with OTHER_BOARD_ASK offering file-there and --here [C7,#10779]', async t => {
  const { other, add } = twoBoards(t);
  const result = await add(...bar(`${other.repo}/web/handler.js`));
  assert.notEqual(result.code, 0);
  const { error } = JSON.parse(result.out);
  assert.equal(error.code, 'OTHER_BOARD_ASK');
  assert.ok(error.message.includes(other.repo), 'the ask names the other board by its root');
  assert.match(error.next, /file it on that board/u);
  assert.doesNotMatch(error.next, /--after/u);
  assert.match(error.next, /--here/u);
});

test('cli.add.other-board.here-files-it-with-reason: clause 2: --here with a reason files it and records the reason as a fact [C7,#10779]', async t => {
  const { own, other, add } = twoBoards(t);
  const file = `${other.repo}/web/handler.js`;
  const empty = await add(...bar(file), '--here', ' ');
  assert.equal(JSON.parse(empty.out).error.code, 'OTHER_BOARD_REASON');
  const here = await add(...bar(file), '--here', 'the site copy lives here on purpose');
  assert.equal(here.code, 0, here.err + here.out);
  const id = JSON.parse(here.out).item.item_id;
  const shown = JSON.parse((await own.runLocal(own.repo, 'show', String(id), '--json')).out);
  assert.ok(shown.thread.some(entry => entry.type === 'fact' && /the site copy lives here on purpose/u.test(entry.text ?? '')), 'the reason is a fact on the item');
});

test('cli.add.other-board.own-paths-file-without-ask: clause 3: through add on two real local boards, an item naming only its own board paths files with no ask [C7,#10779]', async t => {
  const { add } = twoBoards(t);
  const result = await add(...bar('web/handler.js'));
  assert.equal(result.code, 0, result.err + result.out);
  assert.equal(JSON.parse(result.out).item.item_lane, 'web');
});
