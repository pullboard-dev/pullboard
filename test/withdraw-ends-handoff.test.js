/** Withdrawing an item ends its queued or running gate hand-off and removes its place in line [C7]. */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { test } from 'node:test';
import { createE2eHelpers } from './e2e-helpers.js';
import { getItem } from '../packages/store/index.js';
import { writeBoardCommand } from '../packages/store/index.js';
import { startSubmitHandoff } from '../packages/store/index.js';
import { submitHandoff } from '../packages/store/index.js';
import { handoffTicketWaiting } from '../packages/resources/index.js';
import { queueHandoffLaunch } from '../packages/resources/index.js';
import { reserveHandoffTicket } from '../packages/resources/index.js';
import { fixtureAdd } from './testkit-fixture.js';
import { fixtureHandoffPolicy } from './testkit-fixture.js';
import { fixtureOpenBoard } from './testkit-fixture.js';

/**
 * Build a project with a claimed item and one committed candidate, ready to queue.
 *
 * @param {import('node:test').TestContext} t
 * @returns {{ box: object, id: number, commit: string }}
 */
function claimed(t) {
  const helpers = createE2eHelpers();
  t.after(() => helpers.cleanup());
  const box = helpers.project('true', helpers.sandbox());
  box.boardFile = fixtureHandoffPolicy(box, helpers.CONFIG);
  const added = fixtureAdd(box.run, box.repo, 'web', 'Withdrawn hand-off source', '--specs', 'G1',
    '--criterion', 'The candidate passes.', '--check', 'true', '--wait', '--json');
  assert.equal(added.code, 0, `${added.err}\n${added.out}`);
  const id = JSON.parse(added.out).item.item_id;
  assert.equal(box.run(box.web, 'claim', String(id), '--json').code, 0);
  assert.equal(helpers.commitFile(box, box.web, 'web/record.txt', 'x\n', 'feat(web): record candidate [G1]').status, 0);
  return { box, id, commit: box.git(box.web, 'rev-parse', 'HEAD') };
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
  test(`clause 1: withdrawing an item with a ${running ? 'running' : 'queued'} hand-off ends it as withdrawn and removes its queue ticket [C7]`, async t => {
    const { box, id, commit } = claimed(t);
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
      assert.equal(handoffTicketWaiting(options.job), true, 'the hand-off holds a place in line');
      assert.equal(submitHandoff(board, id).state, running ? 'running' : 'queued');
    } finally { board.db.close(); }
    const withdrawn = box.run(box.repo, 'withdraw', String(id), 'obsolete');
    assert.equal(withdrawn.code, 0, `${withdrawn.err}\n${withdrawn.out}`);
    board = fixtureOpenBoard(box);
    try {
      const ended = submitHandoff(board, id);
      assert.equal(ended.state, 'ended');
      assert.equal(ended.reason, 'withdrawn');
      assert.equal(handoffTicketWaiting(options.job), false, 'no ticket remains');
      assert.equal(startSubmitHandoff(board, id, { agentId: options.agentId, job: options.job }).started, false, 'the dispatcher starts nothing');
    } finally { board.db.close(); }
  });
}
