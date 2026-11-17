/** @pullboard-test-input packages/gate/src/io/test/freeze.js packages/gate/src/io/test/freeze/paths.js */
/** The freeze rewrites a moved test's path math when its target still resolves, and its dry run refuses the move naming file and line otherwise [C7]. */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { rmSync } from 'node:fs';
import { test } from 'node:test';
import { runFreezeCommand } from '../../../src/io/test/freeze.js';
import { privateFixtureFiles } from '../../fixtures/child.js';
import { runFixtureGit } from '../../fixtures/child.js';

const GOOD = 'apps/cli/journeys/add/good.test.js';
const BAD = 'apps/cli/journeys/add/bad.test.js';
const row = file => ({ file, kind: 'journey', specs: ['A1'], tag: 'keep', tagBecause: 'golden' });
const owner = () => 'packages/math';

/** A private Git repository holding two journeys that read a fixture by path math; nothing here touches the real repo. */
function fixture(t) {
  const files = privateFixtureFiles('pullboard-freeze-paths-');
  t.after(() => rmSync(files.root, { recursive: true, force: true }));
  const sources = {
    'package.json': '{"type":"module"}',
    'packages/math/tests/registry.json': JSON.stringify({ A1: {} }),
    'apps/cli/tests/fixtures/data.json': '{}',
    [GOOD]: "test('A1: reads', () => { new URL('../../tests/fixtures/data.json', import.meta.url); });\n",
    [BAD]: "const x = 1;\ntest('A1: reads', () => { new URL('./not-there.json', import.meta.url); });\n",
    'packages/gate/data/tests/test-manifest.json': JSON.stringify({ version: 1, files: [row(GOOD), row(BAD)] }),
  };
  for (const [file, source] of Object.entries(sources)) files.write(file, source);
  const sh = (...args) => runFixtureGit(args, { cwd: files.root });
  sh('init', '-q');
  sh('add', '-A');
  sh('-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', 'base');
  return files;
}

test('gate.io-test-freeze-paths.the-dry-run-names-the-file: the dry run names the file and line of path math that cannot be rewritten, and plans the rest [C7]', t => {
  const repo = fixture(t);
  const { status, stdout } = runFreezeCommand(['--dry-run', repo.root], { owner });
  assert.equal(status, 0);
  assert.match(stdout, /would move: apps\/cli\/journeys\/add\/good\.test\.js -> packages\/math\/tests\/journeys\/add\/good\.test\.js/u);
  assert.match(stdout, /would refused: apps\/cli\/journeys\/add\/bad\.test\.js \(.*apps\/cli\/journeys\/add\/bad\.test\.js:2 /u);
  assert.match(stdout, /dry run: 0 delete, 1 move, 0 convert, 0 in place, 1 refused\n$/u);
});

test('gate.io-test-freeze-paths.a-moved-test-whose-new-url: a moved test whose new URL target resolves has that path rewritten [C7]', t => {
  const repo = fixture(t);
  const { status, stderr } = runFreezeCommand([repo.root], { owner });
  assert.equal(status, 0, stderr);
  assert.match(readFileSync(`${repo.root}/packages/math/tests/journeys/add/good.test.js`, 'utf8'), /new URL\('\.\.\/\.\.\/\.\.\/\.\.\/\.\.\/apps\/cli\/tests\/fixtures\/data\.json', import\.meta\.url\)/u);
  assert.match(readFileSync(`${repo.root}/${BAD}`, 'utf8'), /not-there\.json/u, 'a refused file stays where it was');
});
