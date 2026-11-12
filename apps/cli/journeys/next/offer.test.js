/** A capable seat whose pick is undiagnosed light work is offered 'diagnose #N', so the light seat builds it [C7,N2]. */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { createE2eHelpers } from '../../tests/fixtures/e2e.js';
import { onBoard } from '../../tests/fixtures/land/board.js';
import * as store from '../../../../packages/store/index.js';
import { fixtureAdd } from '../../tests/fixtures/testkit.js';
import {
  fixtureJoin,
  fixturePolicy,
} from '../../tests/fixtures/testkit.js';

const DIAGNOSIS = 'Files: web/handler.js Change: return the canonical result from the handler Test case: test/handler.test.js asserts the canonical result';

test('next offers a strong seat diagnose #N for undiagnosed light work while a light seat is active, then the light seat claims it [C7,N2]', async t => {
  const helpers = createE2eHelpers();
  t.after(helpers.cleanup);
  const isolated = helpers.sandbox();
  isolated.env.PULLBOARD_MODEL = 'Diagnose offer fixture';
  const box = helpers.project('true', isolated);
  const seat = async (name, route) => {
    const path = join(box.dir, name);
    box.git(box.repo, 'worktree', 'add', '-q', path, '-b', `web/${name}`);
    const joined = (await fixtureJoin(box.runLocal, path, 'web', '--route', route, '--model', `Diagnose ${name} fixture`));
    assert.equal(joined.code, 0, joined.err);
    return path;
  };
  const light = (await seat('light', 'light'));
  const strong = (await seat('strong', 'strong'));
  const added = (await fixtureAdd(box.runLocal, box.repo, 'web', 'Light correction', '--route', 'mid', '--criterion', 'the handler returns the canonical result [test]',
    '--check', 'true', '--brief', 'Files: web/handler.js\nTest: test/handler.test.js', '--json'));
  assert.equal(added.code, 0, added.err);
  const id = JSON.parse(added.out).item.item_id;
  onBoard(box, board => board.db.prepare("UPDATE item SET item_route='light' WHERE item_id=?").run(id));
  const idle = (await box.runLocal(light, 'next', '--build'));
  assert.match(idle.err, /NOTHING_FREE/u, 'the light seat looks, finds nothing and so counts as active');
  assert.doesNotMatch(idle.out, new RegExp(`claimed #${id}`, 'u'), 'the light seat cannot take undiagnosed work');
  const offered = (await box.runLocal(strong, 'next', '--build'));
  assert.equal(offered.code, 0, offered.err);
  assert.match(offered.out, new RegExp(`diagnose #${id}: Light correction`, 'u'));
  assert.match(offered.out, new RegExp(`pullboard fact ${id} diagnosis "Files: `, 'u'));
  assert.equal(onBoard(box, board => store.getItem(board, id).item_status), 'open', 'the diagnose offer claims nothing');
  const took = (await box.runLocal(strong, 'next', '--take'));
  assert.match(took.out, new RegExp(`diagnose #${id}: Light correction`, 'u'), 'next --take offers the same diagnosis');
  const offeredJson = (await box.runLocal(strong, 'next', '--build', '--json'));
  assert.equal(JSON.parse(offeredJson.out).diagnose.item_id, id);
  const recorded = (await box.runLocal(strong, 'fact', String(id), 'diagnosis', DIAGNOSIS));
  assert.equal(recorded.code, 0, recorded.err);
  const taken = (await box.runLocal(light, 'next', '--build'));
  assert.equal(taken.code, 0, taken.err);
  assert.match(taken.out, new RegExp(`claimed #${id}: Light correction`, 'u'));
  assert.equal(onBoard(box, board => store.getItem(board, id).item_owner) !== null, true, 'the light seat holds the diagnosed item');
});

/** The diagnosis the cold-correction case records; its exact words are asserted back from next. */
const COLD_SESSION_MODEL = 'Two tier diagnosis fixture';
const COLD_LIGHT_MODEL = 'Two tier light fixture';
const COLD_DIAGNOSIS = 'Files: web/handler.js test/handler.test.js Change: repoint the fixture to the canonical handler Test case: handler returns the expected result from the canonical module';

test('real CLI next displays the diagnosis to a light seat and DIAGNOSIS_WRONG returns it for diagnosis [C7]', async t => {
  const helpers = createE2eHelpers();
  t.after(helpers.cleanup);
  const isolated = helpers.sandbox();
  isolated.env.PULLBOARD_MODEL = COLD_SESSION_MODEL;
  const box = helpers.project('true', isolated);
  // The diagnosis names test/handler.test.js, so the web lane owns test/ and claim's cross-ownership guard stays out of the way.
  const { lanes } = JSON.parse(readFileSync(join(box.repo, 'pullboard.json'), 'utf8'));
  fixturePolicy(box, { lanes: { ...lanes, web: { ...lanes.web, owns: [...lanes.web.owns, 'test/'] } } });
  const light = join(box.dir, 'light');
  box.git(box.repo, 'worktree', 'add', '-q', light, '-b', 'web/light');
  const joined = (await fixtureJoin(box.runLocal, light, 'web', '--route', 'light', '--model', COLD_LIGHT_MODEL));
  assert.equal(joined.code, 0, joined.err);
  const added = (await fixtureAdd(box.runLocal, box.repo, 'web', 'Cold correction', '--route', 'mid', '--criterion', 'the correction works [test]', '--check', 'true',
    '--brief', 'Files: web/handler.js\nTest: expected result', '--json'));
  assert.equal(added.code, 0, added.err);
  const id = JSON.parse(added.out).item.item_id;
  const before = (await box.runLocal(light, 'claim', String(id)));
  assert.notEqual(before.code, 0);
  assert.match(before.err, /\[ROUTE\] item #\d+ needs a mid model/u);
  const recorded = (await box.runLocal(box.repo, 'fact', String(id), 'diagnosis', COLD_DIAGNOSIS));
  assert.equal(recorded.code, 0, recorded.err);
  const picked = (await box.runLocal(light, 'next', '--build', '--json'));
  assert.equal(picked.code, 0, picked.err);
  const answer = JSON.parse(picked.out);
  assert.equal(answer.item.item_id, id);
  assert.match(answer.item.item_brief, /repoint the fixture/u);
  const root = answer.itemFolder ?? light;
  const released = (await box.runLocal(root, 'release', String(id), '--reason', 'DIAGNOSIS_WRONG', '--note', 'the fixture diagnosis missed the actual assertion', '--no-next'));
  assert.equal(released.code, 0, released.err);
  assert.equal(onBoard(box, board => store.getItem(board, id).item_route), 'mid');
  const retry = (await box.runLocal(light, 'claim', String(id)));
  assert.notEqual(retry.code, 0);
  assert.match(retry.err, /\[ROUTE\] item #\d+ needs a mid model/u);
  assert.equal((await box.runLocal(box.repo, 'fact', String(id), 'diagnosis', COLD_DIAGNOSIS.replace('fixture', 'assertion'))).code, 0);
  assert.equal((await box.runLocal(light, 'claim', String(id))).code, 0);
});
