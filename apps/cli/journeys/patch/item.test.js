/** Patch CLI commands preserve source binding, coordinator authority, and native retry receipts [V4,H16]. */
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  after,
  test,
} from 'node:test';
import * as store from '../../../../packages/store/index.js';
import { openBoard } from '../../../lib/index.js';
import { submitFixture } from '../../tests/fixtures/board/submit.js';
import { createE2eHelpers } from '../../tests/fixtures/e2e.js';

const helpers = createE2eHelpers();
after(helpers.cleanup);

/** Run a private real CLI command and keep refusal output available to assertions. */
async function run(box, cwd, ...args) {
  const result = await box.runLocal(cwd, ...args);
  assert.equal(result.code, 0, `${args.join(' ')}: ${result.err}${result.out}`);
  return JSON.parse(result.out);
}

/** Read one real CLI refusal without turning its nonzero status into a test-helper error. */
async function refused(box, cwd, code, ...args) {
  const result = await box.runLocal(cwd, ...args);
  assert.equal(result.code, 1, `${args.join(' ')} unexpectedly succeeded: ${result.out}`);
  assert.match(result.err + result.out, new RegExp(code, 'u'));
}

test('patch attach, list, and remove bind a submitted source and require coordinator authority [V4,H16]', async t => {
  const box = helpers.project('true');
  const item = (await run(box, box.repo, 'add', 'web', 'Patchable submitted work', '--specs', 'G1', '--json')).item.item_id;
  const author = (await run(box, box.web, 'whoami', '--json')).id;
  await run(box, box.web, 'claim', String(item), '--json');
  const source = box.git(box.repo, 'rev-parse', 'HEAD');
  // @pullboard-board-file journey: inspect the durable item changed by real CLI patch commands
  const board = openBoard(join(box.repo, '.git', 'pullboard', 'board.sqlite'));
  t.after(() => store.closeBoard(board));
  const tree = box.git(box.repo, 'rev-parse', `${source}^{tree}`);
  submitFixture(board, item, { agentId: author, commit: source, tree });

  const patch = [
    'diff --git a/web/patchable.js b/web/patchable.js',
    'new file mode 100644',
    'index 0000000..e69de29',
    '--- /dev/null',
    '+++ b/web/patchable.js',
    '@@ -0,0 +1 @@',
    '+export const patched = true;',
    '',
  ].join('\n');
  const file = join(box.dir, 'review.patch');
  writeFileSync(file, patch);
  const key = 'review-fix';

  await refused(box, box.repo, 'ITEM_PATCH_SOURCE', 'patch', 'attach', String(item), file,
    '--key', key, '--author', author, '--source', '0'.repeat(40));
  await refused(box, box.web, 'COORDINATOR_ONLY', 'patch', 'attach', String(item), file,
    '--key', key, '--author', author, '--source', source);
  assert.equal(store.itemPatches(board, item).length, 0, 'refusals leave the patch set unchanged');

  const attached = await run(box, box.repo, 'patch', 'attach', String(item), file,
    '--key', key, '--author', author, '--source', source, '--json');
  assert.deepEqual(attached, { version: 1, item, key, digest: store.itemPatchDigest(board, item), changed: true });
  const listed = await run(box, box.repo, 'patch', 'list', String(item), '--json');
  assert.equal(listed.item, item);
  assert.equal(listed.digest, attached.digest);
  assert.equal(listed.patches.length, 1);
  assert.deepEqual(listed.patches[0], store.itemPatches(board, item)[0]);
  assert.equal(listed.patches[0].commit, source);
  assert.equal(listed.patches[0].patch, patch);
  assert.equal(listed.patches[0].author.agentId, author);

  const removed = await run(box, box.repo, 'patch', 'remove', String(item), key, '--json');
  assert.deepEqual(removed, { version: 1, item, key, digest: store.itemPatchDigest(board, item), changed: true });
  assert.notEqual(removed.digest, null, 'removal retains the immutable patch-set history');
  assert.deepEqual((await run(box, box.repo, 'patch', 'list', String(item), '--json')), {
    version: 1, item, patches: [], digest: removed.digest,
  });
  const retry = await run(box, box.repo, 'patch', 'attach', String(item), file,
    '--key', key, '--author', author, '--source', source, '--json');
  assert.deepEqual(retry, { version: 1, item, key, digest: removed.digest, changed: false }, 'an exact retry never reactivates a removed key');
  assert.deepEqual((await run(box, box.repo, 'patch', 'list', String(item), '--json')), {
    version: 1, item, patches: [], digest: removed.digest,
  });
});
