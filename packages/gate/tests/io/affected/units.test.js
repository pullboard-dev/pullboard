/** @pullboard-test-input packages/gate/src/io/affected/tests.js */
/** @pullboard-world-pin: clause 4 reads the selection source to prove it holds no CommonJS loader. */
/** With gate.selectionUnit set, selection picks units from the changed paths and the repo manifests, never from the JavaScript import graph [C7]. */
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { join } from 'node:path';
import { test } from 'node:test';
import { runFixtureGit } from '../../fixtures/child.js';
import { temporaryRepository } from '../../../../store/tests/fixtures/submit.js';
import { commonJsIn } from '../../../index.js';
import { selectAffectedTests } from '../../../index.js';

/** A real repository with a Go layout (two packages) and a Rust crate beside it, a base commit, and a candidate branch. */
function repository(t) {
  const root = temporaryRepository(t, 'pullboard-units-');
  const git = (...args) => runFixtureGit(['-c', 'user.name=t', '-c', 'user.email=t@example.com', ...args], { cwd: root });
  const put = (path, source) => { mkdirSync(dirname(join(root, path)), { recursive: true }); writeFileSync(join(root, path), source); };
  put('go.mod', 'module example.com/app\n');
  put('pkg/a/a.go', 'package a\n');
  put('pkg/b/b.go', 'package b\n');
  put('crates/x/Cargo.toml', '[package]\nname = "x"\n');
  put('crates/x/src/lib.rs', 'pub fn x() {}\n');
  put('README.md', 'x\n');
  git('add', '-A'); git('commit', '-qm', 'chore: fixture');
  const base = git('rev-parse', 'HEAD').trim();
  git('checkout', '-qb', 'candidate');
  return { root, base, put, commit: () => { git('add', '-A'); git('commit', '-qm', 'candidate'); } };
}

test('gate.units.one-package: clause 1: in a real git fixture with a Go layout of two packages, a change in one package selects only that package unit [C7]', async t => {
  const box = repository(t);
  box.put('pkg/a/a.go', 'package a // changed\n');
  box.commit();
  const result = (await selectAffectedTests(box.root, { base: box.base, unit: 'package' }));
  assert.deepEqual({ full: result.full, files: result.files }, { full: false, files: ['pkg/a'] });
  box.put('pkg/b/b.go', 'package b // changed\n');
  box.commit();
  const both = (await selectAffectedTests(box.root, { base: box.base, unit: 'package' }));
  assert.deepEqual(both.files, ['pkg/a', 'pkg/b']);
});

test('gate.units.manifest-or-none: clause 2: a changed manifest or a path under no unit selects the full gate with a reason [C7]', async t => {
  const box = repository(t);
  box.put('go.mod', 'module example.com/app\n\ngo 1.22\n');
  box.commit();
  const manifest = (await selectAffectedTests(box.root, { base: box.base, unit: 'package' }));
  assert.equal(manifest.full, true);
  assert.match(manifest.reason, /SELECTION_UNIT_MANIFEST: go\.mod/u);
  const none = repository(t);
  none.put('README.md', 'changed\n');
  none.commit();
  const outside = (await selectAffectedTests(none.root, { base: none.base, unit: 'crate' }));
  assert.equal(outside.full, true);
  assert.match(outside.reason, /SELECTION_UNIT_NONE: README\.md has no crate above it/u);
  const crate = repository(t);
  crate.put('crates/x/src/lib.rs', 'pub fn x() { }\n');
  crate.commit();
  assert.deepEqual((await selectAffectedTests(crate.root, { base: crate.base, unit: 'crate' })).files, ['crates/x']);
  const cargo = repository(t);
  cargo.put('crates/x/Cargo.toml', '[package]\nname = "x"\nversion = "1.0.0"\n');
  cargo.commit();
  assert.match((await selectAffectedTests(cargo.root, { base: cargo.base, unit: 'crate' })).reason, /SELECTION_UNIT_MANIFEST: crates\/x\/Cargo\.toml/u);
});

test('gate.units.file-unchanged: clause 3: with the setting file the repo own JavaScript selection is unchanged [C7]', t => {
  const box = repository(t);
  box.put('pkg/a/a.go', 'package a // changed\n');
  box.commit();
  const plain = selectAffectedTests(box.root, { base: box.base });
  assert.deepEqual(selectAffectedTests(box.root, { base: box.base, unit: 'file' }), plain);
  assert.equal(plain.full, true, 'a repo with no Node tests still runs the full gate');
});

test('gate.units.no-opaque-loader: clause 4: affected/tests.js loads the unit module by a dynamic import, so the runner tooling closure check sees no CommonJS loader [C7]', () => {
  const source = readFileSync(new URL('../../../src/io/affected/tests.js', import.meta.url), 'utf8');
  assert.deepEqual(commonJsIn([source]), [false]);
  assert.doesNotMatch(source, /createRequire\(import\.meta\.url\)|from 'node:module'/u);
  assert.match(source, /await import\('\.\.\/\.\.\/logic\/selection-unit\.js'\)/u);
});
