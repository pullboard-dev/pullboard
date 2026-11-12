/** pullboard gate --withdraw records a queued or running gate as withdrawn; it never posts a verdict later and a fresh submit starts a new gate [C7]. */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { test } from 'node:test';
import { createE2eHelpers } from '../../tests/fixtures/e2e.js';
import { getItem } from '../../../../packages/store/index.js';
import { writeBoardCommand } from '../../../../packages/store/index.js';
import { queueSubmitHandoff } from '../../../../packages/store/index.js';
import { startSubmitHandoff } from '../../../../packages/store/index.js';
import { submitHandoff } from '../../../../packages/store/index.js';
import { handoffTicketWaiting } from '../../../../packages/resources/index.js';
import { queueHandoffLaunch } from '../../../../packages/resources/index.js';
import { reserveHandoffTicket } from '../../../../packages/resources/index.js';
import { fixtureAdd } from '../../tests/fixtures/testkit.js';
import { fixtureHandoffPolicy } from '../../tests/fixtures/testkit.js';
import { fixtureOpenBoard } from '../../tests/fixtures/testkit.js';
import { joinFixtureSeat } from '../../tests/fixtures/testkit.js';

/**
 * Build a project with an item claimed by the web seat, one committed candidate, and a second seat in the api lane.
 *
 * @param {import('node:test').TestContext} t
 * @returns {Promise<{ box: object, id: number, commit: string, other: string }>}
 */
async function claimed(t) {
  const helpers = createE2eHelpers();
  t.after(() => helpers.cleanup());
  const box = helpers.project('true', helpers.sandbox());
  box.boardFile = fixtureHandoffPolicy(box, helpers.CONFIG);
  const other = join(box.dir, 'api-1');
  box.git(box.repo, 'worktree', 'add', '-q', other, '-b', 'api/one');
  assert.equal(joinFixtureSeat(box, other, 'api', { model: 'fixture-model' }).code, 0);
  const added = fixtureAdd(box.run, box.repo, 'web', 'Gate to withdraw', '--specs', 'G1',
    '--criterion', 'The candidate passes.', '--check', 'true', '--wait', '--json');
  assert.equal(added.code, 0, `${added.err}\n${added.out}`);
  const id = JSON.parse(added.out).item.item_id;
  assert.equal((await box.runLocal(box.web, 'claim', String(id), '--json')).code, 0);
  assert.equal(helpers.commitFile(box, box.web, 'web/record.txt', 'x\n', 'feat(web): record candidate [G1]').status, 0);
  return { box, id, commit: box.git(box.web, 'rev-parse', 'HEAD'), other };
}

/**
 * Queue the item's candidate as its claimed owner and return the queue options.
 *
 * @param {object} box
 * @param {object} board
 * @param {number} id
 * @param {string} commit
 * @returns {object}
 */
function queue(box, board, id, commit) {
  const item = getItem(board, id);
  const tree = box.git(box.web, 'rev-parse', 'HEAD^{tree}');
  const options = { agentId: item.item_owner, job: randomUUID(), main: box.git(box.web, 'rev-parse', 'main'),
    commit, tree, executionCommit: commit, executionTree: tree, digest: item.item_frozen_digest,
    companionDigest: null, leaseMs: 7_200_000 };
  writeBoardCommand(board, 'queueSubmitHandoff', [id, options], item.item_owner);
  return options;
}

for (const running of [false, true]) {
  test(`clause 1: the holder's gate --withdraw records a ${running ? 'running' : 'queued'} gate as withdrawn and removes its ticket [C7]`, async t => {
    const { box, id, commit } = await claimed(t);
    const previous = process.env.PULLBOARD_MACHINE_HOME;
    process.env.PULLBOARD_MACHINE_HOME = box.env.PULLBOARD_MACHINE_HOME;
    t.after(() => { if (previous === undefined) delete process.env.PULLBOARD_MACHINE_HOME; else process.env.PULLBOARD_MACHINE_HOME = previous; });
    let board = fixtureOpenBoard(box);
    let options;
    try {
      options = queue(box, board, id, commit);
      if (running) assert.equal(startSubmitHandoff(board, id, { agentId: options.agentId, job: options.job }).started, true);
      const reservation = await reserveHandoffTicket(options.job);
      queueHandoffLaunch({ directory: box.dir, tools: box.dir, commonDir: join(box.repo, '.git'), job: options.job }, reservation);
      assert.equal(handoffTicketWaiting(options.job), true, 'the gate holds a place in line');
    } finally { board.db.close(); }
    const withdrawn = await box.runLocal(box.web, 'gate', '--withdraw', String(id));
    assert.equal(withdrawn.code, 0, `${withdrawn.err}\n${withdrawn.out}`);
    board = fixtureOpenBoard(box);
    try {
      const record = submitHandoff(board, id);
      assert.equal(record.state, 'withdrawn');
      assert.equal(record.withdrawnBy, options.agentId);
      assert.equal(handoffTicketWaiting(options.job), false, 'no ticket remains');
      assert.equal(getItem(board, id).item_owner, options.agentId, 'the holder keeps the item');
    } finally { board.db.close(); }
    const shown = await box.runLocal(box.web, 'show', String(id));
    assert.match(shown.out, /withdrawn/u);
  });
}

test('clause 1: the coordinator may withdraw a gate; any other seat is refused with the next step [C7]', async t => {
  const { box, id, commit, other } = await claimed(t);
  let board = fixtureOpenBoard(box);
  try { queue(box, board, id, commit); } finally { board.db.close(); }
  const refused = await box.runLocal(other, 'gate', '--withdraw', String(id));
  assert.notEqual(refused.code, 0);
  assert.match(`${refused.err}${refused.out}`, /NOT_YOURS/u);
  assert.match(`${refused.err}${refused.out}`, /next:/u);
  board = fixtureOpenBoard(box);
  try { assert.equal(submitHandoff(board, id).state, 'queued', 'the refused seat changed nothing'); } finally { board.db.close(); }
  const done = await box.runLocal(box.repo, 'gate', '--withdraw', String(id));
  assert.equal(done.code, 0, `${done.err}\n${done.out}`);
  board = fixtureOpenBoard(box);
  try { assert.equal(submitHandoff(board, id).state, 'withdrawn'); } finally { board.db.close(); }
});

test('clause 2: a withdrawn gate never posts a verdict later; its worker result is ignored [C7]', async t => {
  const { box, id, commit } = await claimed(t);
  let board = fixtureOpenBoard(box);
  let options;
  try {
    options = queue(box, board, id, commit);
    assert.equal(startSubmitHandoff(board, id, { agentId: options.agentId, job: options.job }).started, true);
  } finally { board.db.close(); }
  assert.equal((await box.runLocal(box.web, 'gate', '--withdraw', String(id))).code, 0);
  board = fixtureOpenBoard(box);
  try {
    const late = writeBoardCommand(board, 'completeSubmitHandoff', [id, { agentId: options.agentId, job: options.job,
      result: { code: 1, error: { code: 'TESTS_RED', message: 'late red', next: 'fix it' } } }], options.agentId);
    assert.equal(late?.state ?? submitHandoff(board, id).state, 'withdrawn');
    assert.equal(submitHandoff(board, id).state, 'withdrawn');
    assert.equal(submitHandoff(board, id).error, undefined, 'no refusal was recorded');
    assert.equal(startSubmitHandoff(board, id, { agentId: options.agentId, job: options.job }).started, false, 'the dispatcher starts nothing');
  } finally { board.db.close(); }
});

test('clause 3: a fresh submit of the item starts a new gate at once [C7]', async t => {
  const { box, id, commit } = await claimed(t);
  let board = fixtureOpenBoard(box);
  let first;
  try { first = queue(box, board, id, commit); } finally { board.db.close(); }
  assert.equal((await box.runLocal(box.web, 'gate', '--withdraw', String(id))).code, 0);
  board = fixtureOpenBoard(box);
  try {
    const item = getItem(board, id);
    const second = { ...first, job: randomUUID() };
    const queued = queueSubmitHandoff(board, id, second);
    assert.equal(queued.created, true, 'a new gate is queued');
    assert.equal(queued.job.id, second.job);
    assert.equal(item.item_owner, first.agentId);
    assert.equal(submitHandoff(board, id).state, 'queued');
  } finally { board.db.close(); }
});
