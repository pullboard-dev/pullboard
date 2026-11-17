/** @pullboard-world-pin: clauses 1 and 2 read the committed package.json, because its scripts must name files that exist in this repository. */
/** Every file a package.json script names exists, the checker flags one that does not, and the hosted-shapes script is gone [C7]. */
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { resolve } from 'node:path';
import { test } from 'node:test';
import { privateFixtureFiles } from './fixtures/child.js';

const ROOT = resolve(import.meta.dirname, '../../..');

/** The script names and file paths in a package.json under `root` whose path does not exist there. */
function missingScriptPaths(root) {
  const { scripts } = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
  return Object.entries(scripts).flatMap(([name, command]) => command.split(/\s+/u)
    .filter(word => /^[\w./-]+\.(?:js|mjs|json)$/u.test(word) && !existsSync(join(root, word))).map(path => `${name}: ${path}`));
}

test('gate.package-scripts.every-file-path-package-json: clause 1: every file path a package.json script names exists on main [C7]', () => {
  assert.deepEqual(missingScriptPaths(ROOT), []);
});

test('gate.package-scripts.checker-flags-script-names-file: clause 1: the checker flags a script that names a file missing from a synthetic package [C7]', () => {
  const fixture = privateFixtureFiles('pullboard-package-scripts-');
  fixture.write('package.json', JSON.stringify({ scripts: { ok: 'node tests/present.test.js', broken: 'node tests/missing-example.test.js' } }));
  fixture.write('tests/present.test.js', '');
  assert.deepEqual(missingScriptPaths(fixture.root), ['broken: tests/missing-example.test.js']);
});

test('gate.package-scripts.live-test-covers-hosted-shapes: clause 2: no live test covers the hosted shapes, so the hosted-shapes script is removed rather than repointed [C7]', () => {
  const { scripts } = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
  assert.equal(Object.hasOwn(scripts, 'hosted-shapes'), false);
});
