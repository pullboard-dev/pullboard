import { after } from 'node:test';
import { test } from 'node:test';
import { createE2eHelpers } from '../../tests/fixtures/e2e.js';
import { onBoard } from '../../tests/fixtures/land/board.js';
import { json } from '../../tests/fixtures/land/board.js';
import { assertParallelLanding } from '../../tests/fixtures/land/parallel.js';
import { assertParallelCliLease } from '../../tests/fixtures/land/parallel.js';
import { assertParallelNestedGate } from '../../tests/fixtures/land/parallel.js';
import { makeLandProjectFixtures } from '../../tests/fixtures/land/project.js';
/** Exercise parallel landing against real private Git worktrees [B3,V4,Q1,Q3]. */
const e2e = createE2eHelpers();
after(e2e.cleanup);
const { sandbox, project, commitFile, BIN } = e2e;
const { landProject, itemWorktree, submitItem, acceptItem } = makeLandProjectFixtures({ sandbox, project, commitFile });

test('landing tests candidate batches in parallel and lands the longest green prefix [B3,V4]', { timeout: 180_000 }, // budget: two real three-item private landings and bounded overlap barriers; no speed threshold.
() => assertParallelLanding({ landProject, itemWorktree, submitItem, acceptItem, json }));

test('parallel CLI landing retains its lease and fences lost authority [B3,V4,Q1,Q3]', { timeout: 180_000 }, // budget: two private CLI landings with cooperative gate barriers; hang ceiling only, no speed threshold.
async () => assertParallelCliLease({ landProject, itemWorktree, submitItem, acceptItem, onBoard, BIN }));

test('parallel landing refuses a live inherited gate before scheduling [B3,V4,Q1,Q3]', { timeout: 90_000 }, // budget: private verified item plus two immediate guarded entries; hang ceiling only.
() => assertParallelNestedGate({ landProject, itemWorktree, submitItem, acceptItem, onBoard, BIN }));
