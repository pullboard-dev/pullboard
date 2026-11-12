/** Two independent Git clones and SQLite replicas exercise account-free sharing [H11]. */
import assert from 'node:assert/strict';
import {
  chmodSync,
  existsSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { createE2eHelpers } from '../../tests/fixtures/e2e.js';
import { fixtureAdd } from '../../tests/fixtures/testkit.js';
import { fixtureJoin } from '../../tests/fixtures/testkit.js';

/** Read one successful public CLI JSON response, preserving failures in the assertion. */
function document(result, purpose) {
  assert.equal(result.code, 0, `${purpose}: ${result.out}\n${result.err ?? ''}`);
  return JSON.parse(result.out);
}

test('two machines share a board through git [H11]', async t => {
  const helpers = createE2eHelpers();
  t.after(helpers.cleanup);
  const box = helpers.project();
  const remote = join(box.dir, 'remote.git');
  box.git(box.dir, 'clone', '--bare', box.repo, remote);
  box.git(box.repo, 'remote', 'add', 'origin', remote);
  document((await box.runLocal(box.repo, 'sync', '--json')), 'explicit sync shares the first machine without a relay account');
  const clone = join(box.dir, 'second');
  box.git(box.dir, 'clone', remote, clone);
  // As project() does, keep an undeclared disposable coordinator during initial setup.
  const inheritedModel = box.env.PULLBOARD_MODEL;
  delete box.env.PULLBOARD_MODEL;
  const initialized = (await box.runLocal(clone, 'init'));
  if (inheritedModel !== undefined) box.env.PULLBOARD_MODEL = inheritedModel;
  assert.equal(initialized.code, 0, 'initialize only the clone-local board');
  document((await box.runLocal(clone, 'sync', '--json')), 'the second machine joins the same board');
  const secondSeat = join(box.dir, 'second-web');
  box.git(clone, 'worktree', 'add', secondSeat, '-b', 'web/second');
  document(fixtureJoin(box.run, secondSeat, 'web', '--model', 'fixture', '--route', 'strong', '--json'), 'join a distinct seat on machine two');
  /** Start a public CLI command so independent machines can race real Git pushes. */
  async function run(root, ...args) {
    const child = helpers.launch(box, root, process.execPath, [helpers.BIN, ...args, '--json']);
    const result = await child.closed;
    return { code: result.code, out: child.stdoutText, err: child.stderrText };
  }
  const additions = await Promise.all([
    fixtureAdd(run, box.repo, 'web', 'From machine one'),
    fixtureAdd(run, clone, 'web', 'From machine two'),
  ]);
  const ids = additions.map(result => document(result, 'concurrent addition').item.item_id);
  assert.notEqual(ids[0], ids[1], 'competing additions receive globally ordered IDs');
  const claims = await Promise.all([run(box.web, 'claim', String(ids[0])), run(secondSeat, 'claim', String(ids[0]))]);
  assert.equal(claims.filter(result => result.code === 0).length, 1, 'one holder wins');
  assert.equal(JSON.parse(claims.find(result => result.code !== 0).out).error.code, 'HELD');
  // A real receive hook loses one push. Retrying must publish just one addition.
  const hook = join(remote, 'hooks', 'pre-receive');
  writeFileSync(hook, '#!/bin/sh\nrm -- "$0"\nexit 1\n');
  chmodSync(hook, 0o755);
  const retried = document(await fixtureAdd(run, box.repo, 'web', 'Survives one lost push'), 'retry the refused push').item.item_id;
  for (const root of [box.repo, clone]) {
    document((await box.runLocal(root, 'sync', '--json')), 'synchronize the accepted prefix');
    const board = document((await box.runLocal(root, 'export')), 'export the converged public board');
    assert.deepEqual(board.tables.item.map(item => item.item_id).sort((a, b) => a - b), [...ids, retried].sort((a, b) => a - b));
    assert.equal(board.tables.event.filter(event => event.event_kind === 'add' && event.item_id === retried).length, 1, 'the retried move is recorded once');
    assert.equal(board.tables.event.filter(event => event.event_kind === 'claim').length, 1, 'only the winning claim becomes a move');
  }
});

test('Git sharing preserves offline reads, a pending move and ordinary code gates [H11,H10,C3]', async t => {
  const helpers = createE2eHelpers();
  t.after(helpers.cleanup);
  const box = helpers.project();
  const remote = join(box.dir, 'remote.git');
  box.git(box.dir, 'clone', '--bare', box.repo, remote);
  box.git(box.repo, 'remote', 'add', 'origin', remote);
  document((await box.runLocal(box.repo, 'sync', '--json')), 'enable Git board sharing');
  renameSync(remote, remote + '.offline');
  assert.equal(document((await box.runLocal(box.repo, 'export')), 'read the board while offline').tables.item.length, 0);
  const refused = (await fixtureAdd(box.runLocal, box.repo, 'web', 'One pending move', '--json'));
  assert.notEqual(refused.code, 0, 'an offline move cannot report success');
  assert.equal(JSON.parse(refused.out).error.code, 'GIT_SYNC_REMOTE');
  const pendingFile = join(box.repo, '.git', 'pullboard', 'git-sync-pending.json');
  assert.ok(existsSync(pendingFile), 'the refused command retains its sealed intent');
  const moveId = JSON.parse(readFileSync(pendingFile, 'utf8')).move.id;
  assert.equal(document((await box.runLocal(box.repo, 'export')), 'offline read does not apply the pending move').tables.item.length, 0);
  renameSync(remote + '.offline', remote);
  const recovered = document((await fixtureAdd(box.runLocal, box.repo, 'web', 'One pending move', '--json')), 'retry the same public command');
  assert.equal(recovered.item.item_id, 1);
  assert.equal(existsSync(pendingFile), false);
  const exported = document((await box.runLocal(box.repo, 'export')), 'read the acknowledged pending move');
  assert.equal(exported.tables.item.length, 1, 'the retried command creates one item');
  assert.ok(exported.tables.board_meta.some(row => row.meta_key === 'relay_receipt_' + moveId), 'the original sealed identity was acknowledged');
  writeFileSync(join(box.repo, 'web.txt'), 'a source change\n');
  box.git(box.repo, 'add', 'web.txt');
  box.git(box.repo, 'commit', '-m', 'feat(web): a code change [G1]');
  writeFileSync(join(box.repo, 'RED'), 'the code gate fails\n');
  assert.notEqual(box.tryGit(box.repo, 'push', 'origin', 'HEAD:main').status, 0, 'ordinary code pushes still run and fail the code gate');
  document((await fixtureAdd(box.runLocal, box.repo, 'web', 'Board data while code gate is red', '--json')), 'normal Git push accepts validated board data without shipping code');
  const before = box.git(box.repo, 'ls-remote', 'origin', 'refs/pullboard/board');
  const tip = before.split(/\s/u)[0];
  const wrongTree = box.git(box.repo, 'rev-parse', 'HEAD^{tree}');
  const badData = box.git(box.repo, 'commit-tree', wrongTree, '-p', tip, '-m', 'not board data');
  assert.notEqual(box.tryGit(box.repo, 'push', 'origin', badData + ':refs/pullboard/board').status, 0, 'a fast-forward code tree cannot masquerade as the board-data ref');
  assert.equal(box.git(box.repo, 'ls-remote', 'origin', 'refs/pullboard/board'), before, 'the malformed data push leaves the remote untouched');
});
