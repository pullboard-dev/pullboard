/** The verify path gets a board link's signer authority and sealing capability from boardLinkPorts, and a missing signer or key refuses naming pullboard link [E32,H16,#11157]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as store from '../../../../../packages/store/index.js';
import { boardLinkBody } from '../../../../../packages/kernel/index.js';
import { generateBoardKey } from '../../../../../packages/kernel/index.js';
import { privateFixtureFiles } from '../../../../../packages/gate/tests/fixtures/child.js';
import { boardLinkPorts } from '../../../src/io/link/ports.js';
import { signedBoard } from '../../fixtures/board/link.js';
import { consent } from '../../fixtures/board/link.js';

/** Two signed boards and their consented link record, as the link-file journey builds them. */
async function signedLink(t) {
  const parent = signedBoard(t, 'parent');
  const child = signedBoard(t, 'child');
  const authority = store.createSshBoardLinkAuthority([parent, child]);
  const record = await consent(store, authority, parent, child, 'ports-link');
  return { parent, child, record };
}

test('cli.io-link-ports.capability-binds-the-record-body: clause 1: boardLinkPorts returns an authority and a capability whose binding is the JSON of the link record body [E32,H16]', async (t) => {
  const { parent, child, record } = await signedLink(t);
  const key = await generateBoardKey();
  const ports = boardLinkPorts({ child, parent, record, readKey: (boardId) => (boardId === parent.reference.boardId ? key : undefined) });
  assert.equal(ports.capability.binding, JSON.stringify(boardLinkBody(record)));
  assert.equal(typeof ports.authority.sign, 'function');
  assert.equal(typeof ports.authority.verify, 'function');
});

test('cli.io-link-ports.missing-signer-or-key-refuses: clause 2: a board with no signer file, or a readKey that returns nothing, refuses BOARD_LINK_AUTH naming pullboard link [E32,H16]', async (t) => {
  const { parent, child, record } = await signedLink(t);
  const key = await generateBoardKey();
  const refused = (error) => error.code === 'BOARD_LINK_AUTH' && /pullboard link/u.test(error.message);
  const unsigned = { board: child.board, root: privateFixtureFiles('pullboard-link-ports-').root };
  assert.throws(() => boardLinkPorts({ child: unsigned, parent, record, readKey: () => key }), refused);
  assert.throws(() => boardLinkPorts({ child, parent, record, readKey: () => undefined }), refused);
});
