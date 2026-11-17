/** @pullboard-test-input source-cell packages/runners */
/** @pullboard-test-loads packages/runners/src/io/module/parser.js packages/runners/src/io/module/parser/worker.js packages/runners/src/io/package/files.js */
/** Short runner controllers keep compiler results across processes, and one capture walks the package once [C7]. */
import assert from 'node:assert/strict';
import { chmodSync } from 'node:fs';
import { mkdirSync } from 'node:fs';
import { readdirSync } from 'node:fs';
import { rmSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { privateFixtureFiles } from '../../../../gate/tests/fixtures/child.js';
import { compiledIn } from '../../fixtures/parse-store.js';
import { packageFiles } from '../../../src/io/package/files.js';
import { withPackageListing } from '../../../src/io/package/files.js';

test('runners.store.a-later-short-controller-reuses-stored: a later short controller reuses stored compiler rows, and a malformed or shared store compiles again [C7]', t => {
  const scratch = privateFixtureFiles('pullboard-parse-store-').root;
  t.after(() => rmSync(scratch, { recursive: true, force: true }));
  const source = `import { a } from './store-probe-${process.pid}-${Date.now()}.js';\nexport const b = a;\n`;
  const cold = compiledIn(scratch, source);
  assert.equal(cold.count, 1, 'the first process compiles the source');
  const warm = compiledIn(scratch, source);
  assert.deepEqual(warm, { ...cold, count: 0 }, 'a later process reads the stored row and compiles nothing');

  const store = join(scratch, 'pullboard-runner-parse-cache');
  for (const name of readdirSync(store)) writeFileSync(join(store, name), '{"compiles":false,"imports":["./forged.js"]}');
  assert.deepEqual(compiledIn(scratch, source), cold, 'a row a fresh reply could never be is refused, and the source compiles again');

  chmodSync(store, 0o777);
  for (const name of readdirSync(store)) writeFileSync(join(store, name), '{"compiles":true,"imports":["./forged.js"]}');
  assert.deepEqual(compiledIn(scratch, source), cold, 'a store others could write is never read');
});

test('runners.store.one-capture-walks-a-package-once: one capture walks a package once, and the next walks it afresh [C7]', t => {
  const root = privateFixtureFiles('pullboard-listing-').root;
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, 'src'));
  writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'listing-probe', files: ['src'] }));
  writeFileSync(join(root, 'src/a.js'), 'export const a = 1;\n');
  const inside = withPackageListing(() => {
    const first = packageFiles(root);
    writeFileSync(join(root, 'src/b.js'), 'export const b = 1;\n');
    return { first, second: packageFiles(root) };
  });
  assert.deepEqual(inside.second, inside.first, 'readers inside one capture share its walk');
  assert.deepEqual(packageFiles(root), ['package.json', 'src/a.js', 'src/b.js'], 'outside it every call walks the disk');
  assert.deepEqual(withPackageListing(() => packageFiles(root)), ['package.json', 'src/a.js', 'src/b.js'], 'a later capture sees the new file');
});
