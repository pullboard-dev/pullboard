/** The README's manual workflow in a seat behind main: the refused commit names the item folder and the next command [C7,#7946]. */
import assert from 'node:assert/strict';
import {
  appendFileSync,
  mkdirSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { createE2eHelpers } from '../../tests/fixtures/e2e.js';
import { settleSubmit } from '../../tests/fixtures/submit/settle.js';

/** Run the real CLI and parse its JSON answer. */
async function document(box, root, ...args) {
  const result = await box.runLocal(root, ...args, '--json');
  assert.equal(result.code, 0, `${result.err}\n${result.out}`);
  return JSON.parse(result.out);
}

test('README manual workflow: a seat commit refused for a newer spec row names the item folder and submit command [C7,#7946]', async t => {
  const helpers = createE2eHelpers();
  t.after(helpers.cleanup);
  const box = helpers.project('true');
  // The row lands on main after the seat was made, as when a person drafts and approves a row first.
  appendFileSync(join(box.repo, 'SPEC.md'), '- G3 [approved, must] Totals round. | gate: web test\n');
  box.git(box.repo, 'commit', '-qam', 'docs(spec): add G3');
  const item = (await document(box, box.repo, 'add', 'web', 'Round', '--specs', 'G3',
    '--criterion', 'Totals round.', '--check', 'test -f web/round.js')).item.item_id;
  const claimed = await document(box, box.web, 'claim', String(item));
  const folder = claimed.itemFolder;
  mkdirSync(join(box.web, 'web'), { recursive: true });
  writeFileSync(join(box.web, 'web/round.js'), 'export const round = true;\n');
  box.git(box.web, 'add', '-A');
  const refused = box.tryGit(box.web, 'commit', '-m', `feat(web): round [G3]`);
  assert.notEqual(refused.status, 0);
  assert.match(refused.stderr, /G3 is not in SPEC\.md/u);
  assert.ok(refused.stderr.includes(`item folder ${folder}`), refused.stderr);
  assert.ok(refused.stderr.includes(`cd ${folder} && pullboard submit ${item}`), refused.stderr);
  box.git(box.web, 'reset', '-q', '--hard');
  // The named folder is current with main, so the same commit and submit work there.
  mkdirSync(join(folder, 'web'), { recursive: true });
  writeFileSync(join(folder, 'web/round.js'), 'export const round = true;\n');
  box.git(folder, 'add', '-A');
  box.git(folder, 'commit', '-q', '-m', 'feat(web): round [G3]');
  const submitted = await settleSubmit(t, box, await document(box, folder, 'submit', String(item), '--no-next'));
  assert.ok(submitted);
});
