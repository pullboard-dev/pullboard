/** Init in a copy of a Rust crate records cargo test as the gate [C7,#10387]. */
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { after } from 'node:test';
import { test } from 'node:test';
import { createE2eHelpers } from '../../../fixtures/e2e.js';
import { CARGO } from '../../../fixtures/languages/rust.js';
import { UNAVAILABLE } from '../../../fixtures/languages/rust.js';
import { cargoSandbox } from '../../../fixtures/languages/rust.js';
import { writeCrate } from '../../../fixtures/languages/rust.js';

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
