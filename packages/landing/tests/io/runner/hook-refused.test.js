/** A land job whose push a trunk hook refuses gives its item back with the hook's words and lands nothing [C7,P7]. @pullboard-test-input source-cell packages/landing */
import assert from 'node:assert/strict';
import { chmodSync } from 'node:fs';
import { rmSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { fixture } from '../../fixtures/plan.js';
import { git } from '../../fixtures/plan.js';
import { privateFixtureFiles } from '../../../../gate/tests/fixtures/child.js';
import { hookRefusal } from '../../../src/io/runner/job.js';
import { runLandingJob } from '../../../index.js';

const ITEM = 52;

test('clause 1: a trunk pre-receive hook refusing the push returns the item with the hook\'s refusal and moves nothing [C7,P7]', async t => {
  const { root: dir } = privateFixtureFiles('pullboard-land-hook-');
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const { root: work, put } = fixture(t);
  const remote = join(dir, 'remote.git');
  git(dir, 'clone', '-q', '--bare', work, remote);
  git(work, 'checkout', '-q', '-b', 'item');
  put('item.txt', 'item\n');
  git(work, 'add', '-A');
  git(work, 'commit', '-q', '-m', 'feat: item [C7]');
  const commit = git(work, 'rev-parse', 'HEAD').trim();
  git(work, 'push', '-q', remote, 'main:refs/heads/main', `item:refs/heads/item-${ITEM}`);
  const tip = () => git(dir, '--git-dir', remote, 'rev-parse', 'refs/heads/main').trim();
  const before = tip();
  writeFileSync(join(remote, 'hooks', 'pre-receive'), '#!/bin/sh\necho "TRUNK_FROZEN: trunk takes no pushes today" >&2\nexit 1\n');
  chmodSync(join(remote, 'hooks', 'pre-receive'), 0o755);
  const receipt = await runLandingJob({ remote, trunk: 'refs/heads/main', expect: before, publish: 'separate', items: [{ id: ITEM, commit, ref: `refs/heads/item-${ITEM}` }] },
    { workdir: join(dir, 'runner'), checks: () => ({ ok: true }) });
  assert.equal(receipt.outcome, 'red');
  assert.deepEqual(receipt.landed, []);
  assert.equal(receipt.returned.length, 1);
  assert.equal(receipt.returned[0].id, ITEM);
  assert.equal(receipt.returned[0].reason, 'hook');
  assert.match(receipt.returned[0].detail, /TRUNK_FROZEN: trunk takes no pushes today/u);
  assert.equal(tip(), before, 'the refused push moved nothing');
});

test('clause 1: a push refused for any other reason is no hook refusal [C7,P7]', () => {
  assert.equal(hookRefusal({ stderr: 'fatal: unable to access remote', stdout: '' }), null);
  assert.match(hookRefusal({ stderr: 'remote: nope\n ! [remote rejected] x -> main (pre-receive hook declined)', stdout: '' }), /nope/u);
});
