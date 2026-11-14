/** A relay on that fails after its board identity switch leaves the board id unchanged [H15,H17] (#7772). */
import assert from 'node:assert/strict';
import { chmodSync } from 'node:fs';
import { existsSync } from 'node:fs';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { boardId } from '../../../../packages/store/index.js';
import { openBoardForRead } from '../../../../packages/store/index.js';
import { relayClientFixture } from '../../tests/fixtures/relay/client.js';

/** The id the temp board carries, read straight from its database. */
function currentId(box) {
  const board = openBoardForRead(join(box.root, '.git', 'pullboard', 'board.sqlite'));
  try { return boardId(board); } finally { board.db.close(); }
}

test('a relay on whose device key cannot be saved leaves board_id, its relink intent and pullboard.json as they were [H15,H17]', async t => {
  const box = await relayClientFixture(t);
  await box.link();
  assert.equal((await box.cliLocal('relay', 'off')).code, 0);
  const before = currentId(box);
  const keys = join(box.env.PULLBOARD_HOME, 'relay-keys');
  mkdirSync(keys, { recursive: true });
  chmodSync(keys, 0o500);
  t.after(() => chmodSync(keys, 0o700));
  // The key is saved after the epoch starts and the snapshot is taken, so this is a failure after the id switch.
  await assert.rejects(box.cliLocal('relay', 'on', '--url', box.origin), { code: 'EACCES' });
  assert.equal(existsSync(box.linkFile), false, 'no link was written');
  assert.equal(currentId(box), before, 'the board id is what it was before relay on');
});
