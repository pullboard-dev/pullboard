/** An item folder with uncommitted work survives a release and a later claim by another seat [C7,#2965]. */
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdirSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import { readdirSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { FIXTURE_MODEL } from '../../tests/fixtures/e2e.js';
import { createE2eHelpers } from '../../tests/fixtures/e2e.js';
import { fixtureAdd } from '../../tests/fixtures/testkit.js';
import { joinFixtureSeat } from '../../tests/fixtures/testkit.js';

const DRAFT = '<h1>Uncommitted draft</h1>\n';

/** A seat claims an item and leaves a staged file and an untracked file in its item folder, then releases the claim. */
async function released(t) {
  const e2e = createE2eHelpers();
  t.after(e2e.cleanup);
  const box = e2e.project('true');
  const added = await fixtureAdd(box.runLocal, box.repo, 'web', 'Page', '--specs', 'G1', '--criterion', 'renders');
  const id = added.out.match(/^#(\d+)/m)[1];
  box.git(box.web, 'merge', '-q', 'main');
  const claimed = await box.runLocal(box.web, 'claim', id);
  assert.equal(claimed.code, 0, claimed.err + claimed.out);
  const folder = claimed.out.match(/^item folder: (.+)$/m)[1];
  mkdirSync(join(folder, 'web'), { recursive: true });
  writeFileSync(join(folder, 'web', 'staged.html'), DRAFT);
  box.git(folder, 'add', 'web/staged.html');
  writeFileSync(join(folder, 'web', 'untracked.html'), DRAFT);
  const freed = await box.runLocal(box.web, 'release', id, '--reason', 'OTHER', '--note', 'Handing the item back with work in the folder', '--no-next');
  assert.equal(freed.code, 0, freed.err + freed.out);
  return { box, id, folder };
}

/** Whether both uncommitted files are still on disk in `folder` with the bytes the first seat left. */
function draftKept(folder) {
  return ['staged.html', 'untracked.html'].every(name => existsSync(join(folder, 'web', name)) && readFileSync(join(folder, 'web', name), 'utf8') === DRAFT);
}

test('clause 1: a released claim leaves its item folder\'s uncommitted changes on disk [C7,#2965]', async t => {
  const { folder } = await released(t);
  assert.ok(existsSync(folder), 'the item folder is still there after the release');
  assert.ok(draftKept(folder), 'the staged and the untracked file are both still on disk, byte for byte');
});

test('clause 2: a later claim of the same item by another seat archives the first seat\'s dirty folder, recoverable from its archive ref, and records the archive in a fact [C7,#2965]', async t => {
  const { box, id, folder } = await released(t);
  const fresh = join(box.dir, 'web-2');
  box.git(box.repo, 'worktree', 'add', '-q', fresh, '-b', 'web/two');
  const joined = joinFixtureSeat(box, fresh, 'web', { model: FIXTURE_MODEL });
  assert.equal(joined.code, 0, joined.err);
  box.git(fresh, 'merge', '-q', 'main');
  const reclaimed = await box.runLocal(fresh, 'claim', id);
  assert.equal(reclaimed.code, 0, reclaimed.err + reclaimed.out);
  const shown = await box.runLocal(fresh, 'show', id);
  const recovery = shown.out.match(/Archived prior item folder (.+?) from \S+ before takeover\.\s*Recovery: (\{.*\})/u);
  assert.ok(recovery, `a fact on the item records the archive:\n${shown.out}`);
  assert.equal(recovery[1], folder, 'the fact names the first seat\'s folder');
  const { directory, head, ref } = JSON.parse(recovery[2]);
  assert.equal(String(box.git(fresh, 'rev-parse', '--verify', ref)).trim(), head, 'the archive ref resolves to the folder\'s head');
  const bytes = [...readdirSync(join(directory, 'blobs')).map(blob => join('blobs', blob)), 'staged.patch', 'unstaged.patch']
    .map(name => readFileSync(join(directory, name), 'utf8'));
  assert.ok(bytes.some(text => text.includes(DRAFT.trim())), 'the uncommitted draft bytes are recoverable from the archive');
});
