/** The hosted sidebar merges local and relay boards by machine name, with no duplicates [N26,H5]. */
/** @pullboard-test-input source-cell apps/view */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mergeBoards } from '../../src/logic/hosted.js';

test('clause 1: mergeBoards groups boards by machine name and lists a board reachable both ways once [N26]', () => {
  const local = { machine: 'Studio', here: true, boards: [{ id: 'a', name: 'Alpha' }, { id: 'b', name: 'Beta' }] };
  const relay = [{ machine: 'Studio', boards: [{ id: 'b', name: 'Beta' }, { id: 'c', name: 'Gamma' }] }, { machine: 'MacBook', boards: [{ id: 'd', name: 'Delta' }] }];
  const groups = mergeBoards(local, relay);
  assert.deepEqual(groups.map((group) => group.machine), ['Studio', 'MacBook']);
  assert.deepEqual(groups[0].boards.map((board) => board.id), ['a', 'b', 'c']);
  assert.deepEqual(groups[1].boards.map((board) => board.id), ['d']);
  assert.equal(groups.flatMap((group) => group.boards).length, 4);
});

test('clause 2: a group for a board served from another machine is never labeled this computer [N26]', () => {
  const forwarded = { machine: 'MacBook', here: false, boards: [{ id: 'a' }] };
  const groups = mergeBoards(forwarded, [{ machine: 'Studio', boards: [{ id: 'z' }] }]);
  assert.deepEqual(groups.map((group) => group.label), ['MacBook', 'Studio']);
  assert.ok(groups.every((group) => group.label !== 'this computer'));
  const here = mergeBoards({ machine: 'Studio', here: true, boards: [] }, [{ machine: 'MacBook', boards: [] }]);
  assert.deepEqual(here.map((group) => group.label), ['this computer', 'MacBook']);
});
