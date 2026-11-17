/** next --take restores the pinned head of a returned item when next.adoptPreserved is on, and claims as before when it is off [C7,#9689]. @pullboard-test-input source-cell apps/cli packages/config */
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdirSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { FIXTURE_MODEL } from '../../fixtures/e2e.js';
import { createE2eHelpers } from '../../fixtures/e2e.js';
import { fixtureAdd } from '../../fixtures/testkit.js';
import { joinFixtureSeat } from '../../fixtures/testkit.js';

/** A project whose first seat built and returned an item with its work pinned, and a fresh seat that takes the next claim. */
async function returned(t, { setting }) {
  const e2e = createE2eHelpers();
  t.after(e2e.cleanup);
  const box = e2e.project('true');
  const file = join(box.dir, 'machine-home', 'settings.json');
  mkdirSync(join(box.dir, 'machine-home'), { recursive: true });
  writeFileSync(file, JSON.stringify({ view: { background: false }, relay: { offerAtInit: false }, gate: { localRunner: false }, next: { adoptPreserved: setting } }));
  const added = await fixtureAdd(box.runLocal, box.repo, 'web', 'Page', '--specs', 'G1', '--criterion', 'renders');
  const id = added.out.match(/^#(\d+)/m)[1];
  box.git(box.web, 'merge', '-q', 'main');
  const claimed = await box.runLocal(box.web, 'claim', id);
  assert.equal(claimed.code, 0, claimed.err + claimed.out);
  const folder = claimed.out.match(/^item folder: (.+)$/m)[1];
  mkdirSync(join(folder, 'web'), { recursive: true });
  writeFileSync(join(folder, 'web', 'page.html'), '<h1>Returned work</h1>');
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
  return { box, id, head, pin, fresh, file };
}

test('cli.io-next-adopt-orphan.cli-next-adopt-orphan-with-next-adoptpreserved: cli.next.adopt-orphan.with-next-adoptpreserved-on-next-take: clause 1: with next.adoptPreserved on, next --take of a returned item checks the new folder out at its pinned commit [C7,#9689]', async t => {
  const f = await returned(t, { setting: true });
  const taken = await f.box.runLocal(f.fresh, 'next', '--take');
  assert.equal(taken.code, 0, taken.err + taken.out);
  assert.match(taken.out, new RegExp(`restored the pinned work of #${f.id}: head ${f.head.slice(0, 12)} from ${f.pin}`));
  const folder = taken.out.match(/^item folder: (.+?);/m)?.[1] ?? f.fresh;
  assert.ok(existsSync(join(folder, 'web', 'page.html')), 'the returned file is in the new item folder');
  assert.equal(readFileSync(join(folder, 'web', 'page.html'), 'utf8'), '<h1>Returned work</h1>');
  assert.equal(f.box.git(folder, 'merge-base', '--is-ancestor', f.head, 'HEAD') ?? '', '', 'the pinned head is in the folder branch');
  const shown = await f.box.runLocal(f.box.repo, 'show', f.id);
  assert.match(shown.out, /Adopted the orphaned claim of web-1 .*credit to web-1/u);
});

test('cli.io-next-adopt-orphan.cli-next-adopt-orphan-with-next-adoptpreserved-2: cli.next.adopt-orphan.with-next-adoptpreserved-off-the-default: clause 2: with next.adoptPreserved off, the default, next --take claims the returned item exactly as before [C7,#9689]', async t => {
  const f = await returned(t, { setting: false });
  const taken = await f.box.runLocal(f.fresh, 'next', '--take');
  assert.equal(taken.code, 0, taken.err + taken.out);
  assert.match(taken.out, new RegExp(`claimed #${f.id}`));
  assert.doesNotMatch(taken.out, /restored the pinned work/u);
  const folder = taken.out.match(/^item folder: (.+?);/m)?.[1] ?? f.fresh;
  assert.equal(existsSync(join(folder, 'web', 'page.html')), false, 'nothing of the returned work is restored');
  assert.equal(f.box.tryGit(folder, 'merge-base', '--is-ancestor', f.head, 'HEAD').status !== 0, true);
});
