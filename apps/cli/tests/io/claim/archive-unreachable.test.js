/** A claim whose prior dirty folder cannot be archived because the archives folder is unreachable still records the claim [C7]. */
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdirSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import { rmSync } from 'node:fs';
import { symlinkSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { resolve } from 'node:path';
import { test } from 'node:test';
import { FIXTURE_MODEL } from '../../fixtures/e2e.js';
import { createE2eHelpers } from '../../fixtures/e2e.js';
import { fixtureAdd } from '../../fixtures/testkit.js';
import { joinFixtureSeat } from '../../fixtures/testkit.js';

const DRAFT = '<h1>Uncommitted draft</h1>\n';

test('cli.io-claim-archive-unreachable.claim-with-a-worktree-archives-link-to: clause 1: claim with a worktree-archives link to a missing volume keeps the claim and the dirty folder, names the archive path once, and exits 0 [C7]', async t => {
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
  writeFileSync(join(folder, 'web', 'untracked.html'), DRAFT);
  const freed = await box.runLocal(box.web, 'release', id, '--reason', 'OTHER', '--note', 'Handing the item back with work in the folder', '--no-next');
  assert.equal(freed.code, 0, freed.err + freed.out);
  const common = resolve(box.repo, String(box.git(box.repo, 'rev-parse', '--git-common-dir')).trim());
  const archives = join(common, 'pullboard', 'worktree-archives');
  mkdirSync(join(common, 'pullboard'), { recursive: true });
  rmSync(archives, { recursive: true, force: true });
  symlinkSync(join(box.dir, 'missing-volume', 'archives'), archives);
  const fresh = join(box.dir, 'web-2');
  box.git(box.repo, 'worktree', 'add', '-q', fresh, '-b', 'web/two');
  const joined = joinFixtureSeat(box, fresh, 'web', { model: FIXTURE_MODEL });
  assert.equal(joined.code, 0, joined.err);
  box.git(fresh, 'merge', '-q', 'main');
  const reclaimed = await box.runLocal(fresh, 'claim', id);
  assert.equal(reclaimed.code, 0, reclaimed.err + reclaimed.out);
  assert.match(reclaimed.out, /claimed #\d+ until/u, 'the claim is recorded');
  const lines = reclaimed.out.split('\n').filter(line => line.includes(archives));
  assert.equal(lines.length, 1, `one line names the unreachable archive path:\n${reclaimed.out}`);
  assert.ok(existsSync(join(folder, 'web', 'untracked.html')) && readFileSync(join(folder, 'web', 'untracked.html'), 'utf8') === DRAFT, 'the dirty earlier folder is untouched');
});
