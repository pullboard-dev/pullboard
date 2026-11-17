/** A rename seals a strict witness only for a configured sensitive path once review defaults are active [C7,#8575]. */
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { join } from 'node:path';
import { test } from 'node:test';
import * as store from '../../../../../store/index.js';
import { cellBoard } from '../../../fixtures/cell-board.js';
import { cellClaim } from '../../../../../store/tests/fixtures/cell.js';
import { cellItem } from '../../../../../store/tests/fixtures/cell.js';
import { cellProject } from '../../../../../store/tests/fixtures/cell.js';
import { cellSeat } from '../../../../../store/tests/fixtures/cell.js';

const GATE_FILE = 'packages/gate/src/logic/preload.js';
const SECRET_FILE = 'secret/key.js';

/** A real repository with a gate source file and a sensitive file, and a claimed item whose commit renames `from` to `to`. */
function renamed(t, from, to) {
  const project = cellProject(t, { real: true, config: { intake: { sensitivePaths: ['secret/'] } } });
  const write = path => { mkdirSync(dirname(join(project.repo, path)), { recursive: true }); writeFileSync(join(project.repo, path), `export const name = '${path}';\n`); };
  write(GATE_FILE); write(SECRET_FILE);
  project.git(project.repo, 'add', '-A');
  project.git(project.repo, 'commit', '-q', '-m', 'chore: base files');
  const board = cellBoard(t, project.boardFile, undefined, { real: true, gitRoot: project.repo });
  cellSeat(board, { lane: 'coordinator', path: project.repo });
  const seatPath = join(project.dir, 'web-seat');
  project.git(project.repo, 'worktree', 'add', '-q', '--detach', seatPath);
  const seat = cellSeat(board, { lane: 'web', path: seatPath, family: 'anthropic' });
  const id = cellItem(board, { lane: 'web', title: 'Move one file', criterion: 'The fixture proves the move.', check: 'true' }).item_id;
  cellClaim(board, id, seat, { root: seatPath });
  mkdirSync(dirname(join(seatPath, to)), { recursive: true });
  project.git(seatPath, 'mv', from, to);
  project.git(seatPath, 'commit', '-q', '-m', 'feat(web): move one file');
  const commit = project.git(seatPath, 'rev-parse', 'HEAD').trim();
  const active = Boolean(board.db.prepare("SELECT 1 FROM board_meta WHERE meta_key='review_default:active'").get());
  return { board, id, commit, active };
}

test('board.strict-rename.submit-renaming-gate-judgment-source-file: clause 1: a submit renaming a gate-judgment source file under active review defaults records no strict rename and stays standard [C7,#8575]', t => {
  const { board, id, commit, active } = renamed(t, GATE_FILE, 'packages/gate/src/io/preload.js');
  assert.equal(active, true, 'the fixture board has review defaults active');
  assert.deepEqual(store.sealStrictRenames(board, id, { commit }).strictRenames, []);
});

test('board.strict-rename.rename-intake-sensitivepaths-file-still-records: clause 2: a rename of an intake.sensitivePaths file still records the strict rename [C7,#8575]', t => {
  const { board, id, commit, active } = renamed(t, SECRET_FILE, 'secret/moved.js');
  assert.equal(active, true, 'the fixture board has review defaults active');
  assert.deepEqual(store.sealStrictRenames(board, id, { commit }).strictRenames, [[SECRET_FILE, 'secret/moved.js']]);
});
