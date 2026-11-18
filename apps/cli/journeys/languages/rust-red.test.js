/** Landing names the failing Rust test when main moved past a green submit and broke it [C7,#10387,#10385]. */
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { after } from 'node:test';
import { test } from 'node:test';
import { createE2eHelpers } from '../../tests/fixtures/e2e.js';
import { settleLand } from '../../tests/fixtures/land/settle.js';
import { verifySettled } from '../../tests/fixtures/submit/settle.js';
import { CARGO } from '../../tests/fixtures/languages/rust.js';
import { CHECK } from '../../tests/fixtures/languages/rust.js';
import { MATH } from '../../tests/fixtures/languages/rust.js';
import { PASSING } from '../../tests/fixtures/languages/rust.js';
import { UNAVAILABLE } from '../../tests/fixtures/languages/rust.js';
import { buildAndSubmit } from '../../tests/fixtures/languages/rust.js';
import { crateBoard } from '../../tests/fixtures/languages/rust.js';

const helpers = createE2eHelpers();
after(helpers.cleanup);

test('cli.journeys-languages-rust-red.landing-names-the-failing-rust-test: landing names the failing Rust test when main moved past a green submit and broke it [C7,#10387,#10385]', { timeout: 420_000 }, async (t) => {
  if (!CARGO) return t.skip(UNAVAILABLE);
  const board = await crateBoard(helpers);
  const built = await buildAndSubmit(board, null, PASSING);
  assert.equal(built.status, 'submitted', built.text);
  const { box, repo } = board;
  box.git(repo, 'switch', '-q', '--detach', built.commit);
  const verdict = await verifySettled(box, box.runLocal, repo, ['verify', built.item, 'accept', '--as', 'coordinator', '--note', 'scratch crate gate is green']);
  box.git(repo, 'switch', '-q', 'main');
  assert.equal(verdict.code, 0, verdict.err);
  // Main moves past the submit: add now multiplies, which the item's test (and only it) catches in the merged tree.
  writeFileSync(join(repo, 'src/math.rs'), MATH.replace('a + b', 'a * b'));
  box.git(repo, 'add', '-A');
  const moved = box.tryGit(repo, 'commit', '-q', '-m', 'chore(web): add multiplies [G1]');
  assert.equal(moved.status, 0, moved.stderr);
  const landing = await box.runIn(repo, 'land', '--json');
  const settled = await settleLand(box, JSON.parse(landing.out), { deadlineMs: 100_000 });
  assert.deepEqual(settled.landed, [], `${landing.out}${landing.err}`);
  const shown = await box.runLocal(repo, 'show', built.item);
  assert.doesNotMatch(CHECK, /adds_small_numbers/u);
  assert.match(shown.out, /Land job \S+ red:[\s\S]*item::adds_small_numbers/u);
});
