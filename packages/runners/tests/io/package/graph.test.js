/** @pullboard-test-input source-cell packages/runners */
/** Real subset copies distinguish bounded shim DAGs from cycles [C7,P3]. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdtempSync } from 'node:fs';
import { mkdirSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { copyPackageFiles } from '../../../index.js';

/** Own both private trees and exercise the public manifest-validated copier. */
function fixture(t, files) {
  const home = mkdtempSync(join(tmpdir(), 'shim-graph-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const root = join(home, 'source'), destination = join(home, 'copy');
  mkdirSync(root);
  writeFileSync(join(root, 'package.json'), JSON.stringify({ files: ['*.js'] }));
  for (const [name, text] of Object.entries(files)) writeFileSync(join(root, name), text);
  return { root, destination, copy: () => copyPackageFiles(root, destination, { files: ['entry.js'] }) };
}

/** Generate literal forwards, preserving real graph traversal rather than mocking the reader. */
function forwards(names) { return names.map(name => `export * from './${name}.js';`).join('\n'); }

test('subset copy deduplicates a diamond of pure shims without dropping its body [C7,P3]', t => {
  const f = fixture(t, { 'entry.js': forwards(['left', 'right']), 'left.js': forwards(['body']),
    'right.js': forwards(['body']), 'body.js': 'export const value = 7;\n' });
  assert.deepEqual(f.copy().sort(), ['body.js', 'entry.js', 'left.js', 'right.js']);
  assert.equal(readFileSync(join(f.destination, 'body.js'), 'utf8'), 'export const value = 7;\n');
});

test('subset copy permits a wide barrel beyond the old aggregate chain count [C7,P3]', t => {
  const names = Array.from({ length: 80 }, (_, i) => `body${i}`);
  const files = Object.fromEntries(names.map(name => [`${name}.js`, `export const ${name} = 1;`]));
  const f = fixture(t, { ...files, 'entry.js': forwards(names) });
  assert.equal(f.copy().length, 81);
});

test('subset copy refuses a true ancestry cycle before copying any selected source [C7,P3]', t => {
  const f = fixture(t, { 'entry.js': forwards(['next']), 'next.js': forwards(['entry']) });
  assert.throws(f.copy, /cyclic shim chain at entry\.js/u);
  assert.equal(existsSync(f.destination), false);
});

test('subset copy retains the independent shim depth bound [C7,P3]', t => {
  const files = { 'entry.js': forwards(['step0']) };
  for (let i = 0; i < 66; i++) files[`step${i}.js`] = forwards([`step${i + 1}`]);
  files['step66.js'] = 'export const end = 1;';
  const f = fixture(t, files);
  assert.throws(f.copy, /oversized shim chain/u);
  assert.equal(existsSync(f.destination), false);
});

test('subset copy refuses an over-budget broad DAG even when depth is shallow [C7,P3]', t => {
  const branches = Array.from({ length: 65 }, (_, i) => `branch${i}`);
  const leaves = Array.from({ length: 65 }, (_, i) => `leaf${i}`);
  const files = { 'entry.js': forwards(branches) };
  for (const name of branches) files[`${name}.js`] = forwards(leaves);
  for (const name of leaves) files[`${name}.js`] = `export const ${name} = 1;`;
  const f = fixture(t, files);
  assert.throws(f.copy, /oversized shim traversal/u);
  assert.equal(existsSync(f.destination), false);
});
