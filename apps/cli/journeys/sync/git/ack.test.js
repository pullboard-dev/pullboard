/** Git sharing turns on only after origin accepts the first board; a refusal never freezes later writes [C7]. */
import assert from 'node:assert/strict';
import {
  chmodSync,
  existsSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { createE2eHelpers } from '../../../tests/fixtures/e2e.js';
import { fixtureAdd } from '../../../tests/fixtures/testkit.js';

/** Give the fixture bare remote a receive hook that refuses every push, as a protected origin does. */
function refusingRemote(box) {
  const remote = join(box.dir, 'remote.git');
  box.git(box.dir, 'clone', '--bare', box.repo, remote);
  box.git(box.repo, 'remote', 'add', 'origin', remote);
  const hook = join(remote, 'hooks', 'pre-receive');
  writeFileSync(hook, '#!/bin/sh\necho "fixture origin refuses pushes" >&2\nexit 1\n');
  chmodSync(hook, 0o755);
  return remote;
}

test('a refused first sync push leaves no git-sync.json marker and its refusal never says run pullboard sync [C7,#3088]', t => {
  const helpers = createE2eHelpers();
  t.after(helpers.cleanup);
  const box = helpers.project();
  const remote = refusingRemote(box);
  const refused = box.run(box.repo, 'sync', '--json');
  assert.notEqual(refused.code, 0, 'origin refused, so sync cannot report success');
  const error = JSON.parse(refused.out).error;
  assert.equal(error.code, 'GIT_SYNC_REMOTE');
  assert.doesNotMatch(JSON.stringify(error), /pullboard sync/u, 'the refusal never tells an agent to run pullboard sync');
  assert.equal(existsSync(join(box.repo, '.git', 'pullboard', 'git-sync.json')), false, 'no marker is left behind');
  assert.equal(String(box.git(remote, 'for-each-ref', 'refs/pullboard/board') ?? '').trim(), '', 'origin holds no board');
});

test('with a marker origin never accepted, other commands warn and write local-only, never GIT_SYNC_LOCK_BUSY or GIT_SYNC_REMOTE [C7,#3088]', t => {
  const helpers = createE2eHelpers();
  t.after(helpers.cleanup);
  const box = helpers.project();
  refusingRemote(box);
  // The marker an older sync wrote before its first push was refused.
  writeFileSync(join(box.repo, '.git', 'pullboard', 'git-sync.json'), JSON.stringify({ version: 1, remote: 'origin',
    ref: 'refs/pullboard/board', writer: { command: 'sync', pid: 99999999, at: '2026-11-04T19:36:00.000Z' } }) + '\n');
  for (const title of ['First local write', 'Second local write']) {
    const added = fixtureAdd(box.run, box.repo, 'web', title, '--json');
    assert.equal(added.code, 0, `${title}: ${added.out}\n${added.err}`);
    assert.doesNotMatch(added.out + added.err, /GIT_SYNC_LOCK_BUSY|GIT_SYNC_REMOTE|run pullboard sync/u);
    assert.match(added.out + added.err, /runs local-only/u, 'the command warns, in its diagnostics, that it runs local-only');
  }
  const shouted = box.run(box.web, 'shout', 'all', 'still writing locally', '--json');
  assert.equal(shouted.code, 0, `${shouted.out}\n${shouted.err}`);
  assert.doesNotMatch(shouted.out + shouted.err, /GIT_SYNC_LOCK_BUSY|GIT_SYNC_REMOTE|run pullboard sync/u);
  const board = JSON.parse(box.run(box.repo, 'export').out);
  assert.deepEqual(board.tables.item.map(item => item.item_title).sort(), ['First local write', 'Second local write']);
  assert.equal(existsSync(join(box.repo, '.git', 'pullboard', 'git-sync-pending.json')), false, 'no push intent was sealed');
});
