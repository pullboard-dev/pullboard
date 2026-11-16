/** @pullboard-test-input apps/cli/src/io/static/checks.js packages/gate/tests/fixtures/budgets.js */
/** The actual repository preflight keeps source oracles separate from browser behavior [C7]. */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { mkdtempSync } from 'node:fs';
import { rmSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolve } from 'node:path';
import { test } from 'node:test';
import { runFixtureChild } from '../../gate/tests/fixtures/child.js';

const repository = resolve(import.meta.dirname, '../../..');
const staticArgs = ['--experimental-vm-modules', '--disable-warning=ExperimentalWarning', 'apps/cli/src/io/static/checks.js'];
const nested = 'apps/cli/src/io/nested/import-style-fixture.js';
const finding = `${nested}:1: one import binding per line (2 bindings)`;
let scopedRun;

/** Run the production incremental preflight on a repository copy with one planted source change. */
function preflightWithViolation() {
  if (scopedRun) return scopedRun;
  const root = mkdtempSync(join(tmpdir(), 'pullboard-static-style-recursive-'));
  try {
    // The full preflight reads test and policy files that the distribution package omits.
    const checkout = spawnSync('git', ['checkout-index', '--all', `--prefix=${root}/`],
      { cwd: repository, encoding: 'utf8' });
    assert.equal(checkout.status, 0, checkout.stderr);
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
    scopedRun = runFixtureChild(process.execPath, staticArgs, {
      cwd: root,
      encoding: 'utf8',
      env: { ...process.env, PULLBOARD_STATIC_SCOPE: JSON.stringify([nested]) },
    });
    console.log(JSON.stringify({ staticProgramWallMs: performance.now() - before, status: scopedRun.status }));
    return scopedRun;
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test('clause 1: the repository static style command enforces its source rules [C7]', () => {
  const clean = runFixtureChild(process.execPath,
    [...staticArgs, '--changed-files', 'apps/cli/src/io/static/checks.js'], { cwd: repository, encoding: 'utf8' });
  assert.equal(clean.status, 0, clean.failure ?? ((clean.stdout ?? '') + (clean.stderr ?? '')));
  const scoped = preflightWithViolation();
  assert.deepEqual(scoped.stderr.trim().split('\n'), [finding], scoped.failure ?? scoped.stderr);
});

test('clause 1: the static command reports a nested multi-binding import [C7]', () => {
  const child = preflightWithViolation();
  assert.equal(child.status, 1, child.failure ?? ((child.stdout ?? '') + (child.stderr ?? '')));
  assert.ok(child.stderr.includes(finding), child.stderr);
});
