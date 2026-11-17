/** The scripted version probe loads nothing and touches no machine home; plain --version keeps the compile cache [C7]. */
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { readdirSync } from 'node:fs';
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { privateFixtureFiles } from '../../fixtures/child.js';
import { runVersionAt } from '../../fixtures/compile-cache.js';

/** The release the entry reports, taken from the plain probe so the test reads no repository file; the plain probe's own home is thrown away. */
function plainRelease() {
  const home = privateFixtureFiles('pullboard-version-plain-').root;
  try {
    const result = runVersionAt(home, ['--version']);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout.trim(), /^\d+\.\d+\.\d+/u);
    return result.stdout.trim();
  } finally { rmSync(home, { recursive: true, force: true }); }
}
const release = plainRelease();

test('clause 1: --version --json prints the exact release document with a fresh machine home [C7]', () => {
  const home = privateFixtureFiles('pullboard-version-probe-').root;
  try {
    const result = runVersionAt(home, ['--version', '--json']);
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout), { version: 1, release });
    assert.equal(result.stdout, `${JSON.stringify({ version: 1, release }, null, 2)}\n`);
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test('clause 2: --version --json leaves no compile-cache folder in the machine home [C7]', () => {
  const home = privateFixtureFiles('pullboard-version-probe-').root;
  try {
    assert.equal(runVersionAt(home, ['--version', '--json']).status, 0);
    assert.equal(existsSync(join(home, 'compile-cache')), false, readdirSync(home).join());
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test('clause 3: plain --version still enables the compile cache in the machine home [C7]', () => {
  const home = privateFixtureFiles('pullboard-version-probe-').root;
  try {
    const result = runVersionAt(home, ['--version']);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout.trim(), release);
    assert.ok(existsSync(join(home, 'compile-cache')), 'the plain probe creates its compile cache folder');
  } finally { rmSync(home, { recursive: true, force: true }); }
});
