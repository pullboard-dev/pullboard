/** A trunk remote whose ssh login takes only plain git commands lands by a plain push, and doctor names a checkout trunk that cannot take one [C7,#7952]. */
import assert from 'node:assert/strict';
import { chmodSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import { rmSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { userInfo } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { git } from '../../../../../packages/git/index.js';
import { privateFixtureFiles } from '../../../../../packages/gate/tests/fixtures/child.js';
import { fixtureCommittedGraph } from '../../../tests/fixtures/testkit.js';
import { pushTrunk } from '../../../../../packages/landing/index.js';
import { trunkUpdateInsteadProblem } from '../../../src/io/landing/checkout.js';

const TRUNK = 'refs/heads/main';

/** A scratch trunk (non-bare, main checked out) and a clone one commit ahead of it; ssh is a wrapper that takes plain git commands only. */
function scratch(t, { updateInstead }) {
  const graph = fixtureCommittedGraph('pullboard-restricted-');
  const { root: dir } = privateFixtureFiles('pullboard-restricted-work-');
  t.after(() => { rmSync(dir, { recursive: true, force: true }); rmSync(graph.root, { recursive: true, force: true }); });
  const trunk = graph.root;
  const work = join(dir, 'work');
  graph.put('base.txt', 'base\n');
  graph.commit();
  if (updateInstead) git(trunk, ['config', 'receive.denyCurrentBranch', 'updateInstead']);
  git(dir, ['clone', '-q', trunk, work]);
  writeFileSync(join(work, 'landed.txt'), 'landed\n');
  git(work, ['add', 'landed.txt']);
  git(work, ['-c', 'user.name=T', '-c', 'user.email=t@t.invalid', 'commit', '-q', '-m', 'land']);
  const ssh = join(dir, 'restricted-ssh');
  writeFileSync(ssh, '#!/bin/sh\nfor last; do :; done\ncase "$last" in\n  git-receive-pack*|git-upload-pack*) eval "$last" ;;\n  *) echo "fatal: unrecognized command \'$last\'" >&2; exit 128 ;;\nesac\n');
  chmodSync(ssh, 0o755);
  return { dir, trunk, work, ssh, base: git(work, ['rev-parse', 'HEAD~1']) };
}

/** Run work with GIT_SSH_COMMAND naming the restricted wrapper, then restore it. */
function withRestrictedSsh(ssh, work) {
  const before = process.env.GIT_SSH_COMMAND;
  process.env.GIT_SSH_COMMAND = ssh;
  try { return work(); } finally { if (before === undefined) delete process.env.GIT_SSH_COMMAND; else process.env.GIT_SSH_COMMAND = before; }
}

test('#7952 clause 1: a push into a checkout trunk whose ssh login rejects the custom receive-pack retries plain and lands, keeping the compare-and-swap [C7]', t => {
  const { trunk, work, ssh, base } = scratch(t, { updateInstead: true });
  const remote = `${userInfo().username}@127.0.0.1:${trunk}`;
  const pushed = withRestrictedSsh(ssh, () => pushTrunk(work, { payload: { checkout: true }, trunk: TRUNK, base, remote }));
  assert.equal(pushed.status, 0, pushed.stderr);
  assert.equal(git(trunk, ['rev-parse', 'main']), git(work, ['rev-parse', 'HEAD']), 'main in the checkout is the landed tip');
  assert.equal(readFileSync(join(trunk, 'landed.txt'), 'utf8'), 'landed\n', 'the work tree took the push');
  git(work, ['-c', 'user.name=T', '-c', 'user.email=t@t.invalid', 'commit', '-q', '--allow-empty', '-m', 'next']);
  const stale = withRestrictedSsh(ssh, () => pushTrunk(work, { payload: { checkout: true }, trunk: TRUNK, base, remote }));
  assert.notEqual(stale.status, 0, 'a lease on a tip trunk has moved past is still refused');
});

test('#7952 clause 1: a restricted trunk without updateInstead still refuses, and the plain retry does not mask it [C7]', t => {
  const { trunk, work, ssh, base } = scratch(t, { updateInstead: false });
  const remote = `${userInfo().username}@127.0.0.1:${trunk}`;
  const pushed = withRestrictedSsh(ssh, () => pushTrunk(work, { payload: { checkout: true }, trunk: TRUNK, base, remote }));
  assert.notEqual(pushed.status, 0);
  assert.match(pushed.stderr, /checked out|refusing/u);
});

test('#7952 clause 2: doctor names a checked-out trunk lacking updateInstead with the one git config line, and clears it once set [C7]', t => {
  const { dir, trunk, work } = scratch(t, { updateInstead: false });
  const problem = trunkUpdateInsteadProblem(trunk, work, TRUNK);
  assert.equal(problem.code, 'TRUNK_UPDATEINSTEAD');
  assert.match(problem.next, /^run git -C ".+" config receive\.denyCurrentBranch updateInstead$/u);
  git(trunk, ['config', 'receive.denyCurrentBranch', 'updateInstead']);
  assert.equal(trunkUpdateInsteadProblem(trunk, work, TRUNK), null, 'set, the finding clears');
  const bare = join(dir, 'bare.git');
  git(dir, ['clone', '-q', '--bare', trunk, bare]);
  assert.equal(trunkUpdateInsteadProblem(bare, work, TRUNK), null, 'a bare trunk needs nothing');
  assert.equal(trunkUpdateInsteadProblem(null, work, TRUNK), null, 'no trunk remote, no finding');
});
