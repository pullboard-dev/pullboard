/** @pullboard-test-input source-tree */
/** The landing history alias preserves the native move registry's exact bounded source [C7,H16]. */
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { rmSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { copyPackageFiles } from '../packages/runners/src/shell/package-files.js';
import { packageFiles } from '../packages/runners/src/shell/package-files.js';
import { importsIn } from '../packages/gate/index.js';
import { commonJsIn } from '../packages/gate/index.js';
import { moveDeclarationFiles } from '../bin/cells-move-closure.js';
import { workingSourceInventory } from '../bin/checks/scan.js';
import { sourceDirectories } from './machine-source-functions.fixture.js';
import { runFixtureGit } from './fixture-child.js';

test('landing history move keeps every move-closure body and refuses the expanded barrel [C7,H16]', t => {
  const root = join(import.meta.dirname, '..');
  const fixture = mkdtempSync(join(tmpdir(), 'pullboard-landing-closure-'));
  t.after(() => rmSync(fixture, { recursive: true, force: true }));
  const files = packageFiles(root);
  copyPackageFiles(root, fixture, { files });
  runFixtureGit(['init', '-q'], { cwd: fixture });
  runFixtureGit(['add', 'package.json', 'bin/cells-plan/path-map'], { cwd: fixture });
  runFixtureGit(['-c', 'user.name=Closure fixture', '-c', 'user.email=closure@example.invalid',
    '-c', 'commit.gpgsign=false', 'commit', '-qm', 'Pin the copied source map'], { cwd: fixture });
  const old = 'src/landing-batch-history.js';
  const moved = 'packages/landing/src/core/landing-batch-history.js';
  /** Read exact working bytes through the canonical committed-map inventory, then select the real bounded closure. */
  const closure = () => {
    const reached = moveDeclarationFiles(fixture, { files, importsIn, commonJsIn });
    return Object.fromEntries(workingSourceInventory(fixture, sourceDirectories(files))
      .filter(row => reached.has(row.file)).map(row => [row.file, row.body.toString('utf8')]));
  };
  const after = closure();
  const alias = after[old];
  const body = after[moved];
  assert.match(body, /from '\.\.\/\.\.\/\.\.\/\.\.\/src\/git-landing-batches\.js'/u);
  assert.ok(Object.hasOwn(after, old), 'the shipped compatibility entry remains in the real registry closure');
  assert.equal(after[moved], body, 'the exact relocated body is reachable');
  writeFileSync(join(fixture, old), body.replace('../../../../src/git-landing-batches.js', './git-landing-batches.js'));
  const before = closure();
  assert.equal(Object.hasOwn(before, moved), false, 'the pre-move layout does not reach the relocated provider');
  const expected = { ...before, [old]: alias, [moved]: body };
  assert.deepEqual(after, expected, 'only the alias and relocation change; every other source byte remains identical');
  writeFileSync(join(fixture, old), 'export * from "../packages/landing/index.js";\n');
  assert.throws(closure, /move closure exceeds source bounds/u,
    'the full barrel loses the bounded registry closure and cannot receive this exact-file exception');
});
