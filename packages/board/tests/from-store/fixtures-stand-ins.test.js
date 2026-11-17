/** Cell fixtures default to the in-memory Git and board stand-ins in packages/ tests, and give real ones on request [C7]. */
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { currentGitAdapter } from '../../../git/index.js';
import { headCommit } from '../../../git/index.js';
import { realGitAdapter } from '../../../git/index.js';
import { cellBoard } from '../fixtures/cell-board.js';
import { cellProject } from '../../../store/tests/fixtures/cell.js';
import { cellRepo } from '../../../store/tests/fixtures/cell.js';

test('clause 1: a fixture project built without asking for real git gets the in-memory git adapter [C7]', t => {
  const project = cellProject(t);
  assert.equal(project.real, false);
  assert.ok(project.adapter, 'the project carries its stand-in');
  assert.equal(currentGitAdapter(), project.adapter, 'production reads in this test go to the stand-in');
  assert.notEqual(currentGitAdapter(), realGitAdapter);
  assert.equal(existsSync(join(project.repo, '.git', 'HEAD')), false, 'no repository was created on disk');
  assert.match(headCommit(project.repo), /^[0-9a-f]{40}$/u);
  assert.equal(project.git(project.repo, 'rev-parse', 'HEAD'), headCommit(project.repo));
});

test('clause 2: a fixture board built without asking for a real board is an in-memory board [C7]', t => {
  const repo = cellRepo(t);
  const board = cellBoard(t, repo.boardFile);
  assert.ok(board.db, 'the board opens');
  assert.equal(existsSync(repo.boardFile), false, 'no board file was created');
});

test('clause 3: a fixture that asks for real git gets a real repository, and a real board file [C7]', t => {
  const repo = cellRepo(t, { real: true });
  assert.equal(repo.real, true);
  assert.equal(repo.adapter, null);
  assert.ok(existsSync(join(repo.root, '.git', 'HEAD')), 'a real .git folder exists');
  assert.equal(headCommit(repo.root), repo.commit);
  const board = cellBoard(t, repo.boardFile, undefined, { real: true });
  assert.ok(board.db);
  assert.ok(existsSync(repo.boardFile), 'the board file is on disk');
});
