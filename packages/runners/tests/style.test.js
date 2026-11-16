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

// One static run serves both cases: the copy holds the repository plus one planted multi-binding import, so the planted
// line must be the only finding for the repository itself to be clean (a second full run cost the file 60+ s).
let shared;
const staticRun = () => (shared ??= startRecursiveRun());
const planted = `${nested}:1: one import binding per line`;
const findings = child => (child.stderr ?? '').split('\n').filter(line => /^\S+:\d+: /.test(line));

test('clause 1: the repository static style command enforces its source rules [C7]', async t => {
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const before = performance.now();
  const child = await staticRun();
  console.log(JSON.stringify({ staticProgramWallMs: performance.now() - before, status: child.status }));
  assert.deepEqual(findings(child).filter(line => !line.startsWith(planted)), [], child.stderr);
});

test('clause 1: the static checks read every source file for one import binding per line [C7]', async () => {
  const child = await staticRun();
  assert.equal(child.status, 1, child.failure ?? ((child.stdout ?? '') + (child.stderr ?? '')));
  assert.ok(child.stderr.includes(planted), child.stderr);
});
