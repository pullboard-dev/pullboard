/** @pullboard-world-pin: both clauses read the committed package.json, because its scripts must name files that exist in this repository. */
/** Every file a package.json script names exists, and the hosted-shapes script whose test was deleted by #8151 is gone [C7]. */
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { resolve } from 'node:path';
import { test } from 'node:test';

const ROOT = resolve(import.meta.dirname, '../../..');
const scripts = Object.entries(JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).scripts);

test('clause 1: every file path a package.json script names exists on main [C7]', () => {
  assert.ok(scripts.length > 0, 'the package has scripts to check');
  for (const [name, command] of scripts) {
    const paths = command.split(/\s+/u).filter(word => /^[\w./-]+\.(?:js|mjs|json)$/u.test(word));
    for (const path of paths) assert.ok(existsSync(join(ROOT, path)), `script ${name} names ${path}, which is missing`);
  }
});

test('clause 2: no live test covers the hosted shapes, so the hosted-shapes script is removed rather than repointed [C7]', () => {
  assert.equal(scripts.some(([name]) => name === 'hosted-shapes'), false);
  assert.equal(existsSync(join(ROOT, 'apps/cli/journeys/relay/hosted/shapes.test.js')), false);
});
