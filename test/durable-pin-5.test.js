/** Durable gate item 5: the pin cell names sources by tree id and keeps bundles keyed by it [C7]. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { privateFixtureFiles, runFixtureGit, runFixtureExecFile } from './fixture-child.js';
import { pinFor, bundleFor, treeOf } from '../packages/pin/index.js';

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
