/** Real companion composition and module-target guards precede native main publication [B35]. */
import assert from 'node:assert/strict';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { openBoard } from '../../../../lib/index.js';
import {
  closeBoard,
  getItem,
  checkedLandingCommit,
} from '../../../../../packages/store/index.js';
import {
  createE2eHelpers,
  FIXTURE_MODEL,
} from '../../../tests/fixtures/e2e.js';
import { captureCommandInProcess } from '../../../tests/fixtures/process.js';
import { main } from '../../../tests/fixtures/native.js';

/** Run actual submit, review and landing against one private Git repository and persistent native board. */
async function fixture(t, { companion = false, deleted = false } = {}) {
  const helpers = createE2eHelpers();
  t.after(helpers.cleanup);
  const box = helpers.project('true', helpers.sandbox({ declareFamilies: true }));
  /** The public CLI retains normal authorization, composition, proof writing and hooks. */
  const cli = (cwd, ...args) => captureCommandInProcess(main, args, { cwd, env: box.env });
  const marker = join(box.dir, 'candidate-module-executed');
  mkdirSync(join(box.repo, 'web'), { recursive: true });
  writeFileSync(join(box.repo, 'package.json'), '{"type":"module"}\n');
  writeFileSync(join(box.repo, 'web/value.js'), 'export const value = 1;\n');
  writeFileSync(join(box.repo, 'web/client.js'), "import { value } from './value.js';\nimport { writeFileSync } from 'node:fs';\n"
    + `writeFileSync(${JSON.stringify(marker)}, 'executed');\nexport const result = value;\n`);
  box.git(box.repo, 'add', '-A');
  box.git(box.repo, 'commit', '-q', '-m', 'chore: private healthy module graph');
  box.git(box.web, 'merge', '-q', '--ff-only', 'main');
  const remote = join(box.dir, 'origin.git');
  box.git(box.dir, 'init', '-q', '--bare', remote);
  box.git(box.repo, 'remote', 'add', 'origin', remote);
  box.git(box.repo, 'push', '-q', '-u', 'origin', 'main');
  const added = await cli(box.repo, 'add', 'web', 'Source with landing inputs', '--specs', 'G1',
    '--criterion', 'The change marker exists.', '--check', 'test -f web/change.txt', '--wait', '--json');
  assert.equal(added.code, 0, added.err + added.out);
  const item = JSON.parse(added.out).item.item_id;
  const claim = await cli(box.web, 'claim', String(item));
  assert.equal(claim.code, 0, claim.err);
  writeFileSync(join(box.web, 'web/change.txt'), 'source change\n');
  if (deleted) box.git(box.web, 'rm', 'web/value.js');
  box.git(box.web, 'add', '-A');
  box.git(box.web, 'commit', '-q', '-m', 'feat(web): private landing source [G1]');
  const source = box.git(box.web, 'rev-parse', 'HEAD');
  if (companion) {
    const author = join(box.dir, 'companion-author');
    box.git(box.repo, 'worktree', 'add', '-q', '-b', 'api/landing-companion', author, source);
    const joined = await cli(author, 'join', 'api', '--family', 'Fixture Companion Vendor', '--json');
    assert.equal(joined.code, 0, joined.err + joined.out);
    const patch = join(box.dir, 'companion.patch');
    writeFileSync(patch, ['diff --git a/api/companion.txt b/api/companion.txt', 'new file mode 100644',
      '--- /dev/null', '+++ b/api/companion.txt', '@@ -0,0 +1 @@', '+required companion', ''].join('\n'));
    const attached = await cli(box.repo, 'patch', 'attach', String(item), patch, '--key', 'landing-companion',
      '--author', JSON.parse(joined.out).agent, '--source', source, '--json');
    assert.equal(attached.code, 0, attached.err + attached.out);
  }
  const submitted = await cli(box.web, 'submit', String(item), '--wait', '--no-next', '--json');
  assert.equal(submitted.code, 0, submitted.err + submitted.out);
  // @pullboard-board-file journey: the real CLI in this fixture repo owns the board file; the test seeds or reads that same file.
  const board = openBoard(join(box.repo, '.git/pullboard/board.sqlite'), undefined, { gitRoot: box.repo });
  t.after(() => closeBoard(board));
  const reviewer = join(box.dir, 'landing-reviewer');
  box.git(box.repo, 'worktree', 'add', '-q', '--detach', reviewer, getItem(board, item).item_commit);
  const joinedReviewer = await cli(reviewer, 'join', 'api', '--family', 'Fixture Review Vendor', '--model', FIXTURE_MODEL, '--route', 'strong', '--json');
  assert.equal(joinedReviewer.code, 0, joinedReviewer.err + joinedReviewer.out);
  const reserved = await cli(reviewer, 'next', '--verify', String(item), '--json');
  assert.equal(reserved.code, 0, reserved.err + reserved.out);
  const accepted = await cli(reviewer, 'verify', String(item), 'accept', '--no-next',
    '--note', 'The actual frozen change-marker command passed in the reserved composition.', '--json');
  assert.equal(accepted.code, 0, accepted.err + accepted.out);
  assert.equal(getItem(board, item).item_status, 'verified');
  return { ...box, board, item, source, marker, before: box.git(box.repo, 'rev-parse', 'main') };
}

test('native landing includes every attached companion and a manual omission cannot be recorded [B35]', async t => {
  const box = await fixture(t, { companion: true });
  const omitted = await box.runLocal(box.repo, 'merged', String(box.item), box.source, '--note', 'private omitted-companion control', '--json');
  assert.equal(omitted.code, 1, omitted.err + omitted.out);
  assert.equal(JSON.parse(omitted.out).error.code, 'LAND_COMPANION_MISSING');
  assert.equal(box.git(box.repo, 'rev-parse', 'main'), box.before);
  assert.equal(getItem(box.board, box.item).item_status, 'verified');
  const reviewed = checkedLandingCommit(box.board, getItem(box.board, box.item));
  assert.notEqual(reviewed, box.source);
  const landed = await box.runLocal(box.repo, 'land', '--json');
  assert.equal(landed.code, 0, landed.err + landed.out);
  assert.equal(readFileSync(join(box.repo, 'api/companion.txt'), 'utf8'), 'required companion\n');
  assert.equal(box.git(box.repo, 'merge-base', '--is-ancestor', reviewed, 'main'), '');
  assert.equal(existsSync(box.marker), false, 'source validation never evaluates the candidate module');
});

test('a composed landing with a deleted literal import target never moves main or the remote [B35]', async t => {
  const box = await fixture(t, { deleted: true });
  const refused = await box.runLocal(box.repo, 'land', '--json');
  assert.equal(refused.code, 1, refused.err + refused.out);
  assert.equal(JSON.parse(refused.out).error.code, 'LAND_MODULE_RESOLUTION');
  assert.match(JSON.parse(refused.out).error.message, /web\/client\.js.*\.\/value\.js/u);
  assert.equal(box.git(box.repo, 'rev-parse', 'main'), box.before);
  assert.equal(box.git(box.repo, 'ls-remote', 'origin', 'refs/heads/main').split(/\s/u)[0], box.before);
  assert.equal(existsSync(box.marker), false, 'compiling source graph inputs never evaluates candidate code');
  assert.equal(getItem(box.board, box.item).item_merged_commit, null);
});
