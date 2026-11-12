/** The cells plan commands read only tracked source, so an ignored scratch file cannot break them [C7,D3]. */
import assert from 'node:assert/strict';
import { appendFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { computePlan } from '../../../../../packages/codemap/index.js';
import { importCuts } from '../../../../../packages/codemap/index.js';
import { writePlan } from '../../../../../packages/codemap/index.js';
import { fixture } from '../../../../../packages/landing/tests/fixtures/plan.js';
import { git } from '../../../../../packages/landing/tests/fixtures/plan.js';
import { runFixtureChild } from '../../../tests/fixtures/child.js';

const BIN = fileURLToPath(new URL('../../../../../packages/codemap/src/io/cells/scripts/plan.js', import.meta.url));

/** Run one plan command in the fixture checkout. */
const plan = (root, mode) => {
  const cell = mode === '--cuts' ? [importCuts(computePlan(root))[0].cell] : [];
  return runFixtureChild(process.execPath, [BIN, mode, ...cell], { cwd: root, encoding: 'utf8' });
};

/** A fixture with its plan committed, so --cuts and --check start green. */
function committed(t) {
  const box = fixture(t);
  writePlan(box.root, computePlan(box.root));
  git(box.root, 'add', '-A');
  git(box.root, 'commit', '-q', '-m', 'frozen fixture plan');
  return box;
}

test('an ignored, non-module script leaves --cuts and --check green [C7,D3]', t => {
  const { root, put } = committed(t);
  appendFileSync(join(root, '.git', 'info', 'exclude'), 'scratch/\n');
  put('scratch/probe.js', "const fs = require('fs');\nmodule.exports = fs.readFileSync(__filename);\n");
  put('src/untracked-note.js', "module.exports = require('./nowhere');\n");
  for (const mode of ['--cuts', '--check']) {
    const run = plan(root, mode);
    assert.equal(run.status, 0, `${mode}: ${run.stderr}`);
  }
});

test('a tracked file that does not parse as an ES module fails and names its path [C7,D3]', t => {
  const { root, put } = committed(t);
  put('src/broken.js', "const fs = require('fs');\nmodule.exports = fs;\n");
  git(root, 'add', 'src/broken.js');
  for (const mode of ['--cuts', '--check']) {
    const run = plan(root, mode);
    assert.notEqual(run.status, 0, `${mode} must fail`);
    assert.match(run.stderr, /src\/broken\.js/u, `${mode}: ${run.stderr}`);
  }
});
