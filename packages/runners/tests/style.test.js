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
import { test } from 'node:test';
import { performance } from 'node:perf_hooks';
import { runFixtureChildAsync } from '../../gate/tests/fixtures/child.js';
import { copyPackageFiles } from '../index.js';

const repository = resolve(import.meta.dirname, '../../..');
const staticArgs = ['--experimental-vm-modules', '--disable-warning=ExperimentalWarning', 'apps/cli/src/io/static/checks.js'];
const nested = 'apps/cli/src/io/nested/import-style-fixture.js';
const root = mkdtempSync(join(tmpdir(), 'pullboard-static-style-recursive-'));

/** Start both static runs at once: they read separate trees, so the file takes the slower run's time, not the sum. */
function startRepositoryRun() {
  const before = performance.now();
  return runFixtureChildAsync(process.execPath, staticArgs, { cwd: repository, encoding: 'utf8' })
    .then(child => ({ child, wallMs: performance.now() - before }));
}

/** Run the checks on a copy that holds one multi-binding import in a nested folder. */
function startRecursiveRun() {
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
  return runFixtureChildAsync(process.execPath, staticArgs, { cwd: root, encoding: 'utf8' });
}

const recursiveRun = startRecursiveRun();
const repositoryRun = startRepositoryRun();

test('clause 1: the repository static style command enforces its source rules [C7]', async () => {
  const { child, wallMs } = await repositoryRun;
  console.log(JSON.stringify({ staticProgramWallMs: wallMs, status: child.status }));
  assert.equal(child.status, 0, child.failure ?? ((child.stdout ?? '') + (child.stderr ?? '')));
});

test('clause 1: the static checks read every source file for one import binding per line [C7]', async t => {
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const child = await recursiveRun;
  assert.equal(child.status, 1, child.failure ?? ((child.stdout ?? '') + (child.stderr ?? '')));
  assert.ok(child.stderr.includes(`${nested}:1: one import binding per line`), child.stderr);
});
