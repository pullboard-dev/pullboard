/** Main moves observe live work and refuse conflicting submissions without changing peer files [N2,B3]. */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { after } from 'node:test';
import { test } from 'node:test';
import * as store from '../../../../../packages/store/index.js';
import {
  openBoard,
  openBoardForRead,
} from '../../../../lib/index.js';
import { refreshLandedCodeMap } from '../../../../../packages/landing/index.js';
import { mainMovedWarnings } from '../../../../../packages/merge/index.js';
import { createE2eHelpers } from '../../../tests/fixtures/e2e.js';
import { submitFixture } from '../../../tests/fixtures/board/submit.js';
import { fixtureAdd } from '../../../tests/fixtures/testkit.js';

const e2e = createE2eHelpers();
after(e2e.cleanup);

/** Capture both metadata and actual bytes that a warning must leave alone. */
function snapshot(box, root) {
  return { head: box.git(root, 'rev-parse', 'HEAD'), status: box.git(root, 'status', '--porcelain=v1'),
    index: readFileSync(box.git(root, 'rev-parse', '--path-format=absolute', '--git-path', 'index')),
    source: readFileSync(join(root, 'web/shared.txt')) };
}

test('a landing warns on a claimed local HEAD, then submit refuses until a real main merge [N2,B3]', async () => {
  const box = e2e.project('true');
  assert.equal(e2e.commitFile(box, box.repo, 'web/shared.txt', 'base\n', 'chore: shared fixture').status, 0);
  box.git(box.web, 'merge', '--ff-only', 'main');
  const added = fixtureAdd(box.run, box.repo, 'web', 'Keep local work', '--specs', 'G1',
    '--criterion', 'the shared source exists', '--check', 'test -f web/shared.txt', '--json');
  assert.equal(added.code, 0, added.err);
  const claimed = box.run(box.web, 'claim', '1', '--json');
  assert.equal(claimed.code, 0, claimed.err);
  const workerPath = JSON.parse(claimed.out).itemFolder;
  assert.equal(e2e.commitFile(box, workerPath, 'web/shared.txt', 'worker\n', 'feat(web): local work [G1]').status, 0);
  const worker = box.git(workerPath, 'rev-parse', 'HEAD');
  assert.equal(e2e.commitFile(box, box.repo, 'web/shared.txt', 'trunk\n', 'chore: conflicting landing').status, 0);
  const trunk = box.git(box.repo, 'rev-parse', 'HEAD');
  const file = join(box.repo, '.git/pullboard/board.sqlite');
  const beforeWorker = snapshot(box, workerPath);
  const beforeMain = snapshot(box, box.repo);
  // @pullboard-board-file journey: the CLI and post-landing observer share this durable fixture board.
  const board = openBoard(file);
  let landed;
  try {
    const builder = store.register(board, { lane: 'api', path: join(box.dir, 'landing-builder') });
    const reviewer = store.register(board, { lane: 'api', path: join(box.dir, 'landing-reviewer') });
    landed = store.addItem(board, { by: 'coordinator', lane: 'api', title: 'Recorded landing fixture' });
    const freeze = () => ({ text: 'fixture landing', digest: 'fixture-landing-digest' });
    store.claim(board, landed, { agentId: builder, lane: 'api', leaseMs: 3600000, freeze });
    submitFixture(board, landed, { agentId: builder, commit: trunk, tree: box.git(box.repo, 'rev-parse', 'HEAD^{tree}') });
    store.verify(board, landed, { agentId: reviewer, decision: 'ACCEPT', reason: 'CRITERION_MET',
      note: 'synthetic board-state setup only, not an executed proof', head: trunk, digest: 'fixture-landing-digest', policy: 'any' });
    assert.deepEqual(mainMovedWarnings({ root: box.repo, board, trunk }, { listAgents: store.listAgents, listItems: store.listItems }).find(warning => warning.item === 1),
      { item: 1, head: worker, trunk, files: ['web/shared.txt'] });
    const notices = [];
    await refreshLandedCodeMap({ root: box.repo, board, batch: { tip: trunk },
      write: async (operation, args) => board.enginePorts.store[operation](board, ...args), say: text => notices.push(text) });
    assert.ok(notices.some(text => text.includes('web/shared.txt') && text.includes('git merge main')),
      'the actual shared land publish/finishTrunk post-landing hook emits its warning');
  } finally { store.closeBoard(board); }
  const merged = box.run(box.repo, 'merged', String(landed), trunk);
  assert.equal(merged.code, 0, merged.err);
  assert.match(merged.out, /web\/shared\.txt/u);
  assert.match(merged.out, /git merge main/u);
  assert.deepEqual(snapshot(box, workerPath), beforeWorker);
  assert.deepEqual(snapshot(box, box.repo), beforeMain);
  // @pullboard-board-file journey: inspect the same durable warning after the native merged command.
  const read = openBoardForRead(file);
  try {
    const notices = read.db.prepare("SELECT shout_text FROM shout WHERE shout_to='item:1'").all();
    assert.equal(notices.filter(notice => notice.shout_text.includes('web/shared.txt') && notice.shout_text.includes(trunk.slice(0, 12))).length, 1,
      'the land hook and merged receipt share one deduplicated board warning');
  } finally { store.closeBoard(read); }
  const refused = box.run(workerPath, 'submit', '1', '--json');
  assert.equal(refused.code, 1);
  assert.match(refused.err + refused.out, /MERGE_CONFLICT/u);
  assert.match(refused.err + refused.out, /web\/shared\.txt/u);
  assert.equal(box.tryGit(workerPath, 'merge', 'main').status, 1, 'the fixture really has conflicting committed edits');
  const resolved = e2e.commitFile(box, workerPath, 'web/shared.txt', 'worker and trunk\n', 'feat(web): merge main [G1]');
  assert.equal(resolved.status, 0, resolved.context);
  assert.equal(box.git(workerPath, 'rev-parse', 'HEAD^2'), trunk, 'normal merge retains the original history');
  const submitted = box.run(workerPath, 'submit', '1', '--json');
  assert.equal(submitted.code, 0, submitted.err + submitted.out);
});
