/** @pullboard-test-input source-tree */
/** The actual repository preflight keeps source oracles separate from browser behavior [C7]. */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { runFixtureChild } from './fixture-child.js';
import { copyPackageFiles } from '../src/package-files.js';

test('the repository static style command enforces its source rules [C7]', () => {
  const before = performance.now();
  const child = runFixtureChild(process.execPath,
    ['--experimental-vm-modules', '--disable-warning=ExperimentalWarning', 'bin/static-style-checks.js'],
    { cwd: resolve(import.meta.dirname, '..'), encoding: 'utf8' });
  console.log(JSON.stringify({ staticProgramWallMs: performance.now() - before, status: child.status }));
  assert.equal(child.status, 0, child.failure ?? ((child.stdout ?? '') + (child.stderr ?? '')));
});

test('the static checks read every source file for one import binding per line [C7]', t => {
  const root = mkdtempSync(join(tmpdir(), 'pullboard-static-style-recursive-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const repository = resolve(import.meta.dirname, '..');
  copyPackageFiles(repository, root);
  mkdirSync(join(root, 'test'), { recursive: true });
  cpSync(join(repository, 'test/wall-clock-budgets.js'), join(root, 'test/wall-clock-budgets.js'));
  cpSync(join(repository, 'pullboard.json'), join(root, 'pullboard.json'));

  const nested = 'src/commands/nested/import-style-fixture.js';
  mkdirSync(join(root, 'src/commands/nested'), { recursive: true });
  writeFileSync(join(root, nested), "import { strict as assert, equal } from 'node:assert';\nvoid assert; void equal;\n");
  for (const args of [
    ['init', '-q', '-b', 'main'],
    ['add', 'src', 'bin', 'test', 'package.json', 'pullboard.json'],
    ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-q', '-m', 'fixture'],
  ]) {
    const result = spawnSync('git', args, { cwd: root, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
  }

  const child = runFixtureChild(process.execPath,
    ['--experimental-vm-modules', '--disable-warning=ExperimentalWarning', 'bin/static-style-checks.js'],
    { cwd: root, encoding: 'utf8' });
  assert.equal(child.status, 1, child.failure ?? ((child.stdout ?? '') + (child.stderr ?? '')));
  assert.ok(child.stderr.includes(`${nested}:1: one import binding per line`), child.stderr);
});
