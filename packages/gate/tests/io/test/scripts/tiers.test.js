/** @pullboard-test-input packages/gate/data/tests/tiers.json packages/gate/src/io/test/scripts/tiers.js */
/** Test-tier generation inspects real repository source without executing candidate tests [C7,CS4,CD44,CD47]. */
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { mkdtempSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import { rmSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname } from 'node:path';
import { join } from 'node:path';
import { test } from 'node:test';
import { generateTestTiers } from '../../../../index.js';
import { writeTestTiers } from '../../../../index.js';
import { runFixtureChild } from '../../../../../../apps/cli/tests/fixtures/child.js';
import { runFixtureGit } from '../../../../../../apps/cli/tests/fixtures/child.js';
import { fileURLToPath } from 'node:url';

const command = fileURLToPath(new URL('../../../../src/io/test/scripts/tiers.js', import.meta.url));

/** Write only synthetic sources in a private Git repository, never running those candidate modules. */
function fixture(t, sources) {
  const root = mkdtempSync(join(tmpdir(), 'pullboard-test-tiers-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  runFixtureGit(['init', '-q'], { cwd: root });
  for (const [file, source] of Object.entries({ 'package.json': '{"type":"module"}', ...sources })) {
    mkdirSync(dirname(join(root, file)), { recursive: true });
    writeFileSync(join(root, file), source);
  }
  return root;
}

/** Read one generated row by its stable repository-relative identity. */
function row(manifest, file) { return manifest.files.find(row => row.file === file); }

test('single-package purity, cross-package imports and git spawning select T1, T3 and T3 [C7,CS4,CD44]', t => {
  const root = fixture(t, {
    'packages/math/index.js': 'export const add = (a,b) => a+b;',
    'packages/text/index.js': 'export const title = "text";',
    'test/unit.test.js': 'import { add } from "../packages/math/index.js"; import assert from "node:assert/strict"; assert.equal(add(1,2),3);',
    'test/cross.test.js': 'import "../packages/math/index.js"; import "../packages/text/index.js";',
    'test/git.test.js': 'import "../packages/math/index.js"; import { spawnSync as run } from "node:child_process"; run("git", ["status"]);',
    'test/unused.test.js': 'import "../packages/math/index.js"; import { spawnSync } from "node:child_process";',
  });
  const report = generateTestTiers(root);
  assert.equal(report.files.length, 4);
  assert.equal(row(report, 'test/unit.test.js').tier, 'T1');
  assert.deepEqual(row(report, 'test/unit.test.js').packages, ['packages/math']);
  assert.equal(row(report, 'test/cross.test.js').tier, 'T3');
  assert.equal(row(report, 'test/git.test.js').tier, 'T3');
  assert.equal(row(report, 'test/unused.test.js').tier, 'T1');
  assert.match(row(report, 'test/git.test.js').reasons.join(' '), /process/u);
});

test('helper-hidden boards and processes, browser and runner calls remain journeys [C7,CS4,CD47]', t => {
  const root = fixture(t, {
    'packages/math/index.js': 'export const n = 1;',
    'test/helper.js': 'import { spawnSync } from "node:child_process"; export const git = () => spawnSync("git");',
    'test/hidden.test.js': 'import "../packages/math/index.js"; import { git } from "./helper.js"; git();',
    'test/board.test.js': 'import "../packages/math/index.js"; fake.openBoard(":memory:");',
    'test/browser.test.js': 'import "../packages/math/index.js"; chromium.launch();',
    'test/runner.test.js': 'import "../packages/math/index.js"; runRunner();',
    'test/computed.test.js': 'import(where);',
    'test/escaped.test.js': 'import "../packages/math/index.js"; requ\\u0069re("node:child_process");',
    'test/quoted.test.js': 'import "../packages/math/index.js"; const text = "openBoard(); spawnSync()"; /* chromium.launch() */',
  });
  const report = generateTestTiers(root);
  for (const name of ['hidden', 'board', 'browser', 'runner', 'computed', 'escaped']) assert.equal(row(report, `test/${name}.test.js`).tier, 'T3', name);
  assert.equal(row(report, 'test/quoted.test.js').tier, 'T1', 'fixture source in comments and strings does not spawn infrastructure');
});

test('literal CommonJS imports and flat packages retain their unit ownership [C7,CS4]', t => {
  const root = fixture(t, {
    'lib/value.cjs': 'module.exports = 1;',
    'test/unit.test.cjs': 'const value = require("../lib/value.cjs"); require("assert").equal(value, 1);',
    'test/git.test.cjs': 'require("child_process").execFileSync("git", ["status"]);',
  });
  const report = generateTestTiers(root);
  assert.equal(row(report, 'test/unit.test.cjs').tier, 'T1');
  assert.deepEqual(row(report, 'test/unit.test.cjs').packages, ['.']);
  assert.equal(row(report, 'test/git.test.cjs').tier, 'T3');
});

test('the same generation command is byte-stable and check mode exposes class changes [C7,CS4,CD44]', t => {
  const root = fixture(t, {
    'packages/math/index.js': 'export const n = 1;',
    'test/unit.test.js': 'import "../packages/math/index.js";',
  });
  const run = (...args) => runFixtureChild(process.execPath, [command, ...args, root], { cwd: root, encoding: 'utf8' });
  assert.equal(run().status, 0);
  const before = readFileSync(join(root, 'packages/gate/data/tests/tiers.json'), 'utf8');
  assert.equal(run().status, 0);
  assert.equal(readFileSync(join(root, 'packages/gate/data/tests/tiers.json'), 'utf8'), before);
  assert.equal(run('--check').status, 0);
  writeFileSync(join(root, 'test/unit.test.js'), 'import "../packages/math/index.js"; import { spawnSync } from "node:child_process"; spawnSync("git");');
  assert.equal(run('--check').status, 1);
  assert.equal(readFileSync(join(root, 'packages/gate/data/tests/tiers.json'), 'utf8'), before, 'checking never rewrites the reviewed manifest');
  assert.equal(writeTestTiers(root).manifest.files[0].tier, 'T3');
});
