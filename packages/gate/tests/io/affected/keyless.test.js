/** @pullboard-world-pin: clause 1 reads this repo's own import graph to prove the hook path keeps every closure key. */
/** A test closure keeps its key: the hook loads declared modules, and a new unreadable import is refused (#5840) [C7]. */
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { runFixtureGit } from '../../fixtures/child.js';
import { temporaryRepository } from '../../../../store/tests/fixtures/submit.js';
import { keylessRows } from '../../../index.js';
import { testClosures } from '../../../index.js';
import { STATIC_TREE_CHECKS } from '../../../src/io/static/registry.js';

const ROOT = fileURLToPath(new URL('../../../../..', import.meta.url));

/** A real repository whose main has a test reaching src/mid.js -> src/leaf.js, with a candidate branch checked out. */
function repository(t) {
  const root = temporaryRepository(t, 'pullboard-keyless-');
  const git = (...args) => runFixtureGit(['-c', 'user.name=t', '-c', 'user.email=t@example.com', ...args], { cwd: root });
  const put = (path, source) => { mkdirSync(dirname(join(root, path)), { recursive: true }); writeFileSync(join(root, path), source); };
  put('package.json', '{"type":"module"}\n');
  put('src/leaf.js', 'export const leaf = 1;\n');
  put('src/plugin.js', 'export const plugin = 2;\n');
  put('src/mid.js', "export { leaf } from './leaf.js';\n");
  put('test/chain.test.js', "import '../src/mid.js';\n");
  git('add', '-A'); git('commit', '-qm', 'chore: fixture');
  git('checkout', '-qb', 'candidate');
  return { root, put, commit: () => { git('add', '-A'); git('commit', '-qm', 'candidate'); } };
}

test('gate.io-affected-keyless.testclosures-at-this-tree-gives-apps: clause 1: testClosures at this tree gives apps/cli/tests/io/commands/flow.test.js a non-null closure through the hook [C7]', () => {
  const { closures } = testClosures(ROOT, 'HEAD');
  const flow = closures.get('apps/cli/tests/io/commands/flow.test.js');
  assert.ok(flow?.files, `flow.test.js has a closure key: ${flow?.reason}`);
  assert.ok(flow.files.includes('apps/cli/src/io/hook/static.js'), 'the closure passes through the hook static loader');
  assert.ok(flow.files.includes('packages/gate/src/io/changed/scripts/static.js'), 'and holds the module the hook declares it loads');
});

test('gate.io-affected-keyless.adding-a-non-literal-import-to: clause 2: adding a non-literal import() to a source file a test reaches is refused, naming the file [C7]', t => {
  const box = repository(t);
  box.put('src/leaf.js', "const name = './plugin.js';\nexport const leaf = await import(name);\n");
  box.commit();
  const rows = keylessRows(box.root);
  assert.equal(rows.length, 1, rows.join('\n'));
  assert.match(rows[0], /^keyless:src\/leaf\.js: non-literal dynamic import, reached by 1 test file\(s\), which main [0-9a-f]{12} could read; next: /u);
  const check = STATIC_TREE_CHECKS.find(row => row.name === 'keyless');
  assert.deepEqual(check.run(box.root, []), rows, 'the gate static stage runs the same ratchet');
});

test('gate.io-affected-keyless.a-computed-import-that-declares-its: clause 2: a computed import that declares its loads, or one no test reaches, is not refused [C7]', t => {
  const box = repository(t);
  box.put('src/leaf.js', "/** @pullboard-module-loads src/plugin.js */\nconst name = './plugin.js';\nexport const leaf = await import(name);\n");
  box.put('src/orphan.js', "const name = './plugin.js';\nexport const orphan = await import(name);\n");
  box.commit();
  assert.deepEqual(keylessRows(box.root), []);
});
