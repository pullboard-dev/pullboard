/** Companions bind to the claimed item's own worktree even when its registered seat has not moved [C7]. */
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { createE2eHelpers } from '../../tests/fixtures/e2e.js';

/** Run the real CLI and retain its refusal text. */
async function document(box, root, ...args) {
  const result = await box.runLocal(root, ...args, '--json');
  assert.equal(result.code, 0, `${result.err}\n${result.out}`);
  return JSON.parse(result.out);
}

test('attach and submit compose a companion against the item folder, not its older seat [C7]', async t => {
  const helpers = createE2eHelpers();
  t.after(helpers.cleanup);
  const box = helpers.project('true');
  const item = (await document(box, box.repo, 'add', 'web', 'Item folder companion', '--specs', 'G1',
    '--criterion', 'The composed work includes the companion.', '--check', 'test -f web/companion.js')).item.item_id;
  const seat = (await document(box, box.web, 'whoami')).id;
  const claimed = await document(box, box.web, 'claim', String(item));
  const folder = claimed.itemFolder;
  const oldHead = box.git(box.web, 'rev-parse', 'HEAD');
  mkdirSync(join(folder, 'web'), { recursive: true });
  writeFileSync(join(folder, 'web/item.js'), 'export const item = true;\n');
  box.git(folder, 'add', 'web/item.js');
  box.git(folder, 'commit', '-m', 'feat(web): add item fixture [G1]');
  const head = box.git(folder, 'rev-parse', 'HEAD');
  assert.notEqual(head, oldHead);
  assert.equal(box.git(box.web, 'rev-parse', 'HEAD'), oldHead);
  const patch = join(box.dir, 'companion.patch');
  writeFileSync(patch, ['diff --git a/web/companion.js b/web/companion.js', 'new file mode 100644',
    '--- /dev/null', '+++ b/web/companion.js', '@@ -0,0 +1 @@', '+export const companion = true;', ''].join('\n'));
  await document(box, box.repo, 'patch', 'attach', String(item), patch, '--key', 'companion', '--author', seat);
  const attached = await document(box, box.repo, 'patch', 'list', String(item));
  assert.equal(attached.patches[0].commit, head);
  writeFileSync(join(folder, 'web/next.js'), 'export const next = true;\n');
  box.git(folder, 'add', 'web/next.js');
  box.git(folder, 'commit', '-m', 'feat(web): advance item fixture [G1]');
  const advanced = box.git(folder, 'rev-parse', 'HEAD');
  assert.notEqual(advanced, head);
  const submitted = await document(box, folder, 'submit', String(item), '--no-next');
  assert.notEqual(submitted.gate.companion.commit, advanced);
  assert.equal(submitted.gate.companion.source, advanced);
  assert.equal((await document(box, box.repo, 'patch', 'list', String(item))).patches[0].commit, advanced);

  assert.equal(box.git(box.web, 'rev-parse', 'HEAD'), oldHead);
});
