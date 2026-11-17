/** @pullboard-test-input source-cell packages/landing */
/** Landing receipts use the earliest first-parent commit, with logarithmic ancestry probes [B3,R3,C7]. */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync } from 'node:fs';
import { existsSync } from 'node:fs';
import { mkdirSync } from 'node:fs';
import { mkdtempSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import { rmSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { delimiter } from 'node:path';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { test } from 'node:test';
import { firstContainingCommit } from '../../../src/io/step/merge.js';
import { save } from '../../../src/io/step/merge.js';
import { validateLandingBatch } from '../../../../items/index.js';
import { fixture } from '../../fixtures/plan.js';
import { git as planGit } from '../../fixtures/plan.js';

/** Locate the actual Git executable before installing the fixture's counting shim. */
function realGitPath() {
  const found = process.env.PATH.split(delimiter).map(folder => join(folder || '.', 'git')).find(existsSync);
  assert.ok(found, 'Git is available to build a real history fixture');
  return found;
}

/** Run one Git command while constructing the private graph, outside the measured query. */
function git(realGit, cwd, args, options = {}) {
  const result = spawnSync(realGit, args, { cwd, encoding: 'utf8', ...options });
  assert.equal(result.status, 0, `${args.join(' ')}\n${result.stdout}\n${result.stderr}`);
  return result.stdout.trim();
}

/** Add one fast-import commit, optionally rooted at a previous mark and merging another mark. */
function importedCommit(ref, mark, parent, message, merge, contents) {
  return `commit ${ref}\nmark :${mark}\ncommitter Fixture <fixture@example.test> 1700000000 +0000\ndata ${message.length}\n${message}\n` +
    `${parent ? `from :${parent}\n` : ''}${merge ? `merge :${merge}\n` : ''}M 100644 inline history.txt\ndata ${contents.length}\n${contents}\n`;
}

test('landing.merge.first-containing-commit-is-exact-across: first containing commit is exact across trunk, merge and absent sources with logarithmic probes [B3,R3,C7]', t => {
  const dir = mkdtempSync(join(tmpdir(), 'pullboard-landing-attribution-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const root = join(dir, 'repo');
  const shims = join(dir, 'shims');
  const calls = join(dir, 'ancestry-calls.log');
  mkdirSync(root);
  mkdirSync(shims);
  const realGit = realGitPath();
  const env = { ...process.env, GIT_AUTHOR_NAME: 'Fixture', GIT_AUTHOR_EMAIL: 'fixture@example.test',
    GIT_COMMITTER_NAME: 'Fixture', GIT_COMMITTER_EMAIL: 'fixture@example.test' };
  git(realGit, root, ['init', '-q', '-b', 'main'], { env });
  let input = '';
  input += importedCommit('refs/heads/main', 1, null, 'main root', null, '0');
  for (let mark = 2; mark <= 256; mark++) input += importedCommit('refs/heads/main', mark, mark - 1, `main ${mark}`, null, String(mark));
  input += importedCommit('refs/heads/feature', 257, 128, 'feature source', null, 'feature');
  let mainTip = 256;
  for (let mark = 258; mark <= 768; mark++) {
    input += importedCommit('refs/heads/main', mark, mainTip, `main ${mark}`, null, String(mark));
    mainTip = mark;
  }
  input += importedCommit('refs/heads/main', 769, 768, 'merge feature', 257, 'merged');
  for (let mark = 770; mark <= 1024; mark++) input += importedCommit('refs/heads/main', mark, mark - 1, `main ${mark}`, null, String(mark));
  input += importedCommit('refs/heads/orphan', 1025, null, 'absent source', null, 'orphan');
  git(realGit, root, ['fast-import', '--quiet'], { env, input });

  const chain = git(realGit, root, ['rev-list', '--first-parent', '--reverse', 'refs/heads/main']).split('\n');
  const merge = chain[767];
  const sourceOnMain = chain[127];
  const feature = git(realGit, root, ['rev-parse', 'refs/heads/feature']);
  const orphan = git(realGit, root, ['rev-parse', 'refs/heads/orphan']);
  const shim = join(shims, 'git');
  writeFileSync(shim, '#!/bin/sh\ncase "$*" in *"merge-base --is-ancestor"*) printf "probe\\n" >> "$PULLBOARD_ANCESTRY_CALLS";; esac\nexec "$PULLBOARD_REAL_GIT" "$@"\n');
  chmodSync(shim, 0o700);
  const oldPath = process.env.PATH;
  const oldRealGit = process.env.PULLBOARD_REAL_GIT;
  const oldCalls = process.env.PULLBOARD_ANCESTRY_CALLS;
  process.env.PATH = `${shims}${delimiter}${oldPath}`;
  process.env.PULLBOARD_REAL_GIT = realGit;
  process.env.PULLBOARD_ANCESTRY_CALLS = calls;
  try {
    assert.equal(firstContainingCommit(root, feature), merge, 'a secondary-parent source first appears at its mainline merge');
    assert.equal(firstContainingCommit(root, sourceOnMain), sourceOnMain, 'a source already on trunk keeps its earliest commit');
    assert.equal(firstContainingCommit(root, orphan), undefined, 'a source absent from trunk has no containing commit');
    writeFileSync(calls, '');
    assert.equal(firstContainingCommit(root, feature), merge);
    const probes = readFileSync(calls, 'utf8').trim().split('\n').filter(Boolean).length;
    assert.ok(probes <= 12, `1024 first-parent commits use at most logarithmic probes; got ${probes}`);
  } finally {
    process.env.PATH = oldPath;
    if (oldRealGit === undefined) delete process.env.PULLBOARD_REAL_GIT; else process.env.PULLBOARD_REAL_GIT = oldRealGit;
    if (oldCalls === undefined) delete process.env.PULLBOARD_ANCESTRY_CALLS; else process.env.PULLBOARD_ANCESTRY_CALLS = oldCalls;
  }
});

{
  /** A real repository with a base commit and an item commit on top; each commit's tree differs. */
  function repository(t) {
    const { root, put } = fixture(t);
    put('web/item.txt', 'base\n');
    planGit(root, 'add', '-A');
    planGit(root, 'commit', '-q', '-m', 'chore: base');
    const base = planGit(root, 'rev-parse', 'HEAD').trim();
    put('web/item.txt', 'item 7\n');
    planGit(root, 'add', '-A');
    planGit(root, 'commit', '-q', '-m', 'feat: item 7');
    const tip = planGit(root, 'rev-parse', 'HEAD').trim();
    const treeOf = commit => planGit(root, 'rev-parse', `${commit}^{tree}`).trim();
    return { root, base, tip, treeOf };
  }

  /** A landing state whose board write validates the batch as the store does and records it as the next revision. */
  function landingState(root, base) {
    const batch = { version: 1, id: 'batch-7', state: 'merging', base, tip: base, root, branch: 'refs/heads/main',
      items: [], owner: 'coordinator', logPath: '/dev/null', conflicts: [], resolutions: [], revision: 0 };
    const writes = [];
    const write = async (name, [{ batch: next, revision }]) => {
      assert.equal(name, 'recordLandingBatch');
      validateLandingBatch(next, revision);
      writes.push(next);
      return { ...next, revision: revision + 1 };
    };
    return { state: { batch, write }, writes };
  }

  test('landing.exact.record-carries-the-tip-tree: clause 1: every landing batch revision carries exactTree.tree, the tree id of its tip, and follows the tip when it moves [V16]', async t => {
    const { root, base, tip, treeOf } = repository(t);
    const { state, writes } = landingState(root, base);
    await save(state, { state: 'merging' });
    assert.equal(state.batch.exactTree.tree, treeOf(base), 'the first revision names the tree of the tip it holds');
    await save(state, { state: 'gating', tip });
    assert.equal(state.batch.exactTree.tree, treeOf(tip), 'a revision on a new tip names that tip\'s tree, the tree main will point to');
    assert.notEqual(treeOf(tip), treeOf(base));
    await save(state, { state: 'ready' });
    assert.equal(state.batch.exactTree.tree, treeOf(tip), 'a later revision on the same tip keeps the same tree id');
    assert.ok(writes.every(batch => /^[a-f0-9]{40,64}$/u.test(batch.exactTree?.tree ?? '')), 'every recorded revision carries a full tree id');
  });

  test('landing.exact.record-refuses-a-malformed-tree: clause 2: validateLandingBatch refuses LAND_BATCH for an exact-tree record without a full tree id, and a batch with no record still validates [V16]', t => {
    const { root, base, treeOf } = repository(t);
    const batch = { version: 1, id: 'batch-7', state: 'merging', base, tip: base, root, branch: 'refs/heads/main',
      items: [], owner: 'coordinator', logPath: '/dev/null' };
    assert.doesNotThrow(() => validateLandingBatch(batch, 0), 'a batch recorded before the exact-tree record existed still validates');
    assert.doesNotThrow(() => validateLandingBatch({ ...batch, exactTree: { tree: treeOf(base) } }, 0));
    for (const exactTree of [{ tree: treeOf(base).slice(0, 12) }, { tree: 'HEAD' }, {}, null, 'tree']) {
      assert.throws(() => validateLandingBatch({ ...batch, exactTree }, 0), error => error.code === 'LAND_BATCH', JSON.stringify(exactTree));
    }
  });
}
