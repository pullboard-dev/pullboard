/** @pullboard-test-input packages/transport/src/io/pull/bundle-port.js */
/** @pullboard-world-pin: clause 2 reads the committed bundle-port.js source to prove it imports no synchronous child. */
/** The tree bundle port serves a tree's tar from async git plumbing, cached by tree id [C7]. */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { rmSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { after } from 'node:test';
import { test } from 'node:test';
import { privateFixtureFiles } from '../../../gate/tests/fixtures/child.js';
import { runFixtureChildAsync } from '../../../gate/tests/fixtures/child.js';
import { makeTreeBundlePort } from '../../index.js';

const root = privateFixtureFiles('pullboard-bundle-port-').root;
after(() => rmSync(root, { recursive: true, force: true }));
const IDENTITY = ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.test', '-c', 'core.hooksPath=/dev/null'];

/** Run git in the fixture repository and return its trimmed output. */
async function git(...args) {
  const run = await runFixtureChildAsync('git', [...IDENTITY, ...args], { cwd: join(root, 'repo') });
  assert.equal(run.failure, null, run.context);
  return run.stdout.trim();
}

/** Make a one-commit repository and return its tree id. */
async function fixtureTree() {
  await runFixtureChildAsync('git', ['init', '-q', '-b', 'main', join(root, 'repo')], { cwd: root });
  writeFileSync(join(root, 'repo', 'file.txt'), 'bundle me\n');
  await git('add', '.');
  await git('commit', '-q', '-m', 'fixture');
  return git('rev-parse', 'HEAD^{tree}');
}

test('clause 1: the port returns the same tar bytes for one tree twice and null for an unknown tree [C7]', async () => {
  const tree = await fixtureTree();
  const port = makeTreeBundlePort(join(root, 'repo'), { dir: join(root, 'tars') });
  const [first, concurrent] = await Promise.all([port(tree), port(tree)]);
  const second = await port(tree);
  assert.equal(first, second);
  assert.equal(first, concurrent);
  assert.deepEqual(readFileSync(first), readFileSync(second));
  assert.ok(readFileSync(first).includes('file.txt'), 'the tar holds the tree\'s file');
  assert.equal(await port('0'.repeat(40)), null);
  assert.equal(await port('not-a-tree'), null);
});

test('clause 2: bundle-port.js reads the repository through async git and imports no synchronous child [C7]', () => {
  const source = readFileSync(new URL('../../src/io/pull/bundle-port.js', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /execFileSync|spawnSync|execSync/u);
  assert.match(source, /\bspawn\b/u);
});
