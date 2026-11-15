/** A submit records the builder seat and family of each named test file it adds, and show prints them [C7,V4]. */
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { createE2eHelpers } from '../../tests/fixtures/e2e.js';
import { json } from '../../tests/fixtures/land/board.js';

test('clauses 1-2: submit stores the author seat and family of a named test, and show prints author and reviewer family [C7,V4]', { timeout: 300_000 }, async t => {
  // Budget: one private project, one claim, one submit; the ceiling is for hangs, not a speed target.
  const helpers = createE2eHelpers();
  t.after(helpers.cleanup);
  const box = helpers.project('true');
  const id = json(box, box.repo, 'add', 'web', 'Render page', '--specs', 'G1', '--criterion', '1. web/page.test.js passes [test]', '--check', 'true').item.item_id;
  json(box, box.web, 'claim', String(id));
  mkdirSync(join(box.web, 'web'), { recursive: true });
  writeFileSync(join(box.web, 'web/page.test.js'), "import { test } from 'node:test';\ntest('renders', () => {});\n");
  box.git(box.web, 'add', '-A');
  box.git(box.web, 'commit', '-qm', 'test(web): the page test [G1]');
  const before = await box.runLocal(box.repo, 'show', String(id));
  assert.match(before.out, /test web\/page\.test\.js: author not recorded; reviewer family none yet/u);
  await box.runLocal(box.web, 'submit', String(id), '--no-next');
  const shown = (await box.runLocal(box.repo, 'show', String(id))).out;
  assert.match(shown, /test web\/page\.test\.js: author \S+ \[family [^\]]+\]; reviewer family none yet/u, 'clauses 1-2: the item record names the author seat and family');
  assert.equal(json(box, box.repo, 'show', String(id)).thread.filter(entry => /^test author web\/page\.test\.js: seat /u.test(entry.text ?? '')).length, 1, 'clause 1: one record per added file');
});
