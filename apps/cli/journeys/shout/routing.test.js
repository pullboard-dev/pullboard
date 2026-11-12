/** @pullboard-test-loads apps/cli/src/logic/purpose.js apps/cli/src/io/commands/shout.js src/lane-lead.js */
/** Explicit coordinator kinds keep item progress on facts without classifying prose [C7]. */
import assert from 'node:assert/strict';
import { after } from 'node:test';
import { test } from 'node:test';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createE2eHelpers } from '../../tests/fixtures/e2e.js';
import { runFixtureChild } from '../../tests/fixtures/child.js';
import * as store from '../../../../packages/store/index.js';
import { openBoard } from '../../../lib/index.js';
import { applyEngineMove } from '../../../../packages/state/index.js';
import { prepareEngineMove } from '../../../../packages/state/index.js';
import { exportBoard } from '../../../../packages/store/index.js';
import { importBoard } from '../../../../packages/store/index.js';
import { minimumMoveEngine } from '../../../../packages/moves/index.js';
import { LANE_LEAD_ENGINE } from '../../../../packages/state/light.js';

const fixtures = createE2eHelpers();
after(fixtures.cleanup);

test('coordinator shouts require explicit kinds while status uses item facts [C7]', async () => {
  const box = fixtures.project('true');
  const lead = await box.runIn(box.repo, 'lanes', 'lead', 'web', 'web-1');
  assert.equal(lead.code, 0, lead.err + lead.out);
  const before = await box.runIn(box.repo, 'export', '--json');
  assert.equal(before.code, 0, before.err);
  const count = JSON.parse(before.out).tables.shout.length;

  for (const args of [
    ['The item is implemented and 68 checks are green.'],
    ['Which check should run next?'],
    ['The outage is not resolved; coordinator intervention is needed.'],
    ['Choose the next check.', '--decision'],
    ['The gate is blocked by an unavailable runner.', '--kind', 'status'],
  ]) {
    const refused = await box.runIn(box.web, 'shout', 'coordinator', ...args, '--json');
    assert.equal(refused.code, 1, refused.err + refused.out);
    const error = JSON.parse(refused.out).error;
    assert.equal(error.code, 'COORDINATOR_STATUS_FACT');
    assert.match(error.message + ' ' + error.next, /pullboard fact <id> note/u);
  }
  const unchanged = await box.runIn(box.repo, 'export', '--json');
  assert.equal(unchanged.code, 0, unchanged.err);
  assert.equal(JSON.parse(unchanged.out).tables.shout.length, count, 'refusals record no shout');

  for (const args of [
    ['Which check should run next?', '--kind', 'question'],
    ['Main red on current main: cockpit/snapshot.test.js fails.', '--kind', 'blocker'],
    ['Choose the next check.', '--kind', 'decision', '--decision'],
    ['The outage is not resolved; coordinator intervention is needed.', '--kind', 'exception'],
    ['idea: add a visual diff for review receipts', '--kind', 'idea'],
  ]) {
    const sent = await box.runIn(box.web, 'shout', 'coordinator', ...args, '--json');
    assert.equal(sent.code, 0, sent.err + sent.out);
  }
  const typed = await box.runIn(box.repo, 'export', '--json');
  assert.equal(typed.code, 0, typed.err);
  assert.equal(JSON.parse(typed.out).tables.shout.length, count + 5, 'four coordination kinds and idea intake reach the coordinator');
  assert.deepEqual(JSON.parse(typed.out).tables.shout.slice(count).map(row => row.shout_to),
    Array(5).fill('coordinator'), 'every declared kind reaches the coordinator');

  const apiModule = pathToFileURL(resolve(import.meta.dirname, '../../../../packages/api/src/io/main.js')).href;
  const cliModule = pathToFileURL(resolve(import.meta.dirname, '../../tests/fixtures/native.js')).href;
  const person = runFixtureChild(process.execPath, ['--input-type=module', '-e', `
    const { executeMove } = await import(${JSON.stringify(apiModule)});
    const { main } = await import(${JSON.stringify(cliModule)});
    const { openBoard, openBoardForRead } = await import(${JSON.stringify(new URL('../../../lib/src/logic/native.js', import.meta.url).href)});
    const { moveArgs } = await import(${JSON.stringify(new URL('../../../../packages/person/index.js', import.meta.url).href)});
    const apiBoardOpeners = { openBoard, openBoardForRead, moveArgs };
    const response = await executeMove(process.cwd(), { verb: 'shout', args: { to: 'coordinator', text: 'A person asks the coordinator.' } }, main, undefined, undefined, undefined, apiBoardOpeners);
    process.stdout.write(JSON.stringify(response));
  `], { cwd: box.repo, env: box.env, encoding: 'utf8' });
  assert.equal(person.status, 0, person.failure ?? person.stderr);
  assert.equal(JSON.parse(person.stdout).status, 200, person.stdout);
  const afterPerson = await box.runIn(box.repo, 'export', '--json');
  assert.equal(afterPerson.code, 0, afterPerson.err);
  const personRow = JSON.parse(afterPerson.out).tables.shout.at(-1);
  assert.deepEqual([personRow.shout_from, personRow.shout_to, personRow.shout_text],
    ['person', 'coordinator', 'A person asks the coordinator.'], 'the view-origin person request needs no kind');

  const peer = await box.runIn(box.web, 'shout', 'api', 'The API lane can review the patch.', '--json');
  assert.equal(peer.code, 0, peer.err + peer.out);
  const broadcast = await box.runIn(box.web, 'shout', 'all', 'The whole team can review the patch.', '--json');
  assert.equal(broadcast.code, 0, broadcast.err + broadcast.out);
  const afterShouts = await box.runIn(box.repo, 'export', '--json');
  assert.equal(afterShouts.code, 0, afterShouts.err);
  assert.equal(JSON.parse(afterShouts.out).tables.shout.length, count + 8, 'person, peer and all shouts remain untyped');
});

test('new coordinator kinds have a distinct replay floor and converge on replicas [C7,H16]', t => {
  const boards = Array.from({ length: 3 }, () => openBoard(':memory:'));
  t.after(() => { for (const board of boards) store.closeBoard(board); });
  const [source, left, right] = boards;
  store.register(source, { lane: 'coordinator', path: '/fixture/kinds-main' });
  store.register(source, { lane: 'web', path: '/fixture/kinds-worker' });
  const initial = exportBoard(source);
  for (const board of [left, right]) importBoard(board, initial);
  const at = '2026-10-28T00:00:00.000Z';
  for (const [index, kind] of ['exception', 'idea'].entries()) {
    const args = [{ from: 'web-1', to: 'coordinator', text: `Declared ${kind}`, kind, lanes: ['web'] }];
    const floor = minimumMoveEngine('shout', args, source, new Date(at));
    assert.ok(floor > LANE_LEAD_ENGINE, `${kind} must not advertise the old lane protocol`);
    const move = prepareEngineMove(source, 'shout', args);
    const before = exportBoard(left);
    assert.throws(() => applyEngineMove(left, { ...move, engine: floor - 1 }, { sequence: index + 1, at }),
      error => error.code === 'RELAY_MOVE');
    assert.deepEqual(exportBoard(left), before, 'a downgraded envelope changes no receipt, cursor or shout');
    const results = boards.map(board => applyEngineMove(board, move, { sequence: index + 1, at }));
    assert.equal(results[0].error, undefined);
    assert.deepEqual(results[1], results[2]);
    assert.equal(store.getShout(left, results[1].result).shout_to, 'coordinator');
    assert.deepEqual(exportBoard(left), exportBoard(right));
  }
  assert.equal(minimumMoveEngine('shout', [{ from: 'web-1', to: 'coordinator', text: 'Legacy question', kind: 'question' }], source), LANE_LEAD_ENGINE);
  assert.equal(minimumMoveEngine('shout', [{ from: 'web-1', to: 'coordinator', text: 'Legacy untyped' }], source), 1);
});

test('historical lane execution keeps its original message-kind validator [C7,H16]', t => {
  const board = openBoard(':memory:');
  t.after(() => store.closeBoard(board));
  store.register(board, { lane: 'coordinator', path: '/fixture/legacy-kinds-main' });
  store.register(board, { lane: 'web', path: '/fixture/legacy-kinds-worker' });
  board.executionEngineVersion = LANE_LEAD_ENGINE;
  const before = exportBoard(board);
  for (const kind of ['exception', 'idea']) {
    assert.throws(() => store.shout(board, { from: 'web-1', to: 'coordinator', text: 'New kind on old protocol', kind, lanes: ['web'] }),
      error => error.code === 'BAD_MESSAGE_KIND');
  }
  assert.deepEqual(exportBoard(board), before);
});
