/** @pullboard-test-input packages/gate/src/io/test/freeze/paths.js */
/** A moved test's path math is rewritten when its target still resolves, and named by file and line when it cannot be [C7]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { rebasePathMath } from '../../../src/io/test/freeze/paths.js';

const FROM = 'apps/cli/journeys/add/main.test.js';
const TO = 'packages/math/tests/journeys/add/main.test.js';
const present = new Set(['apps/cli/tests/fixtures/data.json', 'apps/cli/tests/fixtures', 'apps/cli/journeys/add']);
const exists = path => present.has(path);
const run = source => rebasePathMath(source, FROM, TO, exists);

test('new URL path math is rewritten to the same target from the new folder [C7]', () => {
  const { source, problems } = run("const f = new URL('../../tests/fixtures/data.json', import.meta.url);\n");
  assert.deepEqual(problems, []);
  assert.equal(source, "const f = new URL('../../../../../apps/cli/tests/fixtures/data.json', import.meta.url);\n");
});

test('join and resolve on the file directory are rewritten, through a variable or inline [C7]', () => {
  const text = [
    "import { dirname, join, resolve } from 'node:path';",
    "const here = dirname(fileURLToPath(import.meta.url));",
    "const a = join(here, '../../tests/fixtures/data.json');",
    "const b = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', 'tests', 'fixtures/');",
    "const c = join(__dirname, '../../tests/fixtures');",
    '',
  ].join('\n');
  const { source, problems } = run(text);
  assert.deepEqual(problems, []);
  assert.match(source, /join\(here, '\.\.\/\.\.\/\.\.\/\.\.\/\.\.\/apps\/cli\/tests\/fixtures\/data\.json'\)/u);
  assert.match(source, /resolve\(dirname\(fileURLToPath\(import\.meta\.url\)\), '\.\.\/\.\.\/\.\.\/\.\.\/\.\.\/apps\/cli\/tests\/fixtures\/'\)/u);
  assert.match(source, /join\(__dirname, '\.\.\/\.\.\/\.\.\/\.\.\/\.\.\/apps\/cli\/tests\/fixtures'\)/u);
});

test('a target that no longer resolves is named with its line [C7]', () => {
  const { source, problems } = run("x;\nconst f = new URL('./missing.json', import.meta.url);\n");
  assert.equal(problems.length, 1);
  assert.equal(problems[0].line, 2);
  assert.match(problems[0].because, /does not resolve/u);
  assert.equal(source, "x;\nconst f = new URL('./missing.json', import.meta.url);\n");
});

test('path math that is not literal join or resolve is named with its line [C7]', () => {
  const { problems } = run("const here = dirname(fileURLToPath(import.meta.url));\nconst p = here + '/x';\nconst q = fileURLToPath(import.meta.url);\n");
  assert.deepEqual(problems.map(entry => entry.line), [2, 3]);
});

test('a file that stays in its folder, or has no path math, is left as it is [C7]', () => {
  assert.deepEqual(rebasePathMath("new URL('./x', import.meta.url)", FROM, 'apps/cli/journeys/add/other.test.js', () => false), { source: "new URL('./x', import.meta.url)", problems: [] });
  assert.deepEqual(run('const x = 1;\n'), { source: 'const x = 1;\n', problems: [] });
});
