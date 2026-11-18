/** @pullboard-test-input packages/landing/src/io/prune.js */
/** Local landing cleanup preserves dirty, active and unrelated worktrees [R3,C7]. */
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { existsSync } from 'node:fs';
import { mkdirSync } from 'node:fs';
import { mkdtempSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import { realpathSync } from 'node:fs';
import { rmSync } from 'node:fs';
import { symlinkSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { runFixtureGit } from '../../../gate/tests/fixtures/child.js';
import { startFixtureChild } from '../../../gate/tests/fixtures/child.js';

/** Build an isolated real repository; no live board or user Git settings are used. */
function repository(t) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'pullboard-retention-prune-')));
  const root = join(dir, 'main');
  mkdirSync(root);
  const env = { ...process.env };
  for (const key of Object.keys(env)) if (key.startsWith('GIT_')) delete env[key];
  Object.assign(env, { GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1',
    GIT_AUTHOR_NAME: 'Prune Fixture', GIT_AUTHOR_EMAIL: 'prune@example.test',
    GIT_COMMITTER_NAME: 'Prune Fixture', GIT_COMMITTER_EMAIL: 'prune@example.test' });
  /** Run Git only in this test's private repositories. */
  const git = (cwd, ...args) => runFixtureGit(args, { cwd, env });
  git(root, 'init', '-q', '-b', 'main');
  writeFileSync(join(root, 'kept.txt'), 'committed input\n');
  writeFileSync(join(root, '.gitignore'), 'ignored.txt\n');
  git(root, 'add', '.');
  git(root, 'commit', '-q', '-m', 'fixture: committed input');
  const tip = git(root, 'rev-parse', 'HEAD').trim();
  const children = [];
  t.after(async () => {
    for (const { child, closed } of children) { child.stdin.end(); await closed; }
    rmSync(dir, { recursive: true, force: true });
  });
  /** Give each target a registered linked tree and keep its branch after pruning. */
  const tree = name => {
    const path = join(dir, name);
    git(root, 'worktree', 'add', '-q', '-b', name, path, tip);
    return { agent: name, path, batch: 'private-landed-batch', at: '2026-10-24T00:00:00.000Z',
      items: [{ item: 1, commit: tip, merge: tip }] };
  };
  return { root, dir, env, git, tip, tree, children };
}

/** A missing production helper is an explicit feature assertion, not a fixture import crash. */
async function pruner() {
  assert.ok(existsSync(new URL('../../src/io/prune.js', import.meta.url)),
    'landing must provide its guarded worktree prune helper');
  return import('../../src/io/prune.js');
}

/** Retain the complete local attempt receipt before the private repository is cleaned up. */
function recordReceipt(t, result) {
  const receipt = JSON.parse(readFileSync(result.receipt, 'utf8'));
  t.diagnostic(`prune-receipt: ${JSON.stringify(receipt)}`);
  return receipt;
}

test('landing.prune.a-landing-prunes-only-its-landed: a landing prunes only its landed clean worktree and names dirty and process-cwd trees [R3,C7]', async t => {
  const box = repository(t);
  const clean = box.tree('clean-seat');
  const dirty = box.tree('dirty-seat');
  const busy = box.tree('busy-seat');
  const { pruneRetiredWorktrees } = await pruner();
  writeFileSync(join(dirty.path, 'kept.txt'), 'uncommitted work\n');
  const child = startFixtureChild(process.execPath,
    ['-e', 'process.stdout.write("ready\\n");process.stdin.resume();'],
    { cwd: busy.path, env: box.env, stdio: ['pipe', 'pipe', 'pipe'] });
  const closed = once(child, 'close');
  box.children.push({ child, closed });
  const [ready] = await once(child.stdout, 'data');
  assert.match(String(ready), /ready/u);
  const messages = [];
  const result = await pruneRetiredWorktrees(box.root, { tip: box.tip, targets: [clean, dirty, busy],
    revalidate: () => null, say: line => messages.push(line) });
  const receipt = recordReceipt(t, result);
  assert.equal(existsSync(clean.path), false, 'only the landed clean checkout is removed');
  assert.equal(existsSync(dirty.path), true);
  assert.equal(existsSync(busy.path), true);
  assert.equal(box.git(box.root, 'rev-parse', 'refs/heads/clean-seat').trim(), box.tip, 'the branch and commit survive');
  assert.deepEqual(result.removed.map(entry => entry.path), [clean.path]);
  assert.ok(result.skipped.some(entry => entry.path === dirty.path && /dirty/u.test(entry.reason)));
  assert.ok(result.skipped.some(entry => entry.path === busy.path && /in.use/u.test(entry.reason)));
  assert.ok(messages.some(line => line.includes(dirty.path)));
  assert.ok(messages.some(line => line.includes(busy.path)));
  const busyReceipt = receipt.attempts.find(entry => entry.path === busy.path);
  assert.ok(busyReceipt.pids.includes(child.pid), 'only matching target process ids explain an in-use refusal');
  assert.doesNotMatch(JSON.stringify(receipt), /processes|commandLine|argv/u, 'no global process arguments are retained');
});

test('landing.prune.landing-prune-retains-untracked-ignored-and: landing prune retains untracked ignored and unlanded work without touching foreign paths [R3,C7]', async t => {
  const box = repository(t);
  const { pruneRetiredWorktrees } = await pruner();
  const untracked = box.tree('untracked-seat');
  const ignored = box.tree('ignored-seat');
  const ahead = box.tree('ahead-seat');
  writeFileSync(join(untracked.path, 'new.txt'), 'untracked\n');
  writeFileSync(join(ignored.path, 'ignored.txt'), 'ignored data\n');
  writeFileSync(join(ahead.path, 'next.txt'), 'new committed work\n');
  box.git(ahead.path, 'add', '.');
  box.git(ahead.path, 'commit', '-q', '-m', 'fixture: unlanded work');
  const foreignPath = join(box.dir, 'not-registered');
  mkdirSync(foreignPath);
  const foreign = { ...untracked, agent: 'foreign-seat', path: foreignPath };
  const result = await pruneRetiredWorktrees(box.root, { tip: box.tip,
    targets: [untracked, ignored, ahead, foreign], revalidate: () => null });
  recordReceipt(t, result);
  assert.equal(result.removed.length, 0);
  assert.deepEqual(new Set(result.skipped.map(entry => entry.path)), new Set([untracked.path, ignored.path, ahead.path, foreignPath]));
  for (const target of [untracked, ignored, ahead, foreign]) assert.ok(existsSync(target.path));
  assert.ok(result.skipped.some(entry => entry.path === ahead.path && /landed/u.test(entry.reason)));
});

test('landing.prune.landing-prune-excludes-protected-trees-and: landing prune excludes protected trees and revalidates immediately before removal [R3,C7]', async t => {
  const box = repository(t);
  const { pruneRetiredWorktrees } = await pruner();
  const protectedTree = box.tree('proof-seat');
  const claimed = box.tree('new-claim-seat');
  const ordinary = box.tree('ordinary-seat');
  const calls = [];
  const result = await pruneRetiredWorktrees(box.root, { tip: box.tip,
    targets: [protectedTree, claimed, ordinary], exclude: [protectedTree.path],
    revalidate: target => { calls.push(target.agent); return target.agent === claimed.agent ? 'new live claim' : null; } });
  recordReceipt(t, result);
  assert.deepEqual(calls, [claimed.agent, ordinary.agent]);
  assert.ok(existsSync(protectedTree.path));
  assert.ok(existsSync(claimed.path));
  assert.equal(existsSync(ordinary.path), false);
  assert.ok(result.skipped.some(entry => entry.path === claimed.path && /new live claim/u.test(entry.reason)));
  const unsafe = box.tree('no-callback-seat');
  const missing = await pruneRetiredWorktrees(box.root, { tip: box.tip, targets: [unsafe] });
  recordReceipt(t, missing);
  assert.equal(missing.removed.length, 0);
  assert.ok(existsSync(unsafe.path), 'missing board revalidation never permits deletion');
});

test('landing.prune.process-cwd-census-parsing-refuses-incomplete: process cwd census parsing refuses incomplete or malformed observations [R3,C7]', async () => {
  const { parseWorkingDirectoryCensus } = await pruner();
  assert.equal(parseWorkingDirectoryCensus(''), null, 'empty output is unknown, not an idle machine');
  assert.equal(parseWorkingDirectoryCensus('p12\0fcwd\0'), null, 'missing cwd is unknown');
  assert.equal(parseWorkingDirectoryCensus('pnot-a-pid\0fcwd\0n/fixture/tree\0\n'), null);
  assert.equal(parseWorkingDirectoryCensus('p12\0fcwd\0nrelative-path\0\n'), null);
  const parsed = parseWorkingDirectoryCensus('p12\0fcwd\0n/fixture/tree\0\np34\0fcwd\0n/fixture/elsewhere\0\n');
  assert.deepEqual(parsed, [{ pid: 12, path: '/fixture/tree' }, { pid: 34, path: '/fixture/elsewhere' }]);
});

test('landing.prune.landing-prune-refuses-main-caller-aliases: landing prune refuses main caller aliases and a replaced common directory [R3,C7]', async t => {
  const box = repository(t);
  const foreign = repository(t);
  const { pruneRetiredWorktrees } = await pruner();
  const aliased = box.tree('aliased-seat');
  const alias = join(box.dir, 'worktree-alias');
  symlinkSync(aliased.path, alias, 'dir');
  const changed = box.tree('changed-common-seat');
  writeFileSync(join(changed.path, '.git'), `gitdir: ${join(foreign.root, '.git')}\n`);
  const main = { ...aliased, agent: 'main-is-not-a-finished-seat', path: box.root };
  const result = await pruneRetiredWorktrees(box.root, { tip: box.tip,
    targets: [main, { ...aliased, path: alias }, changed], revalidate: () => null });
  recordReceipt(t, result);
  assert.equal(result.removed.length, 0);
  assert.ok(existsSync(box.root));
  assert.ok(existsSync(aliased.path));
  assert.ok(existsSync(changed.path));
  const caller = box.tree('caller-seat');
  const initialCwd = process.cwd();
  try {
    process.chdir(caller.path);
    const active = await pruneRetiredWorktrees(box.root, { tip: box.tip, targets: [caller], revalidate: () => null });
    recordReceipt(t, active);
    assert.match(active.skipped[0].reason, /caller/u);
    assert.ok(existsSync(caller.path));
  } finally { process.chdir(initialCwd); }
});
