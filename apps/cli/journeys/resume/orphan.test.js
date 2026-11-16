/** pullboard resume in a fresh worktree adopts the claim an orphaned seat left, from the ref that pinned its work [C7]. */
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdirSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { FIXTURE_MODEL } from '../../tests/fixtures/e2e.js';
import { createE2eHelpers } from '../../tests/fixtures/e2e.js';
import { fixtureAdd } from '../../tests/fixtures/testkit.js';
import { fixtureProjectPolicy } from '../../tests/fixtures/testkit.js';
import { joinFixtureSeat } from '../../tests/fixtures/testkit.js';

/** A project whose first seat claimed an item, committed work, then lost its folders; the work stays pinned and a fresh seat waits. */
async function orphaned(t, { setting }) {
  const e2e = createE2eHelpers();
  t.after(e2e.cleanup);
  const box = e2e.project('true');
  const config = JSON.parse(readFileSync(join(box.repo, 'pullboard.json'), 'utf8'));
  fixtureProjectPolicy(box.repo, { config: { ...config, resume: { adoptOrphans: setting } } });
  box.git(box.repo, 'add', 'pullboard.json');
  box.git(box.repo, 'commit', '-q', '-m', 'chore: resume setting');
  const added = await fixtureAdd(box.runLocal, box.repo, 'web', 'Page', '--specs', 'G1', '--criterion', 'renders');
  const id = added.out.match(/^#(\d+)/m)[1];
  box.git(box.web, 'merge', '-q', 'main');
  const claimed = await box.runLocal(box.web, 'claim', id);
  assert.equal(claimed.code, 0, claimed.err + claimed.out);
  const folder = claimed.out.match(/^item folder: (.+)$/m)[1];
  mkdirSync(join(folder, 'web'), { recursive: true });
  writeFileSync(join(folder, 'web', 'page.html'), '<h1>Orphan work</h1>');
  box.git(folder, 'add', '-A');
  box.git(folder, 'commit', '-q', '-m', 'feat(web): page [G1]');
  const head = box.git(folder, 'rev-parse', 'HEAD').trim();
  const pin = `refs/pullboard/handoffs/${id}/${head.slice(0, 12)}`;
  box.git(box.repo, 'update-ref', pin, head);
  box.git(box.repo, 'worktree', 'remove', '--force', folder);
  box.git(box.repo, 'worktree', 'remove', '--force', box.web);
  const freed = await box.runLocal(box.repo, 'release', id, '--stale', '--reason', 'OTHER', '--note', 'The seat folder was cleared');
  assert.equal(freed.code, 0, freed.err + freed.out);
  const fresh = join(box.dir, 'web-2');
  box.git(box.repo, 'worktree', 'add', '-q', fresh, '-b', 'web/two');
  const joined = joinFixtureSeat(box, fresh, 'web', { model: FIXTURE_MODEL });
  assert.equal(joined.code, 0, joined.err);
  return { box, id, head, pin, fresh };
}

test('clause 1: resume in a fresh worktree adopts an orphaned seat claim from its pinned ref with credit [C7]', async t => {
  const f = await orphaned(t, { setting: true });
  const resumed = await f.box.runLocal(f.fresh, 'resume');
  assert.equal(resumed.code, 0, resumed.err + resumed.out);
  assert.match(resumed.out, new RegExp(`adopted #${f.id} from web-1: head ${f.head.slice(0, 12)} restored from ${f.pin}`));
  const shown = await f.box.runLocal(f.box.repo, 'show', f.id);
  assert.match(shown.out, /Adopted the orphaned claim of web-1 .*credit to web-1/u);
  assert.match(shown.out, /web-2/u, 'the fresh seat now holds the item');
});

test('clause 2: the adopted claim restores the orphaned head, and with the setting off resume adopts nothing [C7]', async t => {
  const on = await orphaned(t, { setting: true });
  await on.box.runLocal(on.fresh, 'resume');
  const folder = join(on.box.dir, `web-2-item-${on.id}`);
  assert.ok(existsSync(join(folder, 'web', 'page.html')), 'the orphan\'s file is in the new item folder');
  assert.equal(on.box.git(folder, 'merge-base', '--is-ancestor', on.head, 'HEAD') ?? '', '', 'the orphaned head is in the adopted branch');
  const off = await orphaned(t, { setting: false });
  const resumed = await off.box.runLocal(off.fresh, 'resume');
  assert.doesNotMatch(resumed.out, /adopted #/u);
  assert.equal(existsSync(join(off.box.dir, `web-2-item-${off.id}`)), false);
});
