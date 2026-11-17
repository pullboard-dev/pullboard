/** A C++ CMake project goes through init, add, claim, commit, submit, the ctest gate and land on a scratch board [C7,#10515,#3705]. */
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { after } from 'node:test';
import { test } from 'node:test';
import { createE2eHelpers } from '../../tests/fixtures/e2e.js';
import { BROKEN } from '../../tests/fixtures/languages/cpp.js';
import { CMAKE } from '../../tests/fixtures/languages/cpp.js';
import { PASSING } from '../../tests/fixtures/languages/cpp.js';
import { UNAVAILABLE } from '../../tests/fixtures/languages/cpp.js';
import { acceptAndLand } from '../../tests/fixtures/languages/cpp.js';
import { buildAndSubmit } from '../../tests/fixtures/languages/cpp.js';
import { cmakeBoard } from '../../tests/fixtures/languages/cpp.js';
import { cmakeSandbox } from '../../tests/fixtures/languages/cpp.js';
import { writeProject } from '../../tests/fixtures/languages/cpp.js';

const helpers = createE2eHelpers();
after(helpers.cleanup);

test('clause 1: init in a copy of the scratch CMake project records its ctest command as the gate [C7,#10515]', { timeout: 240_000 }, async (t) => {
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

test('clause 2: a submitted commit with a failing ctest case is refused red and the refusal names the case [C7,#10515]', { timeout: 240_000 }, async (t) => {
  if (!CMAKE) return t.skip(UNAVAILABLE);
  const board = await cmakeBoard(helpers);
  const red = await buildAndSubmit(board, null, BROKEN);
  assert.match(red.shown.out, /GATE_RED/u, red.text);
  assert.match(red.text, /adds_small_numbers/u);
});

test('clause 3: the fixed commit passes ctest, is accepted and lands on the scratch board main [C7,#10515]', { timeout: 240_000 }, async (t) => {
  if (!CMAKE) return t.skip(UNAVAILABLE);
  const board = await cmakeBoard(helpers);
  const fixed = await buildAndSubmit(board, null, PASSING);
  assert.equal(fixed.status, 'submitted', fixed.text);
  const { landing, settled } = await acceptAndLand(board, fixed.item, fixed.commit);
  assert.deepEqual(settled.landed, [Number(fixed.item)], `${landing.out}${landing.err}`);
  assert.equal(board.box.git(board.repo, 'show', 'main:tests/item_test.cpp'), PASSING.trimEnd());
});
