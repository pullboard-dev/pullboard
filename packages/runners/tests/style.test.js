/** @pullboard-test-input apps/cli/src/io/static/checks.js packages/gate/tests/fixtures/budgets.js */
/** The actual repository preflight keeps source oracles separate from browser behavior [C7]. */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cpSync } from 'node:fs';
import { mkdirSync } from 'node:fs';
import { mkdtempSync } from 'node:fs';
import { rmSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolve } from 'node:path';
import { after } from 'node:test';
import { test } from 'node:test';
import { runFixtureChild } from '../../gate/tests/fixtures/child.js';
import { copyPackageFiles } from '../index.js';

const repository = resolve(import.meta.dirname, '../../..');
const staticArgs = ['--experimental-vm-modules', '--disable-warning=ExperimentalWarning', 'apps/cli/src/io/static/checks.js'];
const nested = 'apps/cli/src/io/nested/import-style-fixture.js';
const finding = `${nested}:1: one import binding per line (2 bindings)`;
let fullRun;

/** Run the full preflight once on a repository copy with one planted violation. */
function fullPreflightWithViolation() {
  if (fullRun) return fullRun;
  const root = mkdtempSync(join(tmpdir(), 'pullboard-static-style-recursive-'));
  after(() => rmSync(root, { recursive: true, force: true }));
  copyPackageFiles(repository, root);
  cpSync(join(repository, 'packages/gate/tests/fixtures/budgets.js'), join(root, 'packages/gate/tests/fixtures/budgets.js'));
  cpSync(join(repository, 'pullboard.json'), join(root, 'pullboard.json'));
  mkdirSync(join(root, 'apps/cli/src/io/nested'), { recursive: true });
  writeFileSync(join(root, nested), "import { strict as assert, equal } from 'node:assert';\nvoid assert; void equal;\n");
  for (const args of [
    ['init', '-q', '-b', 'main'],
    ['add', '-A'],
    ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-q', '-m', 'fixture'],
  ]) {
    const result = spawnSync('git', args, { cwd: root, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
  }

  const before = performance.now();
  fullRun = runFixtureChild(process.execPath, staticArgs, { cwd: root, encoding: 'utf8' });
  console.log(JSON.stringify({ staticProgramWallMs: performance.now() - before, status: fullRun.status }));
  return fullRun;
}

test('clause 1: the repository static style command enforces its source rules [C7]', () => {
  const clean = runFixtureChild(process.execPath,
    [...staticArgs, '--changed-files', 'apps/cli/src/io/static/checks.js'], { cwd: repository, encoding: 'utf8' });
  assert.equal(clean.status, 0, clean.failure ?? ((clean.stdout ?? '') + (clean.stderr ?? '')));
  const full = fullPreflightWithViolation();
  assert.deepEqual(full.stderr.trim().split('\n'), [finding], full.failure ?? full.stderr);
});

test('clause 1: the full static command reports a nested multi-binding import [C7]', () => {
  const child = fullPreflightWithViolation();
  assert.equal(child.status, 1, child.failure ?? ((child.stdout ?? '') + (child.stderr ?? '')));
  assert.ok(child.stderr.includes(finding), child.stderr);
});
