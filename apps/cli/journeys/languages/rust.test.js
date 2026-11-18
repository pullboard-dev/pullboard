/** A Rust crate goes through init, add, claim, commit, submit, the cargo test gate and land on a scratch board [C7,#10387,#3705]. */
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { after } from 'node:test';
import { test } from 'node:test';
import { createE2eHelpers } from '../../tests/fixtures/e2e.js';
import { BROKEN } from '../../tests/fixtures/languages/rust.js';
import { CARGO } from '../../tests/fixtures/languages/rust.js';
import { CHECK } from '../../tests/fixtures/languages/rust.js';
import { UNAVAILABLE } from '../../tests/fixtures/languages/rust.js';
import { buildAndSubmit } from '../../tests/fixtures/languages/rust.js';
import { cargoSandbox } from '../../tests/fixtures/languages/rust.js';
import { crateBoard } from '../../tests/fixtures/languages/rust.js';
import { writeCrate } from '../../tests/fixtures/languages/rust.js';

const helpers = createE2eHelpers();
after(helpers.cleanup);

test('cli.journeys-languages-rust.init-in-a-copy-of-the: clause 1: init in a copy of the scratch crate records cargo test as the gate [C7,#10387]', { timeout: 240_000 }, async (t) => {
  if (!CARGO) return t.skip(UNAVAILABLE);
  const box = cargoSandbox(helpers);
  const repo = join(box.dir, 'crate');
  mkdirSync(repo);
  box.git(repo, 'init', '-q', '-b', 'main');
  writeCrate(repo);
  const initialized = await box.runLocal(repo, 'init', '--json');
  assert.equal(initialized.code, 0, initialized.err);
  const config = JSON.parse(readFileSync(join(repo, 'pullboard.json'), 'utf8'));
  assert.equal(String(config.gate?.command ?? config.gate), 'cargo test');
});

test('cli.journeys-languages-rust.a-submitted-commit-with-a-failing: clause 2: a submitted commit with a failing Rust test is refused red and the refusal names the test [C7,#10387]', { timeout: 240_000 }, async (t) => {
  if (!CARGO) return t.skip(UNAVAILABLE);
  const board = await crateBoard(helpers);
  const red = await buildAndSubmit(board, null, BROKEN);
  assert.match(red.shown.out, /GATE_RED/u, red.text);
  assert.doesNotMatch(CHECK, /adds_small_numbers/u);
  assert.match(red.text, /adds_small_numbers/u);
});
