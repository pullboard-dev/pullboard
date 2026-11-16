/** With gate.namedImportSelection on, a change behind a re-exporting door selects only the tests that take one of its names [C7,V4]. */
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { rmSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { join } from 'node:path';
import { test } from 'node:test';
import { privateFixtureFiles } from '../../fixtures/child.js';
import { runFixtureGit } from '../../fixtures/child.js';
import { selectAffectedTests } from '../../../index.js';

/** Every test that imports the door or the changed module, one per import shape, plus one unrelated test. */
const TESTS = {
  'test/named-changed.test.js': "import { a } from '../src/door.js';\n",
  'test/renamed-changed.test.js': "import { bee as b } from '../src/door.js';\n",
  'test/named-other.test.js': "import { c } from '../src/door.js';\n",
  'test/outer-changed.test.js': "import { bee } from '../src/outer.js';\n",
  'test/outer-other.test.js': "import { c } from '../src/outer.js';\n",
  'test/direct.test.js': "import { b } from '../src/changed.js';\n",
  'test/namespace.test.js': "import * as door from '../src/door.js';\nvoid door;\n",
  'test/star.test.js': "import { c } from '../src/star.js';\n",
  'test/default.test.js': "import door from '../src/door.js';\nvoid door;\n",
  'test/dynamic.test.js': "await import('../src/door.js');\n",
  'test/bare.test.js': "import '../src/door.js';\n",
  'test/unrelated.test.js': "import 'node:fs';\n",
};

/** A real Git repository: a door re-exporting a changed module and an unchanged one, a second door and a star door. */
function repository(t) {
  const root = privateFixtureFiles('pullboard-affected-named-').root;
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const env = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1',
    GIT_AUTHOR_NAME: 'Test Agent', GIT_AUTHOR_EMAIL: 'agent@example.com',
    GIT_COMMITTER_NAME: 'Test Agent', GIT_COMMITTER_EMAIL: 'agent@example.com' };
  const run = (...args) => runFixtureGit(args, { cwd: root, env });
  const put = (path, source) => { mkdirSync(dirname(join(root, path)), { recursive: true }); writeFileSync(join(root, path), source); };
  run('init', '-q', '-b', 'main');
  put('package.json', '{"type":"module"}\n');
  put('src/changed.js', 'export const a = 1;\nexport const b = 2;\n');
  put('src/other.js', 'export const c = 3;\nexport default 4;\n');
  put('src/door.js', "export { a, b as bee } from './changed.js';\nexport { c, default } from './other.js';\n");
  put('src/outer.js', "export { bee, c } from './door.js';\n");
  put('src/star.js', "export * from './door.js';\n");
  for (const [path, source] of Object.entries(TESTS)) put(path, source);
  run('add', '-A'); run('commit', '-qm', 'chore: fixture');
  return { root, base: run('rev-parse', 'HEAD').trim() };
}

test('clause 1: with gate.namedImportSelection on, a change behind a door selects the tests that take its names and the direct importers [C7,V4]', t => {
  const { root, base } = repository(t);
  const on = selectAffectedTests(root, { base, commit: base, changed: ['src/changed.js'], namedImports: true });
  assert.equal(on.full, false, on.reason);
  for (const path of ['test/named-changed.test.js', 'test/renamed-changed.test.js', 'test/outer-changed.test.js', 'test/direct.test.js']) {
    assert.ok(on.files.includes(path), `${path} takes a name the changed module exports`);
  }
  for (const path of ['test/named-other.test.js', 'test/outer-other.test.js', 'test/unrelated.test.js']) {
    assert.ok(!on.files.includes(path), `${path} takes only names from an unchanged module`);
  }
  assert.equal(on.reasons['test/outer-changed.test.js'], 'src/changed.js -> src/door.js -> src/outer.js -> test/outer-changed.test.js');
});

test('clause 2: star, namespace, default, dynamic and bare imports of the door are still selected, and off selects as before [C7,V4]', t => {
  const { root, base } = repository(t);
  const on = selectAffectedTests(root, { base, commit: base, changed: ['src/changed.js'], namedImports: true });
  for (const path of ['test/namespace.test.js', 'test/star.test.js', 'test/default.test.js', 'test/dynamic.test.js', 'test/bare.test.js']) {
    assert.ok(on.files.includes(path), `${path} takes the whole door`);
  }
  const off = selectAffectedTests(root, { base, commit: base, changed: ['src/changed.js'], namedImports: false });
  assert.equal(off.full, false, off.reason);
  assert.deepEqual(off.files, Object.keys(TESTS).filter(path => path !== 'test/unrelated.test.js').sort(),
    'off, every test that reaches the door is selected, whatever name it takes');
  assert.equal(off.reasons['test/named-other.test.js'], 'src/changed.js -> src/door.js -> test/named-other.test.js');
  // Changing the door itself, or the unchanged module behind it, reaches the same tests either way.
  for (const changed of [['src/door.js'], ['src/other.js']]) {
    const named = selectAffectedTests(root, { base, commit: base, changed, namedImports: true });
    const plain = selectAffectedTests(root, { base, commit: base, changed, namedImports: false });
    if (changed[0] === 'src/door.js') assert.deepEqual(named.files, plain.files);
    else assert.ok(!named.files.includes('test/named-changed.test.js') && named.files.includes('test/named-other.test.js'));
  }
});
