/** @pullboard-test-input apps/cli/src/io/static/checks.js packages/gate/tests/fixtures/budgets.js packages/codemap/src/io/source/inventory.js packages/gate/src/io/static/style.js */
/** The actual repository preflight keeps source oracles separate from browser behavior [C7]. */
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { mkdtempSync } from 'node:fs';
import { rmSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { test } from 'node:test';
import { runFixtureChild } from '../../gate/tests/fixtures/child.js';

const repository = resolve(import.meta.dirname, '../../..');
const vmArgs = ['--experimental-vm-modules', '--disable-warning=ExperimentalWarning'];

test('clause 1: the repository static style command enforces its source rules [C7]', () => {
  const before = performance.now();
  const child = runFixtureChild(process.execPath,
    [...vmArgs, 'apps/cli/src/io/static/checks.js'], { cwd: repository, encoding: 'utf8' });
  console.log(JSON.stringify({ staticProgramWallMs: performance.now() - before, status: child.status }));
  assert.equal(child.status, 0, child.failure ?? ((child.stdout ?? '') + (child.stderr ?? '')));
});

test('clause 1: the import-style check finds violations in nested sources [C7]', t => {
  const root = mkdtempSync(join(tmpdir(), 'pullboard-static-style-recursive-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const nested = 'apps/cli/src/io/nested/import-style-fixture.js';
  mkdirSync(join(root, 'apps/cli/src/io/nested'), { recursive: true });
  writeFileSync(join(root, nested), "import { strict as assert, equal } from 'node:assert';\nvoid assert; void equal;\n");

  // Use the preflight's source inventory and parser on the small fixture. The clean case runs the full preflight.
  const program = `
    import { styleSources } from './packages/codemap/index.js';
    import { importStyleViolations } from './packages/gate/index.js';
    const rows = importStyleViolations(styleSources(process.argv[1]));
    for (const row of rows) {
      console.error(row.file + ':' + row.line + ': one import binding per line (' + row.count + ' bindings)');
    }
    process.exitCode = rows.length > 0 ? 1 : 0;
  `;
  const child = runFixtureChild(process.execPath,
    [...vmArgs, '--input-type=module', '-e', program, root], { cwd: repository, encoding: 'utf8' });
  assert.equal(child.status, 1, child.failure ?? ((child.stdout ?? '') + (child.stderr ?? '')));
  assert.ok(child.stderr.includes(`${nested}:1: one import binding per line`), child.stderr);
});
