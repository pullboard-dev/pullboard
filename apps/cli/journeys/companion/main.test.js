/** Companion requests and claims share the real board transaction [B2,B5,B12,H16]. */
import assert from 'node:assert/strict';
import { join } from 'node:path';
import {
  after,
  test,
} from 'node:test';
import * as store from '../../../../packages/store/index.js';
import { openBoard } from '../../../lib/index.js';
import {
  prepareEngineMove,
  applyRelayMove,
} from '../../../../packages/state/index.js';
import { COMPANION_ENGINE } from '../../../../packages/state/light.js';
import { createdItems } from '../../../../packages/link/index.js';
import { createE2eHelpers } from '../../tests/fixtures/e2e.js';

const helpers = createE2eHelpers();
after(helpers.cleanup);

/** Run a private real CLI command without discarding its refusal diagnostics. */
async function run(box, cwd, ...args) {
  const result = await box.runLocal(cwd, ...args);
  assert.equal(result.code, 0, `${args.join(' ')}: ${result.err}${result.out}`);
  return args.includes('--json') ? JSON.parse(result.out) : result.out;
}

/** Join another independent worktree, retaining the shared real SQLite board. */
async function seat(box, name, lane) {
  const path = join(box.dir, name);
  box.git(box.repo, 'worktree', 'add', '-q', '--detach', path, 'HEAD');
  await run(box, path, 'join', lane, '--model', 'fixture-companion-opus');
  return path;
}

test('a companion request becomes one claimable child item and a second request finds it [B2,B5,B12,H16]', async () => {
  const box = helpers.project('true');
  const other = await seat(box, 'requester-two', 'web');
  const parent = (await run(box, box.repo, 'add', 'web', 'Parent feature', '--specs', 'G1', '--criterion', 'needs the API', '--json')).item.item_id;
  await run(box, box.web, 'claim', String(parent));
  const args = ['companion', String(parent), 'api', 'Provide the API', '--key', 'api-part', '--criterion', 'the API serves this parent [test]', '--specs', 'G2', '--route', 'strong', '--json'];
  // Process-level case: only separate OS processes prove one creation under real contention, so these two stay launched processes.
  // Concurrent independent processes must observe one creation, not merely converge after serial retries.
  const children = [box.web, other].map(cwd => helpers.launch(box, cwd, process.execPath, [helpers.BIN, ...args]));
  const completed = await Promise.all(children.map(child => child.closed));
  completed.forEach((result, index) => assert.equal(result.code, 0, children[index].stderrText + children[index].stdoutText));
  const results = children.map(child => JSON.parse(child.stdoutText));
  assert.equal(results[0].item.item_id, results[1].item.item_id);
  assert.deepEqual(results.map(result => result.created).sort(), [false, true]);
  const child = results[0].item;
  assert.equal(child.item_parent_id, parent);
  assert.equal(child.item_lane, 'api');
  assert.equal(child.item_criterion, 'the API serves this parent [test]');
  assert.equal((await run(box, other, ...args)).item.item_id, child.item_id, 'a later request retains the same durable child');
  const first = await seat(box, 'api-builder-one', 'api');
  const second = await seat(box, 'api-builder-two', 'api');
  await run(box, first, 'claim', String(child.item_id));
  const refused = await box.runLocal(second, 'claim', String(child.item_id));
  assert.equal(refused.code, 1);
  assert.match(refused.err + refused.out, /HELD/u, 'ordinary exclusive claims prevent duplicate companion builders');
  const read = openBoard(join(box.repo, '.git', 'pullboard', 'board.sqlite'));
  try {
    assert.equal(store.listItems(read, { all: true }).filter(item => item.item_parent_id === parent).length, 1);
    assert.equal(store.events(read).filter(event => event.event_kind === 'add' && event.item_id === child.item_id).length, 1);
    assert.equal(store.getItem(read, child.item_id).item_owner, (await run(box, first, 'whoami', '--json')).id);
    assert.throws(() => store.addItem(read, { by: 'coordinator', lane: 'api', parentId: parent, title: 'Ordinary cross-lane child' }), /PARENT_LANE/u,
      'the companion operation does not weaken historical ordinary-add parenting');
  } finally { store.closeBoard(read); }
  assert.equal((await box.runLocal(box.web, 'companion', String(parent), 'web', 'Wrong lane', '--key', 'wrong')).code, 1);
  assert.equal((await box.runLocal(box.web, 'companion', String(parent), 'api', 'Missing key')).code, 1);
});


test('companion delivery preserves authenticated actors, engine fences and durable child identities [B2,B12,H16]', async () => {
  const box = helpers.project('true');
  const parent = (await run(box, box.repo, 'add', 'web', 'Transport parent', '--specs', 'G1', '--json')).item.item_id;
  const board = openBoard(join(box.repo, '.git', 'pullboard', 'board.sqlite'));
  try {
    const agentId = store.agentAt(board, box.web).agent_id;
    const request = { agentId, parentId: parent, lane: 'api', key: 'wire-part', title: 'API transport work', criterion: 'one child', specIds: ['G2'] };
    const move = prepareEngineMove(board, 'requestCompanion', [request], { id: 'companion-wire-one', actor: agentId });
    const options = { sequence: 1, at: new Date().toISOString(), kind: 'move', sender: { kind: 'agent', agent: agentId, userId: 'fixture-person' } };
    assert.throws(() => applyRelayMove(board, { ...move, engine: COMPANION_ENGINE - 1 }, options), /RELAY_MOVE/u);
    assert.equal(store.listItems(board, { all: true }).length, 1, 'an old engine creates no child');
    const forged = applyRelayMove(board, { ...move, id: 'companion-forged-actor' }, { ...options, sender: { ...options.sender, agent: 'another-seat' } });
    assert.equal(forged.error.code, 'RELAY_SENDER_MISMATCH');
    const receipt = applyRelayMove(board, move, { ...options, sequence: 2 });
    assert.equal(receipt.result.created, true);
    assert.equal(store.getItem(board, receipt.result.item).item_created_by, agentId);
    assert.deepEqual(applyRelayMove(board, move, { ...options, sequence: 2 }), receipt, 'duplicate delivery retains its original receipt');
    assert.deepEqual(createdItems('requestCompanion', receipt.result), [{ resultPath: ['item'], item: receipt.result.item }], 'queued transport binds the child result rather than the parent argument');
    const retry = store.requestCompanion(board, { ...request, title: 'Do not overwrite the original child' });
    assert.equal(retry.created, false);
    assert.equal(retry.item, receipt.result.item);
    assert.equal(store.getItem(board, retry.item).item_title, request.title);
    assert.throws(() => store.requestCompanion(board, { ...request, key: 'forged-check', check: 'true' }), /COORDINATOR_CHECK/u);
    assert.throws(() => store.requestCompanion(board, { ...request, key: 'unjoined', agentId: 'unjoined-seat' }), /NOT_JOINED/u);
    const extra = store.requestCompanion(board, { ...request, key: 'different-work' });
    assert.notEqual(extra.item, retry.item, 'explicitly distinct requests remain separate children');
    store.withdraw(board, parent, { agentId: 'coordinator', reason: 'No further companion requests' });
    assert.equal(store.requestCompanion(board, request).item, retry.item, 'closed parents retain existing request identities');
    assert.throws(() => store.requestCompanion(board, { ...request, key: 'new-after-close' }), /PARENT_CLOSED/u);
  } finally { store.closeBoard(board); }
});
