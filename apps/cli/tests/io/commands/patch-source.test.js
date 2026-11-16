/** The ITEM_PATCH_SOURCE refusal says to keep the item folder branch as the source and never merge the seat checkout head [V1,V17,C7]. */
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { createE2eHelpers } from '../../fixtures/e2e.js';
import { fixtureAdd } from '../../fixtures/testkit.js';

test('clause 2: [V1,V17,C7] the ITEM_PATCH_SOURCE refusal says to keep the item folder branch as the source and never merge the seat checkout head', async t => {
  const e2e = createE2eHelpers();
  t.after(e2e.cleanup);
  const box = e2e.project('true');
  const added = await fixtureAdd(box.runLocal, box.repo, 'web', 'Patched submission', '--specs', 'G1', '--criterion', 'Patched submission');
  assert.equal(added.code, 0, added.out + added.err);
  const item = Number(added.out.match(/#(\d+)/u)?.[1]);
  assert.equal((await box.runLocal(box.web, 'claim', String(item))).code, 0);
  mkdirSync(join(box.web, 'web'), { recursive: true });
  writeFileSync(join(box.web, 'web/patched.txt'), 'patched submission');
  box.git(box.web, 'add', 'web/patched.txt');
  box.git(box.web, 'commit', '-q', '-m', 'feat(web): patched submission [G1]');
  const author = JSON.parse((await box.runLocal(box.web, 'whoami', '--json')).out).id;
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
  writeFileSync(join(box.dir, 'x.patch'), patch);
  const result = await box.runLocal(box.repo, 'patch', 'attach', String(item), join(box.dir, 'x.patch'), '--key', 'k', '--author', author, '--source', '0'.repeat(40), '--json');
  const text = result.out + result.err;
  assert.match(text, /ITEM_PATCH_SOURCE/u);
  assert.match(text, /item folder branch/u);
  assert.match(text, /never merge the seat checkout head/u);
});
