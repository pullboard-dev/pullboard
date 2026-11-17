/** Review reservations compose the item's active companions and verdicts name the patch set they judged [V4,H16,G1]. */
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { existsSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import { rmSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { test } from 'node:test';
import * as store from '../../../../../packages/store/index.js';
import { openBoard } from '../../../../lib/index.js';
import { createE2eHelpers } from '../../../tests/fixtures/e2e.js';
import { fixtureAdd } from '../../../tests/fixtures/testkit.js';
import { settleSubmit } from '../../../tests/fixtures/submit/settle.js';

/** Require actual successful CLI execution before inspecting its document. */
function document(result) {
  assert.equal(result.code, 0, `${result.err}\n${result.out}`);
  return JSON.parse(result.out);
}

/** Invoke a command under an explicit independent fixture session. */
async function asSession(box, session, cwd, ...args) {
  const previous = box.env.CODEX_THREAD_ID;
  box.env.CODEX_THREAD_ID = session;
  try { return await box.runIn(cwd, ...args, ...(['submit', 'verify', 'release'].includes(args[0]) ? ['--no-next'] : []), '--json'); }
  finally {
    if (previous === undefined) delete box.env.CODEX_THREAD_ID;
    else box.env.CODEX_THREAD_ID = previous;
  }
}

test('a reviewer gets the companion-composed tree and a bare tree cannot reject [V4,H16,G1]', async t => {
  const helpers = createE2eHelpers();
  t.after(helpers.cleanup);
  const box = helpers.project('true');
  // @pullboard-board-file journey: reservation and verdict share this durable board
  const board = openBoard(join(box.repo, '.git', 'pullboard', 'board.sqlite'));
  t.after(() => store.closeBoard(board));
  const id = document(await fixtureAdd(box.runIn, box.repo, 'web', 'Work with a companion', '--criterion', 'The companion file exists.', '--specs', 'G1', '--check', `node -e "require('node:assert/strict').equal(require('node:fs').readFileSync('web/source.js','utf8').trim(),'export const source = true;')"`, '--json')).item.item_id;
  const builder = document(await asSession(box, 'rc-builder', box.web, 'whoami')).id;
  document(await asSession(box, 'rc-builder', box.web, 'claim', String(id)));
  assert.equal(helpers.commitFile(box, box.web, 'web/source.js', 'export const source = true;\n', 'feat(web): build source [G1]').status, 0);
  const source = box.git(box.web, 'rev-parse', 'HEAD');
  // A pulled submit returns queued: wait for the gate's receipt to move the item before reading its status [C7].
  await settleSubmit(t, box, document(await asSession(box, 'rc-builder', box.web, 'submit', String(id))));
  assert.equal(store.getItem(board, id).item_status, 'submitted', 'the private journey uses the actual native Submit pipeline');
  const patchFile = join(box.dir, 'companion.patch');
  writeFileSync(patchFile, ['diff --git a/web/companion.js b/web/companion.js', 'new file mode 100644', 'index 0000000..e69de29',
    '--- /dev/null', '+++ b/web/companion.js', '@@ -0,0 +1 @@', '+export const companion = true;', ''].join('\n'));
  const attached = document(await box.runIn(box.repo, 'patch', 'attach', String(id), patchFile, '--key', 'view-companion', '--author', builder, '--source', source, '--json'));
  const path = join(box.dir, 'rc-reviewer');
  box.git(box.repo, 'worktree', 'add', '-q', '--detach', path, source);
  document(await asSession(box, 'rc-reviewer', path, 'join', 'web'));

  const bare = await asSession(box, 'rc-reviewer', path, 'verify', String(id), 'reject', '--reason', 'BEHAVIOR_MISMATCH', '--clause', 'The companion file exists.', '--note', 'The companion file is missing.');
  assert.equal(bare.code, 1, bare.err || bare.out);
  const refusal = JSON.parse(bare.out).error;
  assert.equal(refusal.code, 'NOT_AT_COMMIT');
  assert.match(refusal.message, /view-companion/u);
  assert.match(refusal.message, new RegExp(attached.digest, 'u'));
  assert.equal(store.getItem(board, id).item_status, 'submitted', 'the refused verdict changes nothing');

  writeFileSync(join(path, 'web/source.js'), 'preserve this change\n');
  const dirty = await asSession(box, 'rc-reviewer', path, 'next', '--verify', String(id));
  assert.equal(JSON.parse(dirty.out).error.code, 'DIRTY');
  assert.equal(readFileSync(join(path, 'web/source.js'), 'utf8'), 'preserve this change\n');
  box.git(path, 'restore', 'web/source.js');

  const offer = document(await asSession(box, 'rc-reviewer', path, 'next', '--verify'));
  assert.deepEqual(offer.companions.keys, ['view-companion']);
  assert.equal(offer.companions.digest, attached.digest);
  assert.equal(readFileSync(join(path, 'web/companion.js'), 'utf8'), 'export const companion = true;\n', 'NEXT returns with companion files already present, without a manual checkout');
  assert.equal(box.git(path, 'rev-parse', 'HEAD'), offer.companions.commit);

  rmSync(join(path, 'web/companion.js'));
  box.git(path, 'add', '-u');
  box.git(path, 'commit', '-q', '-m', 'test: delete companion [G1]');
  const deleted = await asSession(box, 'rc-reviewer', path, 'verify', String(id), 'reject', '--reason', 'BEHAVIOR_MISMATCH', '--clause', 'The companion file exists.', '--note', 'The descendant deleted the companion.');
  assert.equal(JSON.parse(deleted.out).error.code, 'NOT_AT_COMMIT', 'composition ancestry cannot excuse a later missing file');
  assert.match(JSON.parse(deleted.out).error.message, /view-companion/u);
  const renewed = document(await asSession(box, 'rc-reviewer', path, 'next', '--verify', String(id)));
  assert.equal(renewed.companions.digest, attached.digest);
  assert.equal(existsSync(join(path, 'web/companion.js')), true, 'named reservations also restore the composed tree');

  document(await asSession(box, 'rc-reviewer', path, 'verify', String(id), 'reject', '--reason', 'BEHAVIOR_MISMATCH', '--clause', 'The companion file exists.', '--note', 'Judged with the companion present.'));
  const rejected = store.events(board, { itemId: id }).filter(event => event.event_kind === 'reject').at(-1);
  assert.equal(JSON.parse(rejected.event_detail).companionDigest, attached.digest, 'the verdict records the patch-set digest it reviewed');
});
