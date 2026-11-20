/** A C-only CMake project compiled with cc goes through init, add, claim, commit, submit, the ctest gate and land on a scratch board [C7,#10780,#3705]. */
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { after } from 'node:test';
import { test } from 'node:test';
import { createE2eHelpers } from '../../tests/fixtures/e2e.js';
import { CMAKE } from '../../tests/fixtures/languages/c.js';
import { UNAVAILABLE } from '../../tests/fixtures/languages/c.js';
import { cmakeSandbox } from '../../tests/fixtures/languages/c.js';
import { writeProject } from '../../tests/fixtures/languages/c.js';

const helpers = createE2eHelpers();
after(helpers.cleanup);

test('cli.journeys-languages-c.init-records-ctest-as-the-gate: clause 1: init in a copy of the scratch C-only CMake project records its ctest command as the gate [C7,#10780]', { timeout: 240_000 }, async (t) => {
  if (!CMAKE) return t.skip(UNAVAILABLE);
  const box = cmakeSandbox(helpers);
  const repo = join(box.dir, 'project');
  mkdirSync(repo);
  box.git(repo, 'init', '-q', '-b', 'main');
  writeProject(repo);
  const initialized = await box.runLocal(repo, 'init', '--json');
  assert.equal(initialized.code, 0, initialized.err);
  const config = JSON.parse(readFileSync(join(repo, 'pullboard.json'), 'utf8'));
  assert.match(String(config.gate?.command ?? config.gate), /ctest --test-dir build/u);
});
