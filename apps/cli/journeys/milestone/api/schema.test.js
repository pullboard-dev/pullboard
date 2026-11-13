import { openBoard } from '../../../../lib/index.js';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { test } from 'node:test';
import { closeBoard } from '../../../../../packages/store/index.js';
import { projectState } from '../../../src/io/view.js';
import { json } from '../../../tests/fixtures/api/project.js';
import { project } from '../../../tests/fixtures/api/project.js';

test('[A2] API projection from a borrowed staged board matches the normal view and leaves it open', () => {
  const box = project();
  json(box, box.repo, 'add', ['app', 'Projection fixture', '--criterion', 'same projector']);
  const board = openBoard(join(box.repo, '.git/pullboard/board.sqlite'));
  try {
    const ordinary = projectState(box.repo);
    const staged = projectState(box.repo, { board });
    // The timeline window is read from the wall clock on each call, so two builds differ by milliseconds.
    const stable = (state) => JSON.parse(JSON.stringify(state, (key, value) => (key === 'since' || key === 'until' ? undefined : value)));
    assert.deepEqual(stable(staged), stable(ordinary), 'the staged path uses the exact API projectState projection');
    assert.doesNotThrow(() => board.db.prepare('SELECT 1').get(), 'the caller retains ownership of its borrowed board connection');
  } finally { closeBoard(board); }
});
