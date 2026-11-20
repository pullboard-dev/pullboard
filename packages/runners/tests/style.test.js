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
import { runFixtureChildAsync } from '../../gate/tests/fixtures/child.js';
import { copyPackageFiles } from '../index.js';

const repository = resolve(import.meta.dirname, '../../..');
const ARGS = ['--experimental-vm-modules', '--disable-warning=ExperimentalWarning', 'apps/cli/src/io/static/checks.js'];
const nested = 'apps/cli/src/io/nested/import-style-fixture.js';
const root = mkdtempSync(join(tmpdir(), 'pullboard-static-style-recursive-'));
after(() => rmSync(root, { recursive: true, force: true }));

/** Build the nested-file tree: the repository's package files, the budgets fixture, pullboard.json and one planted file, committed in a private git repository. */
function plantedTree() {
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
}

// Both cases run the whole static program; they start together so the file costs the longer run, not the sum [C7].
const started = performance.now();
const repositoryRun = runFixtureChildAsync(process.execPath, ARGS, { cwd: repository, encoding: 'utf8' });
plantedTree();
const nestedRun = runFixtureChildAsync(process.execPath, ARGS, { cwd: root, encoding: 'utf8' });

test('runners.style.the-repository-static-style-command-enforces: the repository static style command enforces its source rules [C7]', async () => {
  const child = await repositoryRun;
  console.log(JSON.stringify({ staticProgramWallMs: performance.now() - started, status: child.status }));
  assert.equal(child.status, 0, child.failure ?? ((child.stdout ?? '') + (child.stderr ?? '')));
});

test('runners.style.the-static-checks-read-every-source: the static checks read every source file for one import binding per line [C7]', async () => {
  const child = await nestedRun;
  assert.equal(child.status, 1, child.failure ?? ((child.stdout ?? '') + (child.stderr ?? '')));
  assert.ok(child.stderr.includes(`${nested}:1: one import binding per line`), child.stderr);
});
