/** Rejection immediately returns work to every eligible seat while preserving V6's new-head guard [C7,V6]. */
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import * as store from '../index.js';
import { REJECT_OPEN_ENGINE } from '../../state/index.js';
import { cellBoard } from './fixtures/cell.js';
import { cellProject } from './fixtures/cell.js';
import { submitFixture } from './fixtures/submit.js';

/** Write one file in a checkout and commit it, as a seat building in its own worktree does. */
function commitFile(project, cwd, path, text, message) {
  mkdirSync(join(cwd, path, '..'), { recursive: true });
  writeFileSync(join(cwd, path), text);
  project.git(cwd, 'add', '-A');
  return project.tryGit(cwd, 'commit', '-q', '-m', message);
}

/** Bind native SQLite moves to real private Git history and hold the clock fixed throughout rejection and takeover. */
function fixture(t, { engine = REJECT_OPEN_ENGINE, returnRejectedWork = true, reworkSameFamily = false } = {}) {
  const project = cellProject(t, { real: true });
  const web = join(project.dir, 'web');
  project.git(project.repo, 'worktree', 'add', '-q', web, '-b', 'web/one');
  const at = Date.parse('2026-11-03T12:00:00.000Z');
  const board = cellBoard(t, ':memory:', { now: () => new Date(at) }, { gitRoot: project.repo });
  board.executionEngineVersion = engine;
  store.register(board, { lane: 'coordinator', path: project.repo });
  const builder = store.register(board, { lane: 'web', path: web, route: 'mid', family: 'openai' });
  const peer = store.register(board, { lane: 'web', path: `${project.dir}/peer`, route: 'mid', family: 'anthropic' });
  const reviewer = store.register(board, { lane: 'web', path: `${project.dir}/review`, route: 'mid', family: 'google' });
  for (const [key, value] of Object.entries({ returnRejectedWork, reworkSameFamily })) {
    store.setLineSetting(board, { agentId: 'coordinator', key, value, reason: 'Exercise the approved native routing setting', window: { fixture: 1 } });
  }
  const id = store.addItem(board, { by: 'coordinator', lane: 'web', title: 'Rejected fix', criterion: 'the fix works',
    route: 'mid', brief: 'Files: web/result.txt\nTest: immediate takeover', check: 'true' });
  const freeze = item => ({ text: JSON.stringify({ criterion: item.item_criterion }), digest: 'reject-open-bar' });
  const claim = (agentId, lane = 'web') => store.claim(board, id, { agentId, lane, leaseMs: 60 * 60_000, freeze });
  claim(builder);
  assert.equal(commitFile(project, web, 'web/result.txt', 'first result\n', 'feat(web): first result [G1]').status, 0);
  const commit = project.git(web, 'rev-parse', 'HEAD');
  const policyCommit = project.git(project.repo, 'rev-parse', 'main');
  const submit = (agentId, head = commit) => submitFixture(board, id, { agentId, commit: head,
    tree: project.git(web, 'rev-parse', `${head}^{tree}`), policyCommit, clausePolicyCommit: policyCommit, inspectClauses: true });
  submit(builder);
  store.verify(board, id, { agentId: reviewer, decision: 'REJECT', reason: 'OTHER', note: 'the frozen fix still needs rework',
    clause: 'the fix works', head: commit, digest: 'reject-open-bar', policy: 'any', reopenFirstRefusalMinutes: 30 });
  return { board, project, web, id, builder, peer, claim, submit, at };
}

for (const settings of [
  { returnRejectedWork: true, reworkSameFamily: false },
  { returnRejectedWork: false, reworkSameFamily: true },
  { returnRejectedWork: false, reworkSameFamily: false },
]) {
  test(`a different vendor claims a rejection immediately with ${JSON.stringify(settings)} [C7,V6]`, t => {
    const f = fixture(t, settings);
    const rejection = store.itemThread(f.board, f.id).findLast(entry => entry.kind === 'reject');
    assert.equal(rejection.at, new Date(f.at).toISOString());
    assert.equal(rejection.detail.reopenFirstRefusal, undefined, 'new rejections seal no builder reservation');
    assert.equal(store.firstRefusal(f.board, f.id), null);
    const next = store.nextFor(f.board, { agentId: f.peer, lane: 'web', reworkRoutingPolicy: { takeoverMs: 1, graceMs: 1 } });
    assert.equal(next.item?.item_id, f.id, 'ordinary selection offers it without a clock advance');
    assert.throws(() => f.claim(f.peer, 'api'), { code: 'WRONG_LANE' }, 'ordinary eligibility remains enforced');
    f.claim(f.peer);
    assert.equal(store.getItem(f.board, f.id).item_owner, f.peer);
    assert.throws(() => f.submit(f.peer), { code: 'HEAD_NOT_NEW' }, 'changing builders cannot reuse the rejected commit');
    assert.equal(newCommit(f), 0);
    const newHead = f.project.git(f.web, 'rev-parse', 'HEAD');
    f.submit(f.peer, newHead);
    assert.equal(store.getItem(f.board, f.id).item_status, 'submitted');
  });
}

/** Produce the new real Git head that V6 requires; no fake SHA bypasses the submit guard. */
function newCommit(f) {
  return commitFile(f.project, f.web, 'web/result.txt', 'corrected result\n', 'fix(web): correct result [G1]').status;
}

test('current claims ignore a historical rejection reservation while historical replay retains it [C7,V6]', t => {
  const f = fixture(t, { engine: REJECT_OPEN_ENGINE - 1 });
  assert.ok(store.firstRefusal(f.board, f.id), 'the old engine seals its original reservation');
  assert.throws(() => f.claim(f.peer), { code: 'REOPEN_HELD_FOR_BUILDER' });
  f.board.executionEngineVersion = REJECT_OPEN_ENGINE;
  assert.equal(store.firstRefusal(f.board, f.id), null, 'upgrading frees an existing rejected item immediately');
  f.claim(f.peer);
  assert.equal(store.getItem(f.board, f.id).item_owner, f.peer);
  assert.throws(() => f.submit(f.peer), { code: 'HEAD_NOT_NEW' });
});
