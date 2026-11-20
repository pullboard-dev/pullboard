/** pullboard link: one signed states link between two boards on this machine, refused without both signers [E32,B24,#11038]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readBoardLinks } from '../../../../../packages/store/index.js';
import { privateFixtureFiles } from '../../../../../packages/gate/tests/fixtures/child.js';
import { signedBoard } from '../../fixtures/board/link.js';
import { linkBoards } from '../../../src/io/commands/link.js';

test('cli.io-commands-link.signs-one-link: clause 1: linking a child with both board signer keys on this machine applies one signed states link on both boards, the current board being the parent [E32,#11038]', async (t) => {
  const parent = signedBoard(t, 'parent-board');
  const child = signedBoard(t, 'child-board');
  const record = await linkBoards({ ...parent, signer: { by: parent.by, key: parent.key } }, { ...child, signer: { by: child.by, key: child.key } });
  for (const box of [parent, child]) {
    const links = readBoardLinks(box.board);
    assert.equal(links.length, 1);
    assert.equal(links[0].linkId, record.linkId);
    assert.equal(links[0].disclosure, 'states');
    assert.equal(links[0].parent.boardId, parent.reference.boardId);
    assert.equal(links[0].child.boardId, child.reference.boardId);
    assert.equal(links[0].approvals.length, 2);
  }
});

test('cli.io-commands-link.missing-signer-refused: clause 2: a child board with no signer refuses BOARD_LINK_AUTH naming the next step and writes no link on either board [E32,#11038]', async (t) => {
  const parent = signedBoard(t, 'parent-board');
  const child = signedBoard(t, 'child-board');
  const unsigned = privateFixtureFiles('pullboard-link-unsigned-').root;
  await assert.rejects(
    linkBoards({ ...parent, signer: { by: parent.by, key: parent.key } }, { ...child, root: unsigned, signer: { by: child.by, key: child.key } }),
    error => error.code === 'BOARD_LINK_AUTH' && /signer/u.test(error.message),
  );
  assert.equal(readBoardLinks(parent.board).length, 0);
  assert.equal(readBoardLinks(child.board).length, 0);
});
