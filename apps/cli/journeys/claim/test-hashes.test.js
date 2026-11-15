/** A test file a clause names is hashed into the frozen bar; submit refuses a changed hash without a person's ruling [C7,V4]. */
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { createE2eHelpers } from '../../tests/fixtures/e2e.js';
import { fixtureProjectPolicy } from '../../tests/fixtures/testkit.js';
import { json } from '../../tests/fixtures/land/board.js';
import { contentHash } from '../../../../packages/verify/index.js';

test('clauses 1-3: the claim hashes the named test, a changed hash refuses submit, a person ruling lets it through [C7,V4]', { timeout: 300_000 }, async t => {
  // Budget: one private project, one claim, two submits and one ruling; the ceiling is for hangs, not a speed target.
  const helpers = createE2eHelpers();
  t.after(helpers.cleanup);
  const box = helpers.project('true');
  const config = JSON.parse(readFileSync(join(box.repo, 'pullboard.json'), 'utf8'));
  fixtureProjectPolicy(box.repo, { config: { ...config, verify: { ...config.verify, frozenTests: true } } });
  mkdirSync(join(box.repo, 'web'), { recursive: true });
  writeFileSync(join(box.repo, 'web/page.test.js'), "import { test } from 'node:test';\ntest('renders', () => {});\n");
  box.git(box.repo, 'add', '-A');
  box.git(box.repo, 'commit', '-qm', 'test(web): the page test');
  box.git(box.web, 'merge', '-q', '--ff-only', 'main');
  const frozenHash = contentHash(box.git(box.repo, 'show', 'main:web/page.test.js'));
  const id = json(box, box.repo, 'add', 'web', 'Render page', '--specs', 'G1', '--criterion', '1. web/page.test.js passes [test]', '--check', 'true').item.item_id;
  json(box, box.web, 'claim', String(id));

  const shown = await box.runLocal(box.repo, 'show', String(id));
  assert.match(shown.out, new RegExp(`test web/page\\.test\\.js: sha256 ${frozenHash}`, 'u'), 'clause 1: show prints the frozen hash');
  assert.deepEqual(JSON.parse(json(box, box.repo, 'show', String(id)).item_frozen).testHashes, { 'web/page.test.js': frozenHash }, 'clause 1: the frozen bar records it');

  writeFileSync(join(box.web, 'web/page.test.js'), "import { test } from 'node:test';\ntest('renders', () => { /* weakened */ });\n");
  box.git(box.web, 'add', '-A');
  box.git(box.web, 'commit', '-qm', 'feat(web): weaker page test [G1]');
  const newHash = contentHash(box.git(box.web, 'show', 'HEAD:web/page.test.js'));
  const refused = await box.runLocal(box.web, 'submit', String(id), '--no-next');
  assert.notEqual(refused.code, 0);
  assert.match(refused.out + refused.err, /\[TEST_HASH_CHANGED\].*web\/page\.test\.js/u, 'clause 2: a changed hash is refused with its rule code');

  const ruled = await box.runLocal(box.repo, 'fact', String(id), 'decision', `test-hash web/page.test.js ${newHash}`, '--as', 'person');
  assert.equal(ruled.code, 0, ruled.err || ruled.out);
  const resubmitted = await box.runLocal(box.web, 'submit', String(id), '--no-next');
  assert.doesNotMatch(resubmitted.out + resubmitted.err, /TEST_HASH_CHANGED/u, 'clause 3: the ruling lets the submit proceed');
  assert.match((await box.runLocal(box.repo, 'show', String(id))).out, new RegExp(`person ruling \\S+ accepts ${newHash.slice(0, 12)}`, 'u'), 'clause 3: the item record names the ruling');
});
