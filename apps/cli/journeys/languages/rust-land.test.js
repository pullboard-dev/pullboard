/** The fixed Rust commit passes the cargo test gate, is accepted and lands on the scratch board main [C7,#10387]. */
import assert from 'node:assert/strict';
import { after } from 'node:test';
import { test } from 'node:test';
import { createE2eHelpers } from '../../tests/fixtures/e2e.js';
import { CARGO } from '../../tests/fixtures/languages/rust.js';
import { PASSING } from '../../tests/fixtures/languages/rust.js';
import { UNAVAILABLE } from '../../tests/fixtures/languages/rust.js';
import { acceptAndLand } from '../../tests/fixtures/languages/rust.js';
import { buildAndSubmit } from '../../tests/fixtures/languages/rust.js';
import { crateBoard } from '../../tests/fixtures/languages/rust.js';

const helpers = createE2eHelpers();
after(helpers.cleanup);

test('cli.journeys-languages-rust-land.the-fixed-commit-passes-cargo-test: clause 3: the fixed commit passes cargo test, is accepted and lands on the scratch board main [C7,#10387]', { timeout: 240_000 }, async (t) => {
  if (!CARGO) return t.skip(UNAVAILABLE);
  const board = await crateBoard(helpers);
  const fixed = await buildAndSubmit(board, null, PASSING);
  assert.equal(fixed.status, 'submitted', fixed.text);
  const { landing, settled } = await acceptAndLand(board, fixed.item, fixed.commit);
  assert.deepEqual(settled.landed, [Number(fixed.item)], `${landing.out}${landing.err}`);
  const main = board.box.git(board.repo, 'show', 'main:src/item.rs');
  assert.equal(main, PASSING.trimEnd());
});
