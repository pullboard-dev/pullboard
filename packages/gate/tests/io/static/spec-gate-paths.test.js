/** Real SPEC.md rows naming absent gate files form a shrinking exception set; a new absent gate file fails [C7]. */
/** @pullboard-world-pin reads the real SPEC.md and the gate files it names to list the absent ones. */
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { rmSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { privateFixtureFiles } from '../../fixtures/child.js';
import { runFixtureGit } from '../../fixtures/child.js';
import { missingGateFindings } from '../../../../spec/index.js';
import { parseSpec } from '../../../../spec/index.js';

const ROOT = new URL('../../../../../', import.meta.url);

/** Rows whose gate file does not exist yet (never written: S4 warns, so they are listed, not errors); remove an id when its file lands. */
const ABSENT = {
  A10: 'test/cockpit.test.js',
  B33: 'test/cockpit.test.js',
  H20: 'packages/state/tests/relay-storage-quota.test.js',
  H29: 'test/cloud-board.test.js',
  N33: 'test/cockpit.test.js',
  N36: 'test/cockpit.test.js',
  N38: 'test/cockpit.test.js',
  P7: 'test/durable-chaos-26.test.js',
  Q10: 'test/procedures.test.js',
  Q11: 'test/procedures.test.js',
  Q5: 'test/procedures.test.js',
  Q6: 'test/procedures.test.js',
  Q7: 'test/procedures.test.js',
  Q8: 'test/procedures.test.js',
  Q9: 'test/procedures.test.js',
  R4: 'test/upgrade-chain.test.js',
};

/** Every real SPEC.md row's absent gate test file, as `id -> path`. */
function absentGates() {
  const found = {};
  for (const row of parseSpec(readFileSync(new URL('SPEC.md', ROOT), 'utf8')).rows) {
    for (const file of row.gate.match(/[\w./-]+\.test\.js/gu) ?? []) {
      if (!existsSync(new URL(file, ROOT))) found[row.id] = file;
    }
  }
  return found;
}

test('clause 2 [C7]: the real SPEC.md rows naming absent gate files are exactly the listed exception set', () => {
  assert.deepEqual(absentGates(), ABSENT, 'a new absent gate file, or a landed one still listed, changes this set');
});

test('clause 1 [C7]: an approved must-row whose committed gate file was removed is an error naming the removal', () => {
  const fixture = privateFixtureFiles('gate-paths-');
  try {
    const run = (...args) => runFixtureGit(['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { cwd: fixture.root, encoding: 'utf8' });
    run('init', '-q');
    fixture.write('test/x.test.js', '');
    run('add', '-A');
    run('commit', '-q', '-m', 'add');
    run('rm', '-q', 'test/x.test.js');
    run('commit', '-q', '-m', 'remove');
    const spec = parseSpec('# S\n## A · Rows\n- A1 [approved, must] A thing holds. | gate: test/x.test.js\n');
    const found = missingGateFindings(spec, fixture.root);
    assert.deepEqual(found.map(finding => [finding.level, finding.id]), [['error', 'A1']]);
    assert.match(found[0].message, /was removed from the repository/u);
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});
