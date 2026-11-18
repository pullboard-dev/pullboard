/** apiBoardListing puts an optional machine name on every board and warning entry, and is unchanged without one [A2,C7,#9538]. */
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { cellProject } from '../../../store/tests/fixtures/cell.js';
import { openCellBoard } from '../../../store/tests/fixtures/cell.js';
import { openBoardForRead } from '../../../store/index.js';
import { apiBoardListing } from '../../index.js';

const boardOpeners = { openBoard: openCellBoard, openBoardForRead, moveArgs: (body) => [body.verb] };
const refusalDocument = (error) => ({ error: { code: error.code ?? 'INTERNAL' } });

/** A readable project and an unreadable folder, so a listing has one board and one warning. */
function fixture(t) {
  const box = cellProject(t, { real: true });
  const unreadable = join(box.dir, 'unreadable');
  mkdirSync(unreadable);
  const projects = () => [
    { root: box.repo, name: 'Readable', project: 'machine', added: '2026-11-16T00:00:00.000Z' },
    { root: unreadable, name: 'Unreadable', project: 'machine', added: '2026-11-16T00:00:00.000Z' },
  ];
  return projects;
}

test('api.board-listing-machine.machinename-option-puts-name-every: clause 1: a machineName option puts that name on every board and warning entry [A2,C7,#9538]', (t) => {
  const listing = apiBoardListing(fixture(t), undefined, refusalDocument, boardOpeners, false, 'studio-mac');
  assert.equal(listing.boards.length, 1);
  assert.equal(listing.warnings.length, 1);
  for (const entry of [...listing.boards, ...listing.warnings]) assert.equal(entry.machine, 'studio-mac');
});

test('api.board-listing-machine.without-option-listing-unchanged-empty: clause 1: without the option the listing is unchanged, and an empty name adds nothing [A2,C7,#9538]', (t) => {
  const projects = fixture(t);
  const plain = apiBoardListing(projects, undefined, refusalDocument, boardOpeners);
  for (const entry of [...plain.boards, ...plain.warnings]) assert.equal('machine' in entry, false);
  assert.deepEqual(apiBoardListing(projects, undefined, refusalDocument, boardOpeners, false, ''), plain);
});
