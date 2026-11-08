/** Durable gate item 6: the last landing writes the tooling pin and workers read it, not the seat's checkout [C7]. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { privateFixtureFiles, runFixtureGit } from './fixture-child.js';
import { writeToolingPin, toolingPin, toolingFor, treeOf } from '../packages/pin/index.js';

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
