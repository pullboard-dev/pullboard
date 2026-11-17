/** The census skip dry run lists the files with an earlier green row and no declared input changed between two shas [C7,#10379]. @pullboard-test-input source-cell apps/cli */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdirSync } from 'node:fs';
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { privateFixtureFiles } from '../../../../../packages/gate/tests/fixtures/child.js';
import { runFixtureGit } from '../../../../../packages/gate/tests/fixtures/child.js';
import { fixtureCommitAll } from '../../../../../packages/gate/tests/fixtures/testkit.js';
import { dryRunSkip } from '../../../src/io/test/census-skip-dry.js';
import { skipSplit } from '../../../src/logic/census-skip.js';

/** A tiny repo with three tests, each importing its own module, and a commit function. */
function repo(t) {
  const box = privateFixtureFiles('pullboard-census-skip-dry-');
  const root = join(box.root, 'repo');
  mkdirSync(root);
  t.after(() => rmSync(box.root, { recursive: true, force: true }));
  const put = (path, source) => box.write(`repo/${path}`, source);
  const commit = () => { fixtureCommitAll(root); return runFixtureGit(['rev-parse', 'HEAD'], { cwd: root }).trim(); };
  put('package.json', '{"type":"module","private":true}\n');
  for (const name of ['a', 'b', 'c']) { put(`src/${name}.js`, `export const ${name} = 1;\n`); put(`test/${name}.test.js`, `import '../src/${name}.js';\n`); }
  return { root, put, commit };
}

const TESTS = ['test/a.test.js', 'test/b.test.js', 'test/c.test.js'];
const rows = (sha, status = 'green') => TESTS.map(file => `${JSON.stringify({ file, status, sha })}\n`).join('');

test('clause 1: the dry run lists as skipped only the green files whose declared inputs did not change between the two shas, and reports the share [C7,#10379]', (t) => {
  const box = repo(t);
  const first = box.commit();
  box.put('src/a.js', 'export const a = 2;\n');
  const second = box.commit();
  box.put('previous.jsonl', rows(first, 'green'));
  box.put('current.jsonl', rows(second, 'green'));
  const result = dryRunSkip(box.root, { previous: join(box.root, 'previous.jsonl'), current: join(box.root, 'current.jsonl') });
  assert.deepEqual(result.run, ['test/a.test.js']);
  assert.deepEqual(result.skip, ['test/b.test.js', 'test/c.test.js']);
  assert.equal(result.share, 2 / 3);
  assert.equal(result.from, first);
  assert.equal(result.to, second);
});

test('clause 1: a file not green in the earlier census, or a selection that is full, is never skipped [C7,#10379]', () => {
  const previousRows = [{ file: 'a', status: 'green' }, { file: 'b', status: 'red' }, { file: 'c', status: 'hung' }];
  const part = skipSplit({ files: ['a', 'b', 'c', 'd'], previousRows, selection: { full: false, files: [] } });
  assert.deepEqual(part.skip, ['a']);
  assert.deepEqual(part.run, ['b', 'c', 'd']);
  const full = skipSplit({ files: ['a', 'b'], previousRows, selection: { full: true, reason: 'x', files: ['a'] } });
  assert.deepEqual(full.skip, []);
  assert.equal(full.share, 0);
});
