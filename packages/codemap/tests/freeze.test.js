/** @pullboard-test-input source-tree */
/** The freeze script applies the rename table to a fixture repository: every import resolves, it is idempotent and refuses a dirty tree [V32,V33]. */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { fixture } from '../../landing/tests/fixtures/plan.js';
import { git } from '../../landing/tests/fixtures/plan.js';
import { freeze } from '../src/io/freeze.js';
import { joinModules } from '../src/io/freeze.js';
import { parseTable } from '../src/io/freeze.js';
import { pathRewriter } from '../src/io/freeze.js';

const SCRIPT = fileURLToPath(new URL('../src/io/freeze.js', import.meta.url));
const TABLE = [
  'package.json\tpackage.json',
  'bin/tool.js\tapps/tool/main.js',
  'src/shim.js\tdelete\timporters -> packages/beta/index.js',
  'packages/alpha/index.js\tpackages/alpha/index.js',
  'packages/alpha/src/shell/run.js\tpackages/alpha/src/io/run.js',
  'packages/alpha/src/shell/name.js\tpackages/alpha/src/io/name.js',
  'packages/beta/index.js\tpackages/beta/index.js',
  'packages/beta/core.js\tpackages/beta/light.js',
  'packages/beta/src/core/shared.js\tpackages/beta/src/logic/shared.js',
  'test/alpha.test.js\tpackages/alpha/tests/io/run.test.js',
  'test/alpha-2.test.js\tmerge:packages/alpha/tests/io/run.test.js',
  'bin/checks/list.json\tpackages/alpha/data/ceilings/list.json',
  'bin/cells-plan/path-map/alpha.json\tpackages/alpha/data/plan/path-map/alpha.json',
  'SPEC.md\tSPEC.md',
].join('\n') + '\n';

/** A committed repository in the old layout: two cells, a shim, a split test, a listing, a doc and a path-map shard. */
function oldRepo(t) {
  const { root, put } = fixture(t);
  git(root, 'rm', '-rq', '.');
  put('package.json', JSON.stringify({ type: 'module', bin: { tool: 'bin/tool.js' }, files: ['bin', 'src', 'packages'] }, null, 2) + '\n');
  put('bin/tool.js', "import { run } from '../packages/alpha/index.js';\nimport { shared } from '../src/shim.js';\nconsole.log(JSON.stringify([run(), shared]));\n");
  put('src/shim.js', "export { shared } from '../packages/beta/index.js';\n");
  put('packages/alpha/index.js', "export { run } from './src/shell/run.js';\n");
  put('packages/alpha/src/shell/run.js', "import { shared } from '../../../beta/src/core/shared.js';\nimport { name } from './name.js';\nexport const run = () => [shared, name];\n");
  put('packages/alpha/src/shell/name.js', "export const name = 'alpha';\n");
  put('packages/beta/index.js', "export * from './core.js';\n");
  put('packages/beta/core.js', "export * from './src/core/shared.js';\n");
  put('packages/beta/src/core/shared.js', "export const shared = 'beta';\n");
  put('test/alpha.test.js', "/** First half. */\nimport assert from 'node:assert/strict';\nimport { test } from 'node:test';\nimport { run } from '../packages/alpha/index.js';\n\nfunction check() { return run(); }\ntest('first', () => assert.deepEqual(check(), ['beta', 'alpha']));\n");
  put('test/alpha-2.test.js', "/** Second half. */\nimport assert from 'node:assert/strict';\nimport { test } from 'node:test';\nimport { run } from '../packages/alpha/index.js';\nimport { name } from '../packages/alpha/src/shell/name.js';\n\nfunction check() { return name; }\ntest('second', () => assert.equal(check(), 'alpha'));\ntest('third', () => assert.equal(run().length, 2));\n");
  put('bin/checks/list.json', JSON.stringify({ files: { 'packages/alpha/src/shell/run.js': 1, 'test/alpha-2.test.js': 2 } }, null, 2) + '\n');
  put('bin/cells-plan/path-map/alpha.json', JSON.stringify({ 'src/old-run.js': 'packages/alpha/src/shell/run.js' }, null, 2) + '\n');
  put('SPEC.md', 'See packages/alpha/src/shell/run.js and the unrelated src/other.js.\n');
  put('renames.tsv', TABLE);
  git(root, 'add', '-A');
  git(root, 'commit', '-q', '-m', 'old layout');
  return root;
}

test('the table reads move, delete and merge rows and drops identity rows [V32]', () => {
  assert.deepEqual(parseTable(TABLE).map(row => `${row.kind} ${row.old} ${row.to}`).slice(0, 4), [
    'move bin/tool.js apps/tool/main.js',
    'delete src/shim.js packages/beta/index.js',
    'move packages/alpha/src/shell/run.js packages/alpha/src/io/run.js',
    'move packages/alpha/src/shell/name.js packages/alpha/src/io/name.js',
  ]);
  assert.throws(() => parseTable('src/a.js\tdelete\n'), /FREEZE_TABLE/u);
});

test('path words follow their file, ignore prose neighbours and leave history alone [V32]', () => {
  const rewrite = pathRewriter(new Map([['src/a.js', 'packages/x/src/io/a.js']]), new Map([['src/old', 'packages/x/src/new']]));
  assert.equal(rewrite('see src/a.js, src/a.json and src/a.js.'), 'see packages/x/src/io/a.js, src/a.json and packages/x/src/io/a.js.');
  assert.equal(rewrite('{"src/a.js->src/old/b.js": 1}'), '{"packages/x/src/io/a.js->packages/x/src/new/b.js": 1}');
  assert.equal(rewrite('const relay = /i/;'), 'const relay = /i/;');
});

test('joining test files keeps every case, shares imports and renames clashing helpers [V32]', () => {
  const target = "/** A. */\nimport { test } from 'node:test';\nimport { x } from './x.js';\n\nfunction help() {}\ntest('one', () => help(x));\n";
  const tail = "/** B. */\nimport { test } from 'node:test';\nimport { x, y } from './x.js';\n\nfunction help() {}\ntest('two', () => help(y));\n";
  const joined = joinModules(target, [{ old: 'b.test.js', text: tail }]);
  assert.equal(joined.conflicts.length, 0);
  assert.equal([...joined.text.matchAll(/^test\(/gmu)].length, 2);
  assert.equal([...joined.text.matchAll(/import \{ test \}/gu)].length, 1);
  assert.match(joined.text, /import \{ y \} from '\.\/x\.js';/u);
  assert.match(joined.text, /function helpPart2\(\)/u);
  assert.match(joined.text, /helpPart2\(y\)/u);
});

test('the freeze moves, joins and deletes, rewrites every path, and every import resolves [V32,V33]', async t => {
  const root = oldRepo(t);
  const summary = await freeze(root, { table: join(root, 'renames.tsv') });
  assert.equal(summary.moved, 8);
  assert.equal(summary.merged, 1);
  assert.equal(summary.deleted, 1);
  assert.deepEqual(summary.unresolved, []);
  const tracked = git(root, 'ls-files').split('\n').filter(Boolean);
  assert.deepEqual(tracked.filter(file => file.startsWith('bin/') || file.startsWith('src/') || file.startsWith('test/')), []);
  assert.ok(existsSync(join(root, 'packages/beta/src/logic/shared.js')));
  const run = spawnSync(process.execPath, ['apps/tool/main.js'], { cwd: root, encoding: 'utf8' });
  assert.equal(run.status, 0, run.stderr);
  assert.equal(run.stdout.trim(), '[["beta","alpha"],"beta"]');
  assert.match(readFileSync(join(root, 'packages/alpha/src/io/run.js'), 'utf8'), /from '\.\.\/\.\.\/\.\.\/beta\/light\.js'/u);
  const merged = readFileSync(join(root, 'packages/alpha/tests/io/run.test.js'), 'utf8');
  assert.equal([...merged.matchAll(/^test\(/gmu)].length, 3);
  assert.equal(JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).bin.tool, 'apps/tool/main.js');
  assert.deepEqual(JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).files, ['packages', '!*/*/journeys/**']);
  assert.deepEqual(JSON.parse(readFileSync(join(root, 'packages/alpha/data/ceilings/list.json'), 'utf8')).files, { 'packages/alpha/src/io/run.js': 1, 'packages/alpha/tests/io/run.test.js': 2 });
  assert.match(readFileSync(join(root, 'SPEC.md'), 'utf8'), /packages\/alpha\/src\/io\/run\.js and the unrelated src\/other\.js/u);
  assert.deepEqual(summary.docLines, ['SPEC.md:1: packages/alpha/src/shell/run.js -> packages/alpha/src/io/run.js']);
  const shard = JSON.parse(readFileSync(join(root, 'packages/alpha/data/plan/path-map/freeze.json'), 'utf8'));
  assert.equal(shard['bin/tool.js'], 'apps/tool/main.js');
  assert.equal(shard['src/shim.js'], undefined);
  assert.equal(JSON.parse(readFileSync(join(root, 'packages/alpha/data/plan/path-map/alpha.json'), 'utf8'))['src/old-run.js'], 'packages/alpha/src/io/run.js');
});

test('a second run finds every row done and changes nothing [V32]', async t => {
  const root = oldRepo(t);
  await freeze(root, { table: join(root, 'renames.tsv') });
  git(root, 'commit', '-qam', 'frozen');
  const before = git(root, 'rev-parse', 'HEAD');
  const again = await freeze(root, { table: join(root, 'renames.tsv') });
  assert.equal(again.moved + again.merged + again.deleted, 0);
  assert.equal(again.done, 10);
  assert.equal(git(root, 'status', '--porcelain'), '');
  assert.equal(git(root, 'rev-parse', 'HEAD'), before);
});

test('a dirty tree is refused before anything moves, and a dry run prints a summary and changes nothing [V32]', async t => {
  const root = oldRepo(t);
  writeFileSync(join(root, 'stray.txt'), 'x\n');
  await assert.rejects(freeze(root, { table: join(root, 'renames.tsv') }), /FREEZE_DIRTY/u);
  const refused = spawnSync(process.execPath, [SCRIPT, '--root', root, '--table', join(root, 'renames.tsv')], { encoding: 'utf8' });
  assert.equal(refused.status, 1);
  assert.match(refused.stderr, /FREEZE_DIRTY.*commit or remove/u);
  git(root, 'add', '-A');
  git(root, 'commit', '-qm', 'stray');
  const dry = spawnSync(process.execPath, [SCRIPT, '--root', root, '--table', join(root, 'renames.tsv'), '--dry-run'], { encoding: 'utf8' });
  assert.equal(dry.status, 0, dry.stderr);
  assert.match(dry.stdout, /dry run: 10 rows/u);
  assert.match(dry.stdout, /moved 8, merged 1, deleted 1/u);
  assert.match(dry.stdout, /unresolved imports 0/u);
  assert.equal(git(root, 'status', '--porcelain'), '');
  assert.ok(existsSync(join(root, 'bin/tool.js')));
});
