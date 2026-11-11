/** Every selected test carries the reason it joined; a change with no code selects no opaque-loader roots [C7,V4]. */
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { rmSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { join } from 'node:path';
import { test } from 'node:test';
import { privateFixtureFiles } from '../../../../../apps/cli/tests/fixtures/child.js';
import { runFixtureGit } from '../../../../../apps/cli/tests/fixtures/child.js';
import { selectAffectedTests } from '../../../index.js';
import { selectionFanOut } from '../../../src/io/affected/fanout.js';

/** A real Git repository: a chain test -> mid -> leaf, an unrelated test, a doc reader and an opaque loader test. */
function repository(t) {
  const root = privateFixtureFiles('pullboard-affected-reasons-').root;
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const env = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1',
    GIT_AUTHOR_NAME: 'Test Agent', GIT_AUTHOR_EMAIL: 'agent@example.com',
    GIT_COMMITTER_NAME: 'Test Agent', GIT_COMMITTER_EMAIL: 'agent@example.com' };
  const run = (...args) => runFixtureGit(args, { cwd: root, env });
  const put = (path, source) => { mkdirSync(dirname(join(root, path)), { recursive: true }); writeFileSync(join(root, path), source); };
  run('init', '-q', '-b', 'main');
  put('package.json', '{"type":"module"}\n');
  put('src/leaf.js', 'export const leaf = 1;\n');
  put('src/mid.js', "export { leaf } from './leaf.js';\n");
  put('test/chain.test.js', "import '../src/mid.js';\n");
  put('test/other.test.js', "import 'node:fs';\n");
  put('test/opaque.test.js', "const name = './x.js';\nawait import(name).catch(() => {});\n");
  put('test/docs.test.js', "import { readFileSync } from 'node:fs'; readFileSync(new URL('../d\\x6fcs/one.md', import.meta.url));\n");
  put('docs/one.md', '# One\n');
  run('add', '-A'); run('commit', '-qm', 'chore: fixture');
  return { root, base: run('rev-parse', 'HEAD').trim() };
}

test('a selected test names the changed file and the import chain that reached it [C7,V4]', t => {
  const { root, base } = repository(t);
  const selection = selectAffectedTests(root, { base, commit: base, changed: ['src/leaf.js'] });
  assert.equal(selection.full, false);
  assert.equal(selection.reasons['test/chain.test.js'], 'src/leaf.js -> src/mid.js -> test/chain.test.js');
  assert.match(selection.reasons['test/opaque.test.js'], /^unresolved closure: /u, 'a forced-in closure says so');
  assert.equal(selection.reasons['test/other.test.js'], undefined);
  assert.deepEqual(Object.keys(selection.reasons).sort(), selection.files);
});

test('a Markdown-only change selects only the tests that read it, with no retained opaque roots [C7,V4]', t => {
  const { root, base } = repository(t);
  const selection = selectAffectedTests(root, { base, commit: base, changed: ['docs/one.md'] });
  assert.deepEqual(selection.files, ['test/docs.test.js']);
  assert.equal(selection.reasons['test/docs.test.js'], 'docs/one.md -> test/docs.test.js');
  assert.equal(selection.reason, '');
  const none = selectAffectedTests(root, { base, commit: base, changed: ['docs/unread.md'] });
  assert.deepEqual(none.files, []);
});

test('the fan-out lists changed files, the selected count and the top reasons by count [C7,V4]', () => {
  const fan = selectionFanOut({ files: ['a', 'b', 'c'], reasons: { a: 'x.js -> a', b: 'x.js -> b', c: 'unresolved closure: loader' } }, ['x.js']);
  assert.deepEqual(fan, { changed: ['x.js'], selected: 3, top: [{ reason: 'reached from x.js', count: 2 }, { reason: 'unresolved closure: loader', count: 1 }] });
});
