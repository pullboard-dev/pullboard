/** Landing refuses a rename the path map does not record, and lands it once the entry is in the candidate [C7]. */
import assert from 'node:assert/strict';
import {
  existsSync,
  mkdirSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import {
  createE2eHelpers,
  FIXTURE_MODEL,
} from '../../../tests/fixtures/e2e.js';
import { captureCommandInProcess } from '../../../tests/fixtures/process.js';
import { main } from '../../../tests/fixtures/native.js';

/** Run actual submit, review and landing against one private repository whose candidate renames a tracked file. */
async function fixture(t, { recorded = false } = {}) {
  const helpers = createE2eHelpers();
  t.after(helpers.cleanup);
  const box = helpers.project('true', helpers.sandbox({ declareFamilies: true }));
  /** The public CLI keeps normal authorization, composition, proof writing and hooks. */
  const cli = (cwd, ...args) => captureCommandInProcess(main, args, { cwd, env: box.env });
  mkdirSync(join(box.repo, 'web'), { recursive: true });
  writeFileSync(join(box.repo, 'web/old-name.txt'), Array.from({ length: 30 }, (_, line) => `row ${line}`).join('\n') + '\n');
  box.git(box.repo, 'add', '-A');
  box.git(box.repo, 'commit', '-q', '-m', 'chore: private tracked file');
  box.git(box.web, 'merge', '-q', '--ff-only', 'main');
  const remote = join(box.dir, 'origin.git');
  box.git(box.dir, 'init', '-q', '--bare', remote);
  box.git(box.repo, 'remote', 'add', 'origin', remote);
  box.git(box.repo, 'push', '-q', '-u', 'origin', 'main');
  const added = await cli(box.repo, 'add', 'web', 'Rename a tracked file', '--specs', 'G1',
    '--criterion', 'The change marker exists.', '--check', 'test -f web/change.txt', '--wait', '--json');
  assert.equal(added.code, 0, added.err + added.out);
  const item = JSON.parse(added.out).item.item_id;
  const claim = await cli(box.web, 'claim', String(item));
  assert.equal(claim.code, 0, claim.err);
  writeFileSync(join(box.web, 'web/change.txt'), 'source change\n');
  box.git(box.web, 'mv', 'web/old-name.txt', 'web/new-name.txt');
  if (recorded) {
    mkdirSync(join(box.web, 'packages/codemap/data/plan/path-map'), { recursive: true });
    writeFileSync(join(box.web, 'packages/codemap/data/plan/path-map/untangle.json'), JSON.stringify({ 'web/old-name.txt': 'web/new-name.txt' }) + '\n');
  }
  box.git(box.web, 'add', '-A');
  box.git(box.web, 'commit', '-q', '-m', 'feat(web): private rename source [G1]');
  const submitted = await cli(box.web, 'submit', String(item), '--wait', '--no-next', '--json');
  assert.equal(submitted.code, 0, submitted.err + submitted.out);
  /** The item as the board shows it, read through the public CLI. */
  const show = async () => JSON.parse((await cli(box.repo, 'show', String(item), '--json')).out);
  const reviewer = join(box.dir, 'landing-reviewer');
  box.git(box.repo, 'worktree', 'add', '-q', '--detach', reviewer, (await show()).item_commit);
  const joinedReviewer = await cli(reviewer, 'join', 'api', '--family', 'Fixture Review Vendor', '--model', FIXTURE_MODEL, '--route', 'strong', '--json');
  assert.equal(joinedReviewer.code, 0, joinedReviewer.err + joinedReviewer.out);
  const reserved = await cli(reviewer, 'next', '--verify', String(item), '--json');
  assert.equal(reserved.code, 0, reserved.err + reserved.out);
  const accepted = await cli(reviewer, 'verify', String(item), 'accept', '--no-next',
    '--note', 'The actual frozen change-marker command passed in the reserved composition.', '--json');
  assert.equal(accepted.code, 0, accepted.err + accepted.out);
  assert.equal((await show()).item_status, 'verified');
  return { ...box, show, item, before: box.git(box.repo, 'rev-parse', 'main') };
}

test('landing refuses a candidate that renames a tracked file with no path-map entry, naming the file and the shard [C7]', async t => {
  const box = await fixture(t);
  const refused = await box.runLocal(box.repo, 'land', '--json');
  assert.equal(refused.code, 1, refused.err + refused.out);
  const error = JSON.parse(refused.out).error;
  assert.equal(error.code, 'LAND_MOVE_UNRECORDED');
  assert.match(error.message, /web\/old-name\.txt -> web\/new-name\.txt/u);
  assert.match(error.message, /packages\/codemap\/data\/plan\/path-map\/untangle\.json/u);
  assert.equal(box.git(box.repo, 'rev-parse', 'main'), box.before);
  assert.equal((await box.show()).item_merged_commit, null);
});

test('landing lands the same rename once the candidate records it in a path-map shard [C7]', async t => {
  const box = await fixture(t, { recorded: true });
  const landed = await box.runLocal(box.repo, 'land', '--json');
  assert.equal(landed.code, 0, landed.err + landed.out);
  assert.notEqual(box.git(box.repo, 'rev-parse', 'main'), box.before);
  assert.equal(existsSync(join(box.repo, 'web/new-name.txt')), true);
  assert.equal(existsSync(join(box.repo, 'web/old-name.txt')), false);
});
