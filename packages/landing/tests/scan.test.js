/** The named landing's runner-side scan finds a composed module that does not parse, and reports a checkout it cannot read [C7,#5559]. */
import assert from 'node:assert/strict';
import {
  rmSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import {
  privateFixtureFiles,
  runFixtureGit,
} from '../../gate/tests/fixtures/child.js';
import {
  SCAN_UNAVAILABLE,
  scanLanding,
} from '../src/io/scan.js';

/** A real repo whose base holds one module; `commit` adds a second at a new commit and leaves it checked out. */
function repo(t) {
  const { root } = privateFixtureFiles('landing-scan-');
  const sh = (...args) => runFixtureGit(args, { cwd: root });
  sh('init', '-q', '-b', 'main');
  sh('config', 'user.email', 't@example.com');
  sh('config', 'user.name', 't');
  writeFileSync(join(root, 'a.js'), 'export const a = 1;\n');
  sh('add', '-A');
  sh('commit', '-q', '-m', 'base');
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const commit = (file, source) => {
    writeFileSync(join(root, file), source);
    sh('add', '-A');
    sh('commit', '-q', '-m', `add ${file}`);
    return sh('rev-parse', 'HEAD');
  };
  return { root, base: sh('rev-parse', 'HEAD'), commit };
}

test('scanLanding reports a composed module that does not parse as a file:line row [C7,#5559]', async t => {
  const { root, base, commit } = repo(t);
  const tip = commit('b.js', "import { a } from './a.js';\nimport { a } from './a.js';\nexport const b = a;\n");
  const rows = await scanLanding(root, base, tip);
  assert.equal(rows.length, 1);
  assert.match(rows[0], /^b\.js:1: LAND_MODULE_PARSE /u);
});

test('scanLanding is clean for a composed tree whose modules parse [C7,#5559]', async t => {
  const { root, base, commit } = repo(t);
  const tip = commit('b.js', "import { a } from './a.js';\nexport const b = a;\n");
  assert.deepEqual(await scanLanding(root, base, tip), []);
});

test('scanLanding reports it cannot read a tip that is not this checkout [C7,#5559]', async t => {
  const { root, base, commit } = repo(t);
  const tip = commit('b.js', 'export const b = 1;\n');
  assert.equal(await scanLanding(root, base, base), SCAN_UNAVAILABLE, 'the checked-out tree is not the named tip');
  assert.equal(await scanLanding(root, base, '0'.repeat(40)), SCAN_UNAVAILABLE, 'an unknown commit');
  assert.notEqual(tip, base);
});
