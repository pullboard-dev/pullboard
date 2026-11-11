/** Manifest copies retain moved runtime files and reject executable hand copiers [C7]. */
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { mkdirSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import { readdirSync } from 'node:fs';
import { rmSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { copyPackageFiles } from '../index.js';
import { fixtureCopierProblems } from '../../../apps/cli/tests/fixtures/copy.js';

/** Create only private source and destination directories, never the person's checkout. */
function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'pullboard-package-copier-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const source = join(root, 'source'), target = join(root, 'target');
  mkdirSync(join(source, 'packages/spec'), { recursive: true });
  writeFileSync(join(source, 'package.json'), JSON.stringify({ type: 'module', files: ['packages'] }));
  writeFileSync(join(source, 'packages/spec/value.js'), 'export const value = 17;\n');
  return { source, target };
}

test('whole package copies automatically include a new package runtime home [C7]', t => {
  const { source, target } = fixture(t);
  assert.deepEqual(copyPackageFiles(source, target), ['package.json', 'packages/spec/value.js']);
  assert.equal(readFileSync(join(target, 'packages/spec/value.js'), 'utf8'), 'export const value = 17;\n');
});

test('selective copies resolve moved identities while retaining explicit synthetic layout [C7]', t => {
  const { source, target } = fixture(t);
  const pathMap = new Map([['src/value.js', 'packages/spec/value.js']]);
  assert.deepEqual(copyPackageFiles(source, target, { files: [{ path: 'src/value.js', as: 'src/value.js' }], pathMap }), ['src/value.js']);
  assert.equal(readFileSync(join(target, 'src/value.js'), 'utf8'), 'export const value = 17;\n');
  assert.deepEqual(readdirSync(target), ['src'], 'a partial fixture stays partial');
});

test('invalid subsets fail before copying any selected file [C7]', t => {
  const { source, target } = fixture(t);
  for (const files of [['../../../secret'], ['unshipped.js'], ['packages/spec/value.js', 'packages/spec/value.js'], [{ path: 'packages/spec/value.js', as: '../../../escape' }]]) {
    assert.throws(() => copyPackageFiles(source, target, { files }));
  }
  assert.throws(() => copyPackageFiles(source, target, { files: ['src/value.js'], pathMap: new Map([['src/value.js', 'src/value.js']]) }), /cyclic/u);
  assert.throws(() => readdirSync(target), { code: 'ENOENT' });
});

test('manifest exclusions never become subset destination or path-map instructions [C7]', t => {
  const { source, target } = fixture(t);
  writeFileSync(join(source, 'packages/spec/private.js'), 'private fixture bytes\n');
  writeFileSync(join(source, 'package.json'), JSON.stringify({ type: 'module',
    files: ['packages', '!packages/spec/private.js'] }));
  assert.throws(() => copyPackageFiles(source, target,
    { files: [{ path: 'packages/spec/value.js', as: '!private.js' }] }), /exact regular files/u);
  assert.throws(() => copyPackageFiles(source, target, { files: ['src/value.js'],
    pathMap: new Map([['src/value.js', '!packages/spec/value.js']]) }), /exact regular files/u);
  assert.throws(() => readdirSync(target), { code: 'ENOENT' }, 'invalid subsets create no partial destination');
  assert.deepEqual(copyPackageFiles(source, target), ['package.json', 'packages/spec/value.js']);
  assert.throws(() => readFileSync(join(target, 'packages/spec/private.js')), { code: 'ENOENT' },
    'ordinary manifest exclusions retain their accepted behavior');
});

test('the guard names hand copies including imported aliases, finite lists and read-write copies [C7]', () => {
  for (const source of [
    "import { cpSync } from 'node:fs'; cpSync(new URL('../../../src', import.meta.url), target);",
    "import { copyFileSync as duplicate } from 'node:fs'; const input = new URL('../../gate/src/io/run/tests.js', import.meta.url); duplicate(input, target);",
    "import * as fs from 'node:fs'; for (const entry of ['src', 'bin']) fs.cpSync(join(root, entry), join(target, entry));",
    "import { readFileSync, writeFileSync } from 'node:fs'; const body = readFileSync(new URL('../../../src/a.js', import.meta.url)); writeFileSync(target, body);",
    "import { cpSync, mkdtempSync } from 'node:fs'; function privateFixture(){const root=mkdtempSync('/tmp/x');return root;} function installed(){const root=new URL('../../..',import.meta.url);cpSync(new URL('../../../src',import.meta.url),target);}",
    "import { cpSync, mkdtempSync } from 'node:fs'; import {join} from 'node:path'; cpSync(flag ? join(ROOT,'src') : join(mkdtempSync('/tmp/x-'),'src'),target);",
    "import { cpSync } from 'node:fs'; import {join} from 'node:path'; function mkdtempSync(){return ROOT;} cpSync(join(mkdtempSync('/tmp/x-'),'src'),target);",
    "import { cpSync, mkdtempSync } from 'node:fs'; import {join} from 'node:path'; function copy(mkdtempSync){cpSync(join(mkdtempSync('/tmp/x-'),'src'),target);}",
    "import {cpSync} from 'node:fs'; import {join} from 'node:path'; const root=getRoot(); cpSync(join(root,'src'),target);",
    "import {readFileSync,writeFileSync} from 'node:fs'; import {join} from 'node:path'; writeFileSync(target,readFileSync(join(getRoot(),'src/a.js')));",
    "import {cpSync} from 'node:fs'; function toolRoot(){return new URL('../../..',import.meta.url);} cpSync(new URL('src/',toolRoot()),target);",
  ]) assert.match(fixtureCopierProblems(source, 'planted.js').join('\n'), /planted\.js:1: hand/u);
  assert.match(fixtureCopierProblems("const fs = require('node:fs'); fs.cpSync('../../../src', target);", 'opaque.js').join('\n'), /opaque filesystem binding/u);
});

test('the guard ignores fixture strings, comments and private board or test-helper copies [C7]', () => {
  const source = "import { cpSync, copyFileSync } from 'node:fs';\n// cpSync('../../../src', target);\nconst fixture = \"cpSync('../../../bin', target)\";\ncpSync(join(root, '.git/pullboard'), target);\ncopyFileSync(new URL('../../../apps/cli/tests/fixtures/child.js', import.meta.url), target);";
  assert.deepEqual(fixtureCopierProblems(source), []);
  assert.deepEqual(fixtureCopierProblems("import {writeFileSync} from 'node:fs'; const BIN=new URL('../../../apps/cli/pullboard.js',import.meta.url); writeFileSync(target, `exec ${BIN}`);"), [], 'a launcher refers to tooling without copying its bytes');
  assert.deepEqual(fixtureCopierProblems("import {readFileSync,writeFileSync} from 'node:fs'; const data=JSON.parse(readFileSync(new URL('../../../src/blueprints/web-app.json',import.meta.url))); writeFileSync(target,JSON.stringify({...data,name:'changed'}));"), [], 'parsed fixture data is not a runtime file copy');
  assert.deepEqual(fixtureCopierProblems("import {readFileSync,writeFileSync} from 'node:fs'; const path=join(root,'src/sample.js'); const original=readFileSync(path); writeFileSync(path,original);"), [], 'restoring bytes to the same source is not a copy into another fixture');

  assert.deepEqual(fixtureCopierProblems("import { cpSync, mkdtempSync } from 'node:fs'; import {join} from 'node:path'; function fixture(){const scratch=mkdtempSync('/tmp/x');return scratch;} const root=fixture(); cpSync(join(root,'src/sample-engine.js'),target);"), []);
});

test('every test fixture uses the manifest helper for shipped tool copies [C7]', () => {
  const problems = [];
  /** Inspect source without following symlinks or executing a fixture program. */
  function visit(directory, prefix = 'test') {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name), file = `${prefix}/${entry.name}`;
      if (entry.isDirectory()) visit(path, file);
      else if (entry.isFile() && /\.[cm]?js$/u.test(entry.name)) problems.push(...fixtureCopierProblems(readFileSync(path, 'utf8'), file));
    }
  }
  visit(import.meta.dirname);
  assert.deepEqual(problems, [], problems.join('\n'));
});
