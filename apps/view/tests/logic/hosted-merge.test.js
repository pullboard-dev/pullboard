/** The hosted sidebar merges local and relay boards by machine name, with no duplicates [N26,H5]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mergeBoards } from '../../src/logic/hosted.js';

test('view.x-hosted-merge.clause-1-mergeboards-groups-boards-by-machine: clause 1: mergeBoards groups boards by machine name and lists a board reachable both ways once [N26]', () => {
  const local = { machine: 'Tower', here: true, boards: [{ id: 'a', name: 'Alpha' }, { id: 'b', name: 'Beta' }] };
  const relay = [{ machine: 'Tower', boards: [{ id: 'b', name: 'Beta' }, { id: 'c', name: 'Gamma' }] }, { machine: 'Laptop', boards: [{ id: 'd', name: 'Delta' }] }];
  const groups = mergeBoards(local, relay);
  assert.deepEqual(groups.map((group) => group.machine), ['Tower', 'Laptop']);
  assert.deepEqual(groups[0].boards.map((board) => board.id), ['a', 'b', 'c']);
  assert.deepEqual(groups[1].boards.map((board) => board.id), ['d']);
  assert.equal(groups.flatMap((group) => group.boards).length, 4);
});

test('view.x-hosted-merge.clause-2-a-group-for-a-board: clause 2: a group for a board served from another machine is never labeled this computer [N26]', () => {
  const forwarded = { machine: 'Laptop', here: false, boards: [{ id: 'a' }] };
  const groups = mergeBoards(forwarded, [{ machine: 'Tower', boards: [{ id: 'z' }] }]);
  assert.deepEqual(groups.map((group) => group.label), ['Laptop', 'Tower']);
  assert.ok(groups.every((group) => group.label !== 'this computer'));
  const here = mergeBoards({ machine: 'Tower', here: true, boards: [] }, [{ machine: 'Laptop', boards: [] }]);
  assert.deepEqual(here.map((group) => group.label), ['this computer', 'Laptop']);
});
