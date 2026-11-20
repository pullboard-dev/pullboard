/** @pullboard-test-input source-cell packages/landing */
/** Landing receipts use the earliest first-parent commit, with logarithmic ancestry probes [B3,R3,C7]. */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdirSync } from 'node:fs';
import { mkdtempSync } from 'node:fs';
import { rmSync } from 'node:fs';
import { runFixtureGit } from '../../../../gate/tests/fixtures/child.js';
import { privateFixtureFiles } from '../../../../gate/tests/fixtures/child.js';
import { fixtureMachineSettings } from '../../../../gate/tests/fixtures/testkit.js';
import { cellRepo } from '../../../../store/tests/fixtures/cell.js';
import { cellItem } from '../../../../store/tests/fixtures/cell.js';
import { openCellBoard } from '../../../../store/tests/fixtures/cell.js';
import * as store from '../../../../store/index.js';
import { realGitAdapter } from '../../../../git/index.js';
import { withGitAdapter } from '../../../../git/index.js';
import { loadConfig } from '../../../../config/index.js';
import { mergeGroup } from '../../../src/io/step/merge.js';
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
  mkdirSync(root);
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
  // Count ancestry probes through a counting Git adapter, so no PATH shim is resolved into the process-wide Git binary cache.
  let probes = 0;
  const counting = Object.freeze({
    spawnSync(args, options) { if (args.includes('--is-ancestor')) probes++; return realGitAdapter.spawnSync(args, options); },
    execFileSync(args, options) { if (args.includes('--is-ancestor')) probes++; return realGitAdapter.execFileSync(args, options); },
    spawn: (args, options) => realGitAdapter.spawn(args, options),
  });
  withGitAdapter(counting, () => {
    assert.equal(firstContainingCommit(root, feature), merge, 'a secondary-parent source first appears at its mainline merge');
    assert.equal(firstContainingCommit(root, sourceOnMain), sourceOnMain, 'a source already on trunk keeps its earliest commit');
    assert.equal(firstContainingCommit(root, orphan), undefined, 'a source absent from trunk has no containing commit');
    probes = 0;
    assert.equal(firstContainingCommit(root, feature), merge);
  });
  assert.ok(probes <= 12, `1024 first-parent commits use at most logarithmic probes; got ${probes}`);
});

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


/**
 * Run mergeGroup on a real repository with the settings given. `shape` is how the item commits relate to the trunk the batch builds on:
 * 'descends' (one item whose commit sits on the trunk, so the merge adds nothing), 'diverged' (one item branched before the trunk moved)
 * or 'two' (two items). Returns the group's answer.
 */
async function composedGroup(t, settings, shape, message = null) {
  const repo = cellRepo(t, { real: true });
  const { root: dir } = privateFixtureFiles('pullboard-composed-equality-');
  const board = openCellBoard(`${dir}/board.sqlite`);
  const saved = process.env.PULLBOARD_MACHINE_HOME;
  process.env.PULLBOARD_MACHINE_HOME = `${dir}/machine-home`;
  mkdirSync(process.env.PULLBOARD_MACHINE_HOME, { recursive: true });
  fixtureMachineSettings(process.env.PULLBOARD_MACHINE_HOME, settings);
  const identity = { GIT_AUTHOR_NAME: 'Test Agent', GIT_AUTHOR_EMAIL: 'agent@example.com', GIT_COMMITTER_NAME: 'Test Agent', GIT_COMMITTER_EMAIL: 'agent@example.com' };
  const before = Object.fromEntries(Object.keys(identity).map(key => [key, process.env[key]]));
  Object.assign(process.env, identity);
  t.after(() => {
    store.closeBoard(board);
    rmSync(dir, { recursive: true, force: true });
    if (saved === undefined) delete process.env.PULLBOARD_MACHINE_HOME; else process.env.PULLBOARD_MACHINE_HOME = saved;
    for (const [key, value] of Object.entries(before)) if (value === undefined) delete process.env[key]; else process.env[key] = value;
  });
  const g = (...args) => runFixtureGit(args, { cwd: repo.root }).trim();
  const base = repo.commit;
  const branchOff = (name, file) => { g('checkout', '-q', '--detach', base); repo.put(file, `${name}\n`); return repo.commitAll(); };
  let tips;
  let trunk;
  if (shape === 'descends') {
    // The scan and derive files make the batch ride a runner; a runner that answers nothing leaves the merge to the coordinator.
    repo.put('packages/landing/src/io/scan.js', '// scan\n');
    repo.put('packages/landing/src/io/derive.js', '// derive\n');
    trunk = repo.commitAll();
    repo.put('web/page.txt', 'page\n');
    tips = [repo.commitAll()];
  } else {
    tips = shape === 'two' ? [branchOff('one', 'web/one.txt'), branchOff('two', 'web/two.txt')] : [branchOff('page', 'web/page.txt')];
    if (message) { g('commit', '--amend', '-q', '-m', message); tips = [g('rev-parse', 'HEAD')]; }
    g('checkout', '-q', '--detach', base);
    repo.put('packages/landing/src/io/scan.js', '// scan\n');
    repo.put('packages/landing/src/io/derive.js', '// derive\n');
    trunk = repo.commitAll();
  }
  g('checkout', '-q', '--detach', shape === 'descends' ? trunk : base);
  const items = tips.map((tip, index) => ({ item: cellItem(board, { lane: 'web', title: `Composed equality ${index}`, specIds: ['G1'] }), tip }));
  const batchRoot = `${dir}/batch`;
  g('worktree', 'add', '-q', '--detach', batchRoot, trunk);
  t.after(() => { rmSync(batchRoot, { recursive: true, force: true }); });
  const state = {
    board, config: { ...loadConfig(repo.root), staticChecks: 'true' }, say() {}, onWait() {}, checkLease: async () => {}, root: repo.root,
    guardServices: { runStaticChecks: async () => ({ output: '' }) },
    landingPorts: { badgeCounts: () => ({}), writeBadges: () => [] },
    write: async (_name, [{ batch }]) => batch,
    batch: { id: 'b1', root: batchRoot, base: trunk, external: true, candidates: items.map(({ item, tip }) => ({ id: item.item_id, commit: tip })), items: [], conflicts: [], resolutions: [] },
  };
  const result = await mergeGroup(state, items.map(({ item, tip }) => ({ id: item.item_id, commit: tip })));
  return { result, trunk, base };
}

test('landing.merge.composed-equality-records: clause 1: with landing.composedEquality on, a one-item batch records exactTree.composedEqual true when its staged tree is the submitted commit tree, false when the trees differ or the batch holds two items [C7,U159,#10974]', async t => {
  const equal = await composedGroup(t, { landing: { composedEquality: true } }, 'descends');
  assert.equal(equal.result.exactTree.composedEqual, true);
  assert.match(equal.result.exactTree.tree, /^[a-f0-9]{40,64}$/u);
  const differs = await composedGroup(t, { landing: { composedEquality: true } }, 'diverged');
  assert.equal(differs.result.items.length, 1);
  assert.equal(differs.result.exactTree.composedEqual, false);
  const many = await composedGroup(t, { landing: { composedEquality: true } }, 'two');
  assert.equal(many.result.items.length, 2);
  assert.equal(many.result.exactTree.composedEqual, false);
});

test('landing.merge.composed-equality-off-records-nothing: clause 2: with the setting off, mergeGroup records no composedEqual field, and validateLandingBatch accepts a batch that carries it [C7,U159,#10974]', async t => {
  const off = await composedGroup(t, {}, 'descends');
  assert.equal(off.result.exactTree, undefined);
  const batch = { version: 1, id: 'batch-7', state: 'merging', base: off.trunk, tip: off.base, root: '/tmp/composed', branch: 'refs/heads/main',
    items: [], owner: 'coordinator', logPath: '/dev/null' };
  const tree = 'a'.repeat(40);
  assert.doesNotThrow(() => validateLandingBatch({ ...batch, exactTree: { tree, composedEqual: true } }, 0));
});

test('landing.merge.refuses-own-commit-trailer-or-path: clause 2: a batch whose item commit carries a Co-Authored-By trailer or a home-folder path is refused LAND_HEADER with nothing merged, and a clean item merges [C7,#11265]', async t => {
  for (const message of ['chore: scratch\n\nCo-Authored-By: Fixture Name <fixture@example.test>', 'chore: scratch of /Users/fixture/work/repo']) {
    await assert.rejects(composedGroup(t, {}, 'diverged', message), error => error.code === 'LAND_HEADER' && /nothing merged/u.test(error.message));
  }
  const clean = await composedGroup(t, {}, 'diverged', 'chore: scratch clean');
  assert.equal(clean.result.items.length, 1);
});
