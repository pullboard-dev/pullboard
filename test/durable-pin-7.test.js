/** Durable gate item 7: temp folders are caches named by tree id, rebuilt from the bundle, and a sweep never breaks a queued job [C7]. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { privateFixtureFiles, runFixtureGit } from './fixture-child.js';
import { pinFor, cachePath, cacheFor, sweepCaches } from '../packages/pin/index.js';

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
