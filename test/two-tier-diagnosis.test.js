/** Native diagnosis routing gives cold light seats a concrete fix and returns bad diagnoses for repair [C7]. */
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { test } from 'node:test';
import * as store from '../packages/store/index.js';
import { TWO_TIER_DIAGNOSIS_ENGINE } from '../packages/state/index.js';
import { prepareEngineMove } from '../packages/state/index.js';
import { applyEngineMove } from '../packages/state/index.js';
import { parseDiagnosis } from '../packages/items/index.js';
import { createE2eHelpers } from './e2e-helpers.js';
import { fixtureBoard } from './board-fixture.js';
import { onBoard } from './land-board-fixture.js';

const DIAGNOSIS = 'Files: web/handler.js test/handler.test.js Change: repoint the fixture to the canonical handler Test case: handler returns the expected result from the canonical module';

/** Open a native SQLite board with explicit capable and light model routes. */
function fixture(t, engine = TWO_TIER_DIAGNOSIS_ENGINE) {
  const board = fixtureBoard(t);
  board.executionEngineVersion = engine;
  store.register(board, { lane: 'coordinator', path: '/diagnosis/main' });
  const strong = store.register(board, { lane: 'core', path: '/diagnosis/strong', route: 'strong', family: 'openai' });
  const light = store.register(board, { lane: 'core', path: '/diagnosis/light', route: 'light', family: 'anthropic' });
  const add = (route = 'mid') => store.addItem(board, { by: 'coordinator', lane: 'core', title: 'Diagnosed correction', route,
    criterion: 'the correction works [test]', check: 'true', brief: 'Files: web/handler.js\nTest: the handler case' });
  const claim = (id, agentId) => store.claim(board, id, { agentId, lane: 'core', leaseMs: 60 * 60_000,
    freeze: item => ({ text: JSON.stringify({ criterion: item.item_criterion }), digest: 'diagnosis-bar' }) });
  return { board, strong, light, add, claim };
}

test('native diagnosis validates its exact handoff, routes light and invalidates atomically on a wrong-diagnosis release [C7]', t => {
  const f = fixture(t);
  assert.throws(() => f.add('light'), { code: 'DIAGNOSIS_REQUIRED' });
  const id = f.add();
  assert.throws(() => f.claim(id, f.light), { code: 'DIAGNOSIS_REQUIRED' });
  assert.throws(() => store.appendFact(f.board, id, { agentId: f.light, kind: 'diagnosis', text: DIAGNOSIS }), { code: 'DIAGNOSIS_ROUTE' });
  for (const text of ['Files: web/handler.js', 'Files: ../handler.js Change: fix Test case: asserts result']) {
    assert.throws(() => store.appendFact(f.board, id, { agentId: f.strong, kind: 'diagnosis', text }), { code: 'DIAGNOSIS_REQUIRED' });
  }
  assert.equal(store.getItem(f.board, id).item_route, 'mid');
  const fact = store.appendFact(f.board, id, { agentId: f.strong, kind: 'diagnosis', text: DIAGNOSIS });
  assert.equal(fact.kind, 'diagnosis');
  const diagnosed = store.getItem(f.board, id);
  assert.equal(diagnosed.item_route, 'light');
  assert.match(diagnosed.item_brief, /Change:\nrepoint the fixture/u);
  assert.match(diagnosed.item_brief, /Test:\nhandler returns/u);
  assert.equal(store.nextFor(f.board, { agentId: f.light, lane: 'core' }).item.item_id, id);
  f.claim(id, f.light);
  assert.throws(() => store.release(f.board, id, f.light, '', 'DIAGNOSIS_WRONG'), { code: 'DIAGNOSIS_WRONG' });
  assert.equal(store.getItem(f.board, id).item_owner, f.light, 'a refused release preserves custody');
  store.release(f.board, id, f.light, 'The fixture path diagnosis missed the actual assertion', 'DIAGNOSIS_WRONG');
  const returned = store.getItem(f.board, id);
  assert.equal(returned.item_route, 'mid');
  assert.equal(returned.item_status, 'open');
  assert.match(returned.item_brief, /^Diagnosis rejected:/u);
  assert.equal(returned.item_hold_reason, null);
  assert.throws(() => f.claim(id, f.light), { code: 'DIAGNOSIS_REQUIRED' });
  assert.equal(store.nextFor(f.board, { agentId: f.light, lane: 'core' }).item, null);
  assert.equal(store.nextFor(f.board, { agentId: f.strong, lane: 'core' }).item.item_id, id);
  store.appendFact(f.board, id, { agentId: f.strong, kind: 'diagnosis', text: DIAGNOSIS.replace('fixture', 'test assertion') });
  f.claim(id, f.light);
  assert.equal(store.getItem(f.board, id).item_owner, f.light);
});

test('bar edits cannot reuse a stale diagnosis and new fact/release moves seal the required engine [C7]', t => {
  const f = fixture(t);
  const id = f.add();
  store.appendFact(f.board, id, { agentId: f.strong, kind: 'diagnosis', text: DIAGNOSIS });
  assert.throws(() => store.editItem(f.board, id, { agentId: 'coordinator', brief: 'Files: web/other.js\nTest: unrelated case' }), { code: 'DIAGNOSIS_REQUIRED' });
  assert.throws(() => store.editItem(f.board, id, { agentId: 'coordinator', criterion: 'a changed bar [test]', reason: 'new scope' }), { code: 'DIAGNOSIS_REQUIRED' });
  store.editItem(f.board, id, { agentId: 'coordinator', criterion: 'a changed bar [test]', route: 'mid', reason: 'new scope needs diagnosis' });
  assert.throws(() => f.claim(id, f.light), { code: 'DIAGNOSIS_REQUIRED' });
  const move = prepareEngineMove(f.board, 'appendFact', [id, { agentId: f.strong, kind: 'diagnosis', text: DIAGNOSIS }]);
  assert.throws(() => applyEngineMove(f.board, { ...move, engine: TWO_TIER_DIAGNOSIS_ENGINE - 1 }, { sequence: 1, at: new Date().toISOString() }), /engine/u);
  store.appendFact(f.board, id, { agentId: f.strong, kind: 'diagnosis', text: DIAGNOSIS });
  f.claim(id, f.light);
  const release = prepareEngineMove(f.board, 'release', [id, f.light, 'diagnosis is wrong', 'DIAGNOSIS_WRONG']);
  assert.throws(() => applyEngineMove(f.board, { ...release, engine: TWO_TIER_DIAGNOSIS_ENGINE - 1 }, { sequence: 1, at: new Date().toISOString() }), /engine/u);
});

test('old light items remain available for capable diagnosis and historical fact labels keep their engine floor [C7]', t => {
  const f = fixture(t, TWO_TIER_DIAGNOSIS_ENGINE - 1);
  const id = f.add('light');
  assert.throws(() => store.appendFact(f.board, id, { agentId: f.strong, kind: 'diagnosis', text: DIAGNOSIS }), { code: 'BAD_FACT_KIND' });
  f.board.executionEngineVersion = TWO_TIER_DIAGNOSIS_ENGINE;
  assert.equal(store.nextFor(f.board, { agentId: f.light, lane: 'core' }).item, null);
  const next = store.nextFor(f.board, { agentId: f.strong, lane: 'core' });
  assert.equal(next.item.item_id, id);
  assert.equal(next.item.item_route, 'mid');
  f.claim(id, f.strong);
  assert.deepEqual(parseDiagnosis(DIAGNOSIS).files, ['web/handler.js', 'test/handler.test.js']);
});

test('real CLI next displays the diagnosis to a light seat and DIAGNOSIS_WRONG returns it for diagnosis [C7]', t => {
  const helpers = createE2eHelpers();
  t.after(helpers.cleanup);
  const isolated = helpers.sandbox();
  isolated.env.PULLBOARD_MODEL = 'Two tier diagnosis fixture';
  const box = helpers.project('true', isolated);
  const light = join(box.dir, 'light');
  box.git(box.repo, 'worktree', 'add', '-q', light, '-b', 'web/light');
  const joined = box.run(light, 'join', 'web', '--route', 'light', '--model', 'Two tier light fixture');
  assert.equal(joined.code, 0, joined.err);
  const added = box.run(box.repo, 'add', 'web', 'Cold correction', '--route', 'mid', '--criterion', 'the correction works [test]', '--check', 'true',
    '--brief', 'Files: web/handler.js\nTest: expected result', '--json');
  assert.equal(added.code, 0, added.err);
  const id = JSON.parse(added.out).item.item_id;
  const before = box.run(light, 'claim', String(id));
  assert.notEqual(before.code, 0);
  assert.match(before.err, /DIAGNOSIS_REQUIRED/u);
  const recorded = box.run(box.repo, 'fact', String(id), 'diagnosis', DIAGNOSIS);
  assert.equal(recorded.code, 0, recorded.err);
  const picked = box.run(light, 'next', '--build', '--json');
  assert.equal(picked.code, 0, picked.err);
  const answer = JSON.parse(picked.out);
  assert.equal(answer.item.item_id, id);
  assert.match(answer.item.item_brief, /repoint the fixture/u);
  const root = answer.itemFolder ?? light;
  const released = box.run(root, 'release', String(id), '--reason', 'DIAGNOSIS_WRONG', '--note', 'the fixture diagnosis missed the actual assertion', '--no-next');
  assert.equal(released.code, 0, released.err);
  assert.equal(onBoard(box, board => store.getItem(board, id).item_route), 'mid');
  const retry = box.run(light, 'claim', String(id));
  assert.notEqual(retry.code, 0);
  assert.match(retry.err, /DIAGNOSIS_REQUIRED/u);
  assert.equal(box.run(box.repo, 'fact', String(id), 'diagnosis', DIAGNOSIS.replace('fixture', 'assertion')).code, 0);
  assert.equal(box.run(light, 'claim', String(id)).code, 0);
});
