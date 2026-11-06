/** A capable seat whose pick is undiagnosed light work is offered 'diagnose #N', so the light seat builds it [C7,N2]. */
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { test } from 'node:test';
import { createE2eHelpers } from './e2e-helpers.js';
import { onBoard } from './land-board-fixture.js';
import * as store from '../packages/store/index.js';

const DIAGNOSIS = 'Files: web/handler.js Change: return the canonical result from the handler Test case: test/handler.test.js asserts the canonical result';

test('next offers a strong seat diagnose #N for undiagnosed light work while a light seat is active, then the light seat claims it [C7,N2]', t => {
  const helpers = createE2eHelpers();
  t.after(helpers.cleanup);
  const isolated = helpers.sandbox();
  isolated.env.PULLBOARD_MODEL = 'Diagnose offer fixture';
  const box = helpers.project('true', isolated);
  const seat = (name, route) => {
    const path = join(box.dir, name);
    box.git(box.repo, 'worktree', 'add', '-q', path, '-b', `web/${name}`);
    const joined = box.run(path, 'join', 'web', '--route', route, '--model', `Diagnose ${name} fixture`);
    assert.equal(joined.code, 0, joined.err);
    return path;
  };
  const light = seat('light', 'light');
  const strong = seat('strong', 'strong');
  const added = box.run(box.repo, 'add', 'web', 'Light correction', '--route', 'mid', '--criterion', 'the handler returns the canonical result [test]',
    '--check', 'true', '--brief', 'Files: web/handler.js\nTest: test/handler.test.js', '--json');
  assert.equal(added.code, 0, added.err);
  const id = JSON.parse(added.out).item.item_id;
  onBoard(box, board => board.db.prepare("UPDATE item SET item_route='light' WHERE item_id=?").run(id));
  const idle = box.run(light, 'next', '--build');
  assert.match(idle.err, /NOTHING_FREE/u, 'the light seat looks, finds nothing and so counts as active');
  assert.doesNotMatch(idle.out, new RegExp(`claimed #${id}`, 'u'), 'the light seat cannot take undiagnosed work');
  const offered = box.run(strong, 'next', '--build');
  assert.equal(offered.code, 0, offered.err);
  assert.match(offered.out, new RegExp(`diagnose #${id}: Light correction`, 'u'));
  assert.match(offered.out, new RegExp(`pullboard fact ${id} diagnosis "Files: `, 'u'));
  assert.equal(onBoard(box, board => store.getItem(board, id).item_status), 'open', 'the diagnose offer claims nothing');
  const took = box.run(strong, 'next', '--take');
  assert.match(took.out, new RegExp(`diagnose #${id}: Light correction`, 'u'), 'next --take offers the same diagnosis');
  const offeredJson = box.run(strong, 'next', '--build', '--json');
  assert.equal(JSON.parse(offeredJson.out).diagnose.item_id, id);
  const recorded = box.run(strong, 'fact', String(id), 'diagnosis', DIAGNOSIS);
  assert.equal(recorded.code, 0, recorded.err);
  const taken = box.run(light, 'next', '--build');
  assert.equal(taken.code, 0, taken.err);
  assert.match(taken.out, new RegExp(`claimed #${id}: Light correction`, 'u'));
  assert.equal(onBoard(box, board => store.getItem(board, id).item_owner) !== null, true, 'the light seat holds the diagnosed item');
});
