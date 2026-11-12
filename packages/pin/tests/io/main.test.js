/** Durable gate item 5: the pin cell names sources by tree id and keeps bundles keyed by it [C7]. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import { statSync } from 'node:fs';
import { join } from 'node:path';
import { privateFixtureFiles } from '../../../../apps/cli/tests/fixtures/child.js';
import { runFixtureGit } from '../../../../apps/cli/tests/fixtures/child.js';
import { runFixtureExecFile } from '../../../../apps/cli/tests/fixtures/child.js';
import { pinFor } from '../../index.js';
import { bundleFor } from '../../index.js';
import { treeOf } from '../../index.js';
import { writeToolingPin } from '../../index.js';
import { toolingPin } from '../../index.js';
import { toolingFor } from '../../index.js';
import { rmSync } from 'node:fs';
import { cachePath } from '../../index.js';
import { cacheFor } from '../../index.js';
import { sweepCaches } from '../../index.js';

/** Build a throwaway repository with two commits and return the repo path and both commit ids. */
function repoWithTwoCommits() {
  const files = privateFixtureFiles('pullboard-pin-');
  const repo = files.root;
  const setup = ['init', '-q'];
  runFixtureGit(['-C', repo, ...setup]);
  runFixtureGit(['-C', repo, 'config', 'user.email', 'pin@example.test']);
  runFixtureGit(['-C', repo, 'config', 'user.name', 'Pin Test']);
  files.write('a.txt', 'one\n');
  runFixtureGit(['-C', repo, 'add', '-A']);
  runFixtureGit(['-C', repo, 'commit', '-q', '-m', 'first']);
  const first = runFixtureGit(['-C', repo, 'rev-parse', 'HEAD']);
  files.write('a.txt', 'two\n');
  runFixtureGit(['-C', repo, 'commit', '-q', '-am', 'second']);
  const second = runFixtureGit(['-C', repo, 'rev-parse', 'HEAD']);
  runFixtureGit(['-C', repo, 'commit', '-q', '--allow-empty', '-m', 'third']);
  const third = runFixtureGit(['-C', repo, 'rev-parse', 'HEAD']);
  return { repo, first, second, third };
}

test('clause 1: pinFor(commit) returns {tree, tooling} and bundleFor(tree) writes a bundle keyed by tree id, reused when present [C7]', () => {
  const { repo, first, second, third } = repoWithTwoCommits();
  const pin = pinFor(repo, second);
  assert.equal(pin.tree, runFixtureGit(['-C', repo, 'rev-parse', `${second}^{tree}`]));
  assert.equal(pin.tooling, pin.tree, 'with no landing pin the tooling is the commit tree');
  assert.equal(pinFor(repo, third).tree, pin.tree, 'an empty commit keeps the tree id');
  assert.notEqual(pinFor(repo, first).tree, pin.tree);
  assert.equal(pinFor(repo, second, { tooling: pinFor(repo, first).tree }).tooling, pinFor(repo, first).tree);
  assert.equal(treeOf(repo, second), pin.tree);

  const bundles = privateFixtureFiles('pullboard-pin-bundles-').root;
  const made = bundleFor(repo, pin.tree, bundles);
  assert.equal(made.reused, false);
  assert.equal(made.path, join(bundles, `${pin.tree}.tar`));
  assert.ok(statSync(made.path).size > 0);
  const listing = runFixtureExecFile('tar', ['-tf', made.path], { encoding: 'utf8' });
  assert.match(listing, /a\.txt/u);

  const before = readFileSync(made.path);
  const again = bundleFor(repo, pin.tree, bundles);
  assert.equal(again.reused, true);
  assert.deepEqual(readFileSync(again.path), before);
  const same = bundleFor(repo, pinFor(repo, third).tree, bundles);
  assert.equal(same.path, made.path, 'two commits with one tree share one bundle');
  assert.equal(existsSync(`${made.path}.${process.pid}.partial`), false);
});

test('clause 1: a bad tree id or unknown commit is refused with a code [C7]', () => {
  const { repo } = repoWithTwoCommits();
  const bundles = privateFixtureFiles('pullboard-pin-bad-').root;
  assert.throws(() => bundleFor(repo, '../escape', bundles), { code: 'PIN_TREE_INVALID' });
  assert.throws(() => pinFor(repo, 'no-such-commit'), { code: 'PIN_COMMIT_UNKNOWN' });
  assert.throws(() => pinFor(repo, 'HEAD', { tooling: 'abc' }), { code: 'PIN_TOOLING_INVALID' });
});

/** Build a repo with an old commit and a newer landed commit with different trees. */
function repoWithOldAndNew() {
  const files = privateFixtureFiles('pullboard-pin6-');
  const repo = files.root;
  const setup = ['init', '-q'];
  runFixtureGit(['-C', repo, ...setup]);
  runFixtureGit(['-C', repo, 'config', 'user.email', 'pin@example.test']);
  runFixtureGit(['-C', repo, 'config', 'user.name', 'Pin Test']);
  files.write('tool.txt', 'old tooling\n');
  runFixtureGit(['-C', repo, 'add', '-A']);
  runFixtureGit(['-C', repo, 'commit', '-q', '-m', 'old']);
  const old = runFixtureGit(['-C', repo, 'rev-parse', 'HEAD']);
  files.write('tool.txt', 'main tooling\n');
  runFixtureGit(['-C', repo, 'commit', '-q', '-am', 'landed']);
  const landed = runFixtureGit(['-C', repo, 'rev-parse', 'HEAD']);
  return { repo, old, landed };
}

test('clause 1: packages/pin writes the tooling pin for a landed commit, and toolingFor returns the last landing tree as tooling and the seat own tree as source [C7]', () => {
  const { repo, old, landed } = repoWithOldAndNew();
  assert.equal(toolingPin(repo), null, 'no landing yet, no pin');
  assert.equal(toolingFor(repo, old).tooling, treeOf(repo, old), 'without a pin the seat runs its own tree');
  assert.equal(toolingFor(repo, old).pinned, false);

  const written = writeToolingPin(repo, landed);
  assert.equal(written.tree, treeOf(repo, landed));
  assert.deepEqual(toolingPin(repo), written);
  assert.deepEqual(writeToolingPin(repo, landed), written, 'repeating the landing write changes nothing');

  const seat = toolingFor(repo, old);
  assert.equal(seat.tree, treeOf(repo, old), 'the source stays the seat tree');
  assert.equal(seat.tooling, treeOf(repo, landed), 'the tooling is the last landing tree');
  assert.equal(seat.pinned, true);
});

test('clause 1: a corrupt tooling pin is refused with a code and an unknown landing writes nothing [C7]', () => {
  const { repo } = repoWithOldAndNew();
  assert.throws(() => writeToolingPin(repo, 'no-such-commit'), { code: 'PIN_COMMIT_UNKNOWN' });
  assert.equal(toolingPin(repo), null);
});

/** Build a repo with one commit and return its path and tree id. */
function repoWithTree() {
  const files = privateFixtureFiles('pullboard-pin7-');
  const repo = files.root;
  const setup = ['init', '-q'];
  runFixtureGit(['-C', repo, ...setup]);
  runFixtureGit(['-C', repo, 'config', 'user.email', 'pin@example.test']);
  runFixtureGit(['-C', repo, 'config', 'user.name', 'Pin Test']);
  files.write('src.txt', 'source\n');
  runFixtureGit(['-C', repo, 'add', '-A']);
  runFixtureGit(['-C', repo, 'commit', '-q', '-m', 'one']);
  return { repo, tree: pinFor(repo, 'HEAD').tree };
}

test('clause 1: temp folders are caches named by tree id and a missing cache is rebuilt from the bundle [C7]', () => {
  const { repo, tree } = repoWithTree();
  const where = { cacheRoot: privateFixtureFiles('pullboard-pin7-cache-').root, bundles: privateFixtureFiles('pullboard-pin7-bundles-').root };
  const first = cacheFor(repo, tree, where);
  assert.equal(first.path, cachePath(where.cacheRoot, tree));
  assert.equal(first.rebuilt, true);
  assert.equal(readFileSync(join(first.path, 'src.txt'), 'utf8'), 'source\n');
  assert.equal(cacheFor(repo, tree, where).rebuilt, false, 'a present cache is reused');
  rmSync(first.path, { recursive: true });
  const again = cacheFor(repo, tree, where);
  assert.equal(again.rebuilt, true);
  assert.equal(readFileSync(join(again.path, 'src.txt'), 'utf8'), 'source\n');
  assert.equal(existsSync(`${again.path}.${process.pid}.partial`), false);
});

test('clause 1: a sweep never breaks a queued job, it keeps named trees and the next read rebuilds the rest [C7]', () => {
  const { repo, tree } = repoWithTree();
  const where = { cacheRoot: privateFixtureFiles('pullboard-pin7-cache-').root, bundles: privateFixtureFiles('pullboard-pin7-bundles-').root };
  const { path } = cacheFor(repo, tree, where);
  assert.deepEqual(sweepCaches(where.cacheRoot, { keep: [tree] }), [], 'a queued job tree is kept');
  assert.equal(existsSync(path), true);
  assert.deepEqual(sweepCaches(where.cacheRoot, { maxAgeMs: 60_000 }), [], 'a recent cache survives an age sweep');
  assert.deepEqual(sweepCaches(where.cacheRoot), [tree], 'an unreferenced cache is swept');
  assert.equal(existsSync(path), false);
  assert.equal(cacheFor(repo, tree, where).rebuilt, true, 'the queued job still gets its tree');
  assert.throws(() => cachePath(where.cacheRoot, '../x'), { code: 'PIN_TREE_INVALID' });
});
