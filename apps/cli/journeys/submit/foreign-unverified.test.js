/** A submit whose head reaches another unverified item's commit through a merge is refused, and the patch-source refusal names the safe reconcile [V1,V17,C7]. */
import assert from 'node:assert/strict';
import { rm } from 'node:fs/promises';
import {
  after,
  test,
} from 'node:test';
import { createE2eHelpers } from "../../tests/fixtures/e2e.js";
import { fixtureAdd } from '../../tests/fixtures/testkit.js';
import {
  mkdirSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';

const e2e = createE2eHelpers();

after(async () => {
  await Promise.all(e2e.sandboxes.map(dir => rm(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 })));
});

/** Add a web item through the fixture's in-process CLI. */
async function add(box, title) {
  const result = await fixtureAdd(box.runLocal, box.repo, 'web', title, '--specs', 'G1', '--criterion', title);
  assert.equal(result.code, 0, result.out + result.err);
  return Number(result.out.match(/#(\d+)/u)?.[1]);
}

/** Commit one owned file and return the commit. */
function commitFile(box, name, contents) {
  mkdirSync(join(box.web, 'web'), { recursive: true });
  writeFileSync(join(box.web, name), contents);
  box.git(box.web, 'add', name);
  box.git(box.web, 'commit', '-q', '-m', `feat(web): ${contents.trim()} [G1]`);
  return box.git(box.web, 'rev-parse', 'HEAD');
}

test('clause 1: [V1,V17,C7] a head that merges in another unverified item commit is refused STACKED_ON_UNVERIFIED naming that item', async () => {
  const box = e2e.project('true');
  const first = await add(box, 'First submission');
  assert.equal((await box.runLocal(box.web, 'claim', String(first))).code, 0);
  const firstCommit = commitFile(box, 'web/first.txt', 'first submission');
  assert.equal((await box.runLocal(box.web, 'submit', String(first))).code, 0);

  const base = box.git(box.repo, 'rev-parse', 'main');
  const second = await add(box, 'Merged submission');
  box.git(box.web, 'checkout', '-q', '--detach', base);
  assert.equal((await box.runLocal(box.web, 'claim', String(second))).code, 0);
  commitFile(box, 'web/second.txt', 'second submission');
  box.git(box.web, 'merge', '-q', '--no-ff', '--no-edit', firstCommit);
  const refused = (await box.runLocal(box.web, 'submit', String(second), '--json'));
  assert.equal(refused.code, 1, refused.out + refused.err);
  const error = JSON.parse(refused.out).error;
  assert.equal(error.code, 'STACKED_ON_UNVERIFIED');
  assert.match(error.message, new RegExp(`#${first}\\b`, 'u'));
});

test('clause 1 control: [V1,V17,C7] commits that cite only the item itself are not refused as stacked', async () => {
  const box = e2e.project('true');
  const only = await add(box, 'Only submission');
  assert.equal((await box.runLocal(box.web, 'claim', String(only))).code, 0);
  commitFile(box, 'web/only.txt', 'only submission');
  const result = (await box.runLocal(box.web, 'submit', String(only), '--json'));
  assert.equal(result.code, 0, result.out + result.err);
});

test('clause 2: [V1,V17,C7] the ITEM_PATCH_SOURCE refusal says to keep the item folder branch as the source and never merge the seat checkout head', async () => {
  const box = e2e.project('true');
  const item = await add(box, 'Patched submission');
  assert.equal((await box.runLocal(box.web, 'claim', String(item))).code, 0);
  commitFile(box, 'web/patched.txt', 'patched submission');
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
  const result = (await box.runLocal(box.repo, 'patch', 'attach', String(item), join(box.dir, 'x.patch'), '--key', 'k', '--author', author, '--source', '0'.repeat(40), '--json'));
  const text = result.out + result.err;
  assert.match(text, /item folder branch/u);
  assert.match(text, /never merge the seat checkout head/u);
});
