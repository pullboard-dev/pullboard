/** @pullboard-test-input source-tree */
/** Exercise the native train producer, ordered landing writer and additive push check [C7]. */
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import * as store from '../../../../packages/store/index.js';
import { pushedFirstParentCommits } from '../../../../packages/git/index.js';
import { runFixtureChild } from '../../tests/fixtures/child.js';
import { fixture } from '../../tests/fixtures/landing/receipts.js';
import { verifiedItem } from '../../tests/fixtures/landing/receipts.js';
import { gate } from '../../tests/fixtures/landing/receipts.js';
import { audit } from '../../tests/fixtures/landing/receipts.js';
import { onBoard } from '../../tests/fixtures/landing/receipts.js';
import { nativePushReceiptProblems } from '../../tests/fixtures/landing/receipts.js';

test('a native train landing records ordered bound evidence and an audit permits only the landed push range [C7]', async t => {
  const box = fixture(t);
  const id = verifiedItem(box, 1);
  const receipt = gate(box);
  const second = gate(box);
  assert.notEqual(second.id, receipt.id, 'explicit receipt production never reuses a tree stamp');
  const tip = box.git(box.repo, 'rev-parse', 'HEAD').trim();
  assert.match(onBoard(box, board => nativePushReceiptProblems(box.repo, board, [tip])).join('\n'), /audit/u);
  const landed = box.run(box.repo, 'merged', String(id), tip, '--gate-receipt', receipt.id, '--json');
  assert.equal(landed.code, 0, `${landed.out}${landed.err}`);
  const value = JSON.parse(landed.out);
  const rows = onBoard(box, board => store.events(board));
  const gateEvent = rows.find(row => row.event_kind === 'gate-run' && JSON.parse(row.event_detail).run.id === receipt.id);
  const batchEvent = rows.find(row => row.event_kind === 'landing_batch' && JSON.parse(row.event_detail).batch.state === 'landed');
  assert.ok(gateEvent.event_id < batchEvent.event_id);
  assert.equal(onBoard(box, board => store.getItem(board, id).item_merged_commit), tip);
  await audit(box, value.batch);
  const range = pushedFirstParentCommits(box.repo, `refs/heads/main ${tip} refs/heads/main ${box.base}\n`);
  assert.deepEqual(range, [tip]);
  assert.deepEqual(onBoard(box, board => nativePushReceiptProblems(box.repo, board, range)), []);
  const positive = runFixtureChild(process.execPath, [join(box.repo, 'apps/cli/pullboard.js'), 'push-receipts', '--json'],
    { cwd: box.repo, env: box.env, encoding: 'utf8',
      input: `refs/heads/main ${tip} refs/heads/main ${box.base}\n` });
  assert.equal(positive.status, 0, `${positive.stdout}${positive.stderr}`);
  const allowed = JSON.parse(positive.stdout);
  assert.equal(allowed.green, true, 'the public CLI accepts the actual native landed range');
  assert.deepEqual(allowed.commits, [tip]);
  assert.equal(allowed.activated, false, 'the additive command never replaces the active hook');
  writeFileSync(join(box.repo, 'web/hand-made.txt'), 'bypassed train\n');
  box.git(box.repo, 'add', '-A'); box.git(box.repo, 'commit', '-q', '-m', 'chore: bypass the native train');
  const bypass = box.git(box.repo, 'rev-parse', 'HEAD').trim();
  assert.match(onBoard(box, board => nativePushReceiptProblems(box.repo, board, [tip, bypass])).join('\n'), /lacks its exact native green landing receipt/u);
  const negative = runFixtureChild(process.execPath, [join(box.repo, 'apps/cli/pullboard.js'), 'push-receipts', '--json'],
    { cwd: box.repo, env: box.env, encoding: 'utf8',
      input: `refs/heads/main ${bypass} refs/heads/main ${box.base}\n` });
  assert.equal(negative.status, 1, `${negative.stdout}${negative.stderr}`);
  const refused = JSON.parse(negative.stdout);
  assert.equal(refused.green, false);
  assert.ok(refused.problems.some(problem => problem.includes(bypass)
    && problem.includes('exact native green landing receipt')),
  'the public CLI rejects the real handmade commit for its missing receipt');
});
