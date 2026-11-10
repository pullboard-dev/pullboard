/** Private-index patch composition preserves candidate and working-copy isolation [H16,V1]. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import { rmSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { composeItemPatches } from '../../../index.js';
import { itemPatchSetDigest } from '../../../index.js';
import { contributionSignoffProblem } from '../../../../commits/index.js';

/** Run fixture-only Git, without repository hooks or inherited Git routing. */
function command(root, ...args) {
  const env = { ...process.env, GIT_CONFIG_NOSYSTEM: '1' };
  for (const key of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE']) delete env[key];
  return execFileSync('git', ['-c', 'core.hooksPath=/dev/null', ...args], { cwd: root, env, encoding: 'utf8' });
}

/** A real submitted candidate plus an uncommitted patch and unrelated staged state. */
function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'item-patch-compose-test-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  command(root, 'init', '-q');
  command(root, 'config', 'user.name', 'Fixture');
  command(root, 'config', 'user.email', 'fixture@example.invalid');
  writeFileSync(join(root, 'pullboard.json'), JSON.stringify({ maintainers: ['fixture@example.invalid'] }));
  writeFileSync(join(root, 'value.txt'), 'before\n');
  command(root, 'add', '.');
  command(root, 'commit', '-qm', 'Candidate');
  const commit = command(root, 'rev-parse', 'HEAD').trim();
  writeFileSync(join(root, 'value.txt'), 'after\n');
  const patch = command(root, 'diff', '--binary');
  command(root, 'checkout', '--', 'value.txt');
  writeFileSync(join(root, 'unrelated.txt'), 'staged\n');
  command(root, 'add', 'unrelated.txt');
  const record = { key: 'fix', commit, patch, digest: createHash('sha256').update(patch).digest('hex'),
    author: { agentId: 'core-fixture', parentSession: 'parent-fixture', session: 'session-fixture' } };
  return { root, commit, record };
}

test('item patches compose immutable retry-identical commits without touching the live index [H16,V1]', t => {
  const { root, commit, record } = fixture(t);
  const index = readFileSync(join(root, '.git', 'index'));
  const before = command(root, 'status', '--porcelain=v1');
  const result = composeItemPatches(root, { item_commit: commit }, [record], { trunk: commit });
  assert.equal(command(root, 'show', `${result.commit}:value.txt`), 'after\n');
  assert.equal(command(root, 'rev-parse', `${result.commit}^`).trim(), commit);
  assert.equal(command(root, 'rev-parse', 'HEAD').trim(), commit);
  assert.equal(readFileSync(join(root, 'value.txt'), 'utf8'), 'before\n');
  assert.deepEqual(readFileSync(join(root, '.git', 'index')), index);
  assert.equal(command(root, 'status', '--porcelain=v1'), before);
  assert.deepEqual(result.paths, ['value.txt']);
  assert.deepEqual(result.applied, [{ key: 'fix', paths: ['value.txt'] }]);
  assert.equal(result.digest, itemPatchSetDigest(commit, [record]));
  assert.deepEqual(composeItemPatches(root, { item_commit: commit }, [record]), result);
  assert.equal(composeItemPatches(root, { item_commit: commit }, []).commit, commit);
  const author = command(root, 'show', '-s', '--format=%an <%ae>', result.commit).trim();
  const message = command(root, 'show', '-s', '--format=%B', result.commit);
  assert.ok(message.split('\n').includes(`Signed-off-by: ${author}`), 'the composed commit certifies its own actual author');
  assert.deepEqual(contributionSignoffProblem(root, { base: commit, head: result.commit }),
    { checked: 1, problem: null }, 'the real contribution checker accepts the exact composed range');
});

test('item patch tampering, stale binding, conflicts and unsafe paths fail closed [H16,V1]', t => {
  const { root, commit, record } = fixture(t);
  const item = { item_commit: commit };
  const index = readFileSync(join(root, '.git', 'index'));
  const value = readFileSync(join(root, 'value.txt'));
  const status = command(root, 'status', '--porcelain=v1');
  assert.throws(() => composeItemPatches(root, item, [{ ...record, patch: record.patch + '\n' }]), /tampered/);
  assert.throws(() => composeItemPatches(root, item, [{ ...record, commit: '0'.repeat(40) }]), /stale/);
  const conflict = { ...record, key: 'conflict', patch: record.patch.replace('+after', '+different') };
  conflict.digest = createHash('sha256').update(conflict.patch).digest('hex');
  assert.throws(() => composeItemPatches(root, item, [record, conflict]), error => {
    assert.equal(error.code, 'ITEM_PATCH');
    assert.match(error.message, /^\[ITEM_PATCH\] companion conflict no longer applies: file value\.txt; hunk @@ -1 \+1 @@;/u);
    assert.equal(error.message.includes('different'), false, 'the diagnostic does not leak the failed source line');
    return true;
  });
  const unsafe = { ...record, patch: record.patch.replaceAll('value.txt', '../escape') };
  unsafe.digest = createHash('sha256').update(unsafe.patch).digest('hex');
  assert.throws(() => composeItemPatches(root, item, [unsafe]), /unsafe/);
  const symlink = { ...record, patch: 'diff --git a/link b/link\nnew file mode 120000\nindex 0000000..0000000\n--- /dev/null\n+++ b/link\n@@ -0,0 +1 @@\n+target\n' };
  symlink.digest = createHash('sha256').update(symlink.patch).digest('hex');
  assert.throws(() => composeItemPatches(root, item, [symlink]), /regular-file/);
  assert.equal(command(root, 'rev-parse', 'HEAD').trim(), commit);
  assert.deepEqual(readFileSync(join(root, 'value.txt')), value, 'every refused patch preserves live file bytes');
  assert.deepEqual(readFileSync(join(root, '.git', 'index')), index, 'every refused patch preserves the staged index');
  assert.equal(command(root, 'status', '--porcelain=v1'), status);
});

test('a clean retry composition preserves original patch binding and current trunk parent [H16,V1]', t => {
  const { root, commit, record } = fixture(t);
  command(root, 'commit', '-qm', 'Unrelated clean retry composition');
  const baseCommit = command(root, 'rev-parse', 'HEAD').trim();
  const result = composeItemPatches(root, { item_commit: commit }, [record], { baseCommit, trunk: baseCommit });
  assert.equal(command(root, 'rev-parse', `${result.commit}^`).trim(), baseCommit);
  assert.equal(command(root, 'show', `${result.commit}:unrelated.txt`), 'staged\n');
  assert.equal(command(root, 'show', `${result.commit}:value.txt`), 'after\n');
  assert.equal(composeItemPatches(root, { item_commit: commit }, [], { baseCommit }).commit, baseCommit);
  assert.throws(() => composeItemPatches(root, { item_commit: baseCommit }, [{ ...record, commit: baseCommit }], { baseCommit: commit }), /refused by Git/);
});
