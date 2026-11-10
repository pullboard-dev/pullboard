/** @pullboard-test-input source-tree */
/** Exercise the native train producer, ordered landing writer and additive push check [C7]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as store from '../../../../packages/store/index.js';
import { pushedFirstParentCommits } from '../../../../packages/git/index.js';
import { runFixtureChild } from '../../tests/fixtures/child.js';
import { safeFixtureDiagnostic } from '../../tests/fixtures/child.js';
import { fixture } from '../../tests/fixtures/landing/receipts.js';
import { verifiedItem } from '../../tests/fixtures/landing/receipts.js';
import { sideCheckout } from '../../tests/fixtures/landing/receipts.js';
import { gate } from '../../tests/fixtures/landing/receipts.js';
import { audit } from '../../tests/fixtures/landing/receipts.js';
import { onBoard } from '../../tests/fixtures/landing/receipts.js';
import { nativePushReceiptProblems } from '../../tests/fixtures/landing/receipts.js';

test('one real native envelope covers multiple reviewed sources and only its first-parent commit needs a receipt [C7,B3]', async t => {
  process.stderr.write('train envelope phase: fixture setup\n');
  const box = fixture(t);
  process.stderr.write('train envelope phase: fixture ready\n');
  const sidePath = sideCheckout(box, box.base);
  const ids = [verifiedItem(box, 1, sidePath), verifiedItem(box, 2, sidePath)];
  process.stderr.write('train envelope phase: reviewed sources ready\n');
  const side = box.git(sidePath, 'rev-parse', 'HEAD').trim();
  const options = { base: box.base, side,
    items: onBoard(box, board => ids.map(id => ({ id, commit: store.getItem(board, id).item_commit }))),
    message: `chore: retain the actual multi-item envelope\n\nPullboard-Migration: ${box.base}` };
  // The envelope is made where a landing makes it: the primary checkout, detached at the side tip, with no board write.
  box.git(box.repo, 'checkout', '-q', '--detach', side);
  const made = runFixtureChild(process.execPath, ['--input-type=module', '-e',
    `import {createLandingEnvelope} from ${JSON.stringify(new URL('../../../../packages/landing/index.js', import.meta.url).href)}; console.log(JSON.stringify(createLandingEnvelope(process.cwd(),${JSON.stringify(options)})));`],
  { cwd: box.repo, env: box.env, encoding: 'utf8' });
  assert.equal(made.status, 0, `${made.stdout}${made.stderr}`);
  const envelope = JSON.parse(made.stdout);
  process.stderr.write('train envelope phase: envelope created\n');
  box.git(box.repo, 'checkout', '-q', 'main');
  box.git(box.repo, 'merge', '--ff-only', envelope.tip);
  assert.equal(box.git(box.repo, 'rev-parse', 'HEAD^1').trim(), box.base);
  assert.equal(box.git(box.repo, 'rev-parse', 'HEAD^2').trim(), side);
  process.stderr.write('train envelope phase: native landing gate start\n');
  const receipt = gate(box);
  process.stderr.write('train envelope phase: native landing gate returned\n');
  const landed = box.run(box.repo, 'merged', String(ids[0]), envelope.tip,
    '--items', ids.join(','), '--gate-receipt', receipt.id, '--json');
  // Preserve a native refusal before asynchronous fixture audit cleanup can delay its failed assertion.
  if (landed.code !== 0) {
    let refusal;
    try { refusal = JSON.parse(landed.out).error; } catch { refusal = landed.out.slice(0, 12000); }
    process.stderr.write(safeFixtureDiagnostic(`train envelope merged refusal: ${JSON.stringify({ code: landed.code, refusal, stderr: landed.err.slice(0, 12000) })}\n`, box.env));
  }
  process.stderr.write('train envelope phase: merged returned\n');
  assert.equal(landed.code, 0, `${landed.out}${landed.err}`);
  const batch = JSON.parse(landed.out).batch;
  assert.deepEqual(onBoard(box, board => store.landingBatches(board)[0].migration),
    { version: 1, publishedBase: box.base, side, tip: envelope.tip });
  assert.deepEqual(onBoard(box, board => ids.map(id => store.getItem(board, id).item_merged_commit)), ids.map(() => envelope.tip));
  const range = pushedFirstParentCommits(box.repo, `refs/heads/main ${envelope.tip} refs/heads/main ${box.base}\n`);
  assert.deepEqual(range, [envelope.tip]);
  process.stderr.write('train envelope phase: audit start\n');
  await audit(box, batch);
  process.stderr.write('train envelope phase: audit returned\n');
  assert.deepEqual(onBoard(box, board => nativePushReceiptProblems(box.repo, board, range)), []);
});
