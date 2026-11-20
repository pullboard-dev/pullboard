/** @pullboard-test-input packages/store/src/io/board/claim-table.js packages/store/src/io/needs.js */
/** The live claim snapshot carries an item's needs and a seat's abilities, so the claim table refuses a seat whose abilities lack a need [U136,C7,#1888]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { claimDecision } from '../../../src/io/board/claim-table.js';
import { saveItemNeeds } from '../../../src/io/needs.js';
import { saveAgentAbilities } from '../../../src/io/needs.js';
import { cellBoard } from '../../fixtures/cell.js';
import { cellClaim } from '../../fixtures/cell.js';
import { cellItem } from '../../fixtures/cell.js';
import { cellProject } from '../../fixtures/cell.js';
import { cellSeat } from '../../fixtures/cell.js';

test('store.io-board-claim-table.needs-ability-real-path: clause 1: an item with needs [browser] is refused NEEDS_ABILITY to a seat with no saved abilities and stays open, and a seat given [browser] is not refused NEEDS_ABILITY [U136,C7,#1888]', (t) => {
  const project = cellProject(t, { real: true });
  const board = cellBoard(t, project.boardFile, undefined, { real: true, gitRoot: project.repo });
  board.movesLive = { ...(board.movesLive ?? {}), claim: true };
  // fixture-subject: claimDecision
  assert.equal(typeof claimDecision, 'function');
  const id = cellItem(board, { lane: 'core', title: 'Needs fixture', specIds: ['G1'], route: 'strong', criterion: 'the fixture works' }).item_id;
  saveItemNeeds(board, id, ['browser']);
  const bare = cellSeat(board, { lane: 'core', path: project.repo });
  assert.throws(() => cellClaim(board, id, bare, { root: project.repo }), { code: 'NEEDS_ABILITY' });
  assert.equal(board.db.prepare('SELECT item_status FROM item WHERE item_id=?').get(id).item_status, 'open', 'nothing is written');
  const able = cellSeat(board, { lane: 'core', path: project.repo });
  saveAgentAbilities(board, able.id, ['browser']);
  let code = null;
  try { cellClaim(board, id, able, { root: project.repo }); } catch (error) { code = error.code ?? error.name; }
  assert.notEqual(code, 'NEEDS_ABILITY', 'a seat whose abilities cover the need is not refused for it');
  assert.equal(code, null, 'the claim is written');
});
