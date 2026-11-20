/** add and edit refuse a prerequisite on a repository with no live link, naming pullboard link [XB1,#11040]. */
// fixture-subject: addItem (the linked case opens the project board to apply a signed link and reads back what add filed)
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { after } from 'node:test';
import { test } from 'node:test';
import { closeBoard } from '../../../packages/store/index.js';
import { listItems } from '../../../packages/store/index.js';
import { boardId } from '../../../packages/store/index.js';
import { boardFilePath } from '../../../packages/store/index.js';
import { addSigner } from '../../../packages/spec/index.js';
import { openBoardForRead } from '../../../packages/store/index.js';
import { fixtureOpenBoard } from './fixtures/board.js';
import { runFixtureChild } from './fixtures/child.js';
import { signedBoard } from './fixtures/board/link.js';
import { createE2eHelpers } from './fixtures/e2e.js';
import { linkBoards } from '../src/io/commands/link.js';

const helpers = createE2eHelpers();
after(helpers.cleanup);

const small = ['--specs', 'G1', '--json'];

/** The ids of every item on the box's board, read straight from its file. */
function filed(box) {
  const board = openBoardForRead(boardFilePath(join(box.repo, '.git')));
  try { return listItems(board).map(item => item.item_id); } finally { closeBoard(board); }
}

test('cli.add-foreign.add-refuses-an-unlinked-repo: clause 1: pullboard add --after host#12 with no live link to host refuses FOREIGN_UNLINKED naming pullboard link, and files nothing [XB1,#11040]', async () => {
  const box = helpers.project('true', helpers.sandbox());
  const refused = await box.inProcess(box.repo, 'add', 'web', 'Waits on host', ...small, '--after', 'host#12');
  assert.notEqual(refused.code, 0);
  assert.match(`${refused.err}${refused.out}`, /FOREIGN_UNLINKED/u);
  assert.match(`${refused.err}${refused.out}`, /pullboard link host/u);
  assert.deepEqual(filed(box), []);
});

test('cli.add-foreign.add-files-with-a-live-link: clause 2: the same add with a live link to host files as before [XB1,#11040]', async (t) => {
  const box = helpers.project('true', helpers.sandbox());
  const key = join(box.dir, 'host-parent-signer');
  const generated = runFixtureChild('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-f', key], { encoding: 'utf8' });
  assert.equal(generated.status, 0, generated.stderr);
  addSigner(box.repo, { by: 'host-parent', key: `${key}.pub` });
  const board = fixtureOpenBoard({ boardFile: boardFilePath(join(box.repo, '.git')), web: box.repo });
  const host = signedBoard(t, 'host');
  try {
    await linkBoards({ board, root: box.repo, reference: { boardId: boardId(board), organization: 'fixture', handle: 'project' }, signer: { by: 'host-parent', key } },
      { ...host, signer: { by: host.by, key: host.key } });
  } finally { closeBoard(board); }
  const added = await box.inProcess(box.repo, 'add', 'web', 'Waits on host', ...small, '--after', 'host#12');
  assert.doesNotMatch(`${added.err}${added.out}`, /FOREIGN_UNLINKED/u);
  assert.equal(added.code, 0, added.err + added.out);
  assert.equal((filed(box)).length, 1);
});

test('cli.add-foreign.edit-refuses-an-unlinked-repo: clause 3: pullboard edit --after with no live link to host refuses FOREIGN_UNLINKED and leaves the item as filed [XB1,#11040]', async () => {
  const box = helpers.project('true', helpers.sandbox());
  const added = await box.inProcess(box.repo, 'add', 'web', 'Plain item', ...small);
  assert.equal(added.code, 0, added.err + added.out);
  const id = JSON.parse(added.out).item.item_id;
  const refused = await box.inProcess(box.repo, 'edit', String(id), '--after', 'host#12');
  assert.notEqual(refused.code, 0);
  assert.match(`${refused.err}${refused.out}`, /FOREIGN_UNLINKED/u);
  const shown = await box.inProcess(box.repo, 'show', String(id), '--json');
  assert.doesNotMatch(shown.out, /host#12/u);
});
