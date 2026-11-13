import { flakeQuarantines as nativeFlakeQuarantines } from '../../../../packages/flakes/index.js';
import { gateRuns as nativeGateRuns } from '../../../../packages/flakes/index.js';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { after } from 'node:test';
import { test } from 'node:test';
import * as store from '../../../../packages/store/index.js';
import { createE2eHelpers } from '../../tests/fixtures/e2e.js';
import { onBoard } from '../../tests/fixtures/land/board.js';
import { calls } from '../../tests/fixtures/land/board.js';
import { json } from '../../tests/fixtures/land/board.js';
import { makeLandProjectFixtures } from '../../tests/fixtures/land/project.js';
/** Exercise deferred and affected landings against real private Git worktrees [B3,R3,C7,V4]. */
const e2e = createE2eHelpers();
after(e2e.cleanup);
const { sandbox, project, commitFile } = e2e;
const { FILES, landProject } = makeLandProjectFixtures({ sandbox, project, commitFile });

test('a publish gate run is recorded and a red and green pair it sees files the flake [C7,D1]', () => {
  const box = landProject();
  const configFile = join(box.repo, 'pullboard.json');
  const config = JSON.parse(readFileSync(configFile, 'utf8'));
  writeFileSync(configFile, JSON.stringify({ ...config, flakes: { rerun: false } }, null, 2));
  assert.equal(commitFile(box, box.repo, FILES[0], 'RED\n', 'test: commit the publish target [G1]').status, 0);
  const tree = box.git(box.repo, 'rev-parse', 'HEAD^{tree}');
  const firstHead = box.git(box.repo, 'rev-parse', 'HEAD');
  const remoteBefore = box.git(box.remote, 'rev-parse', 'main');
  const before = calls(box).length;
  const red = box.run(box.repo, 'publish', '--json');
  assert.equal(red.code, 1, red.err);
  /** Read only the receipts actual gate executions wrote. */
  const runs = () => onBoard(box, board => nativeGateRuns(board));
  /** Count repair items independently of unrelated diagnostic observations. */
  const flakes = () => onBoard(box, board => store.listItems(board, { all: true }).filter(item => item.item_title.startsWith('Flaky test:')));
  const [failed] = runs();
  assert.ok(failed, 'the red publish records its authentic gate receipt');
  assert.equal(failed.tree, tree);
  assert.equal(failed.green, false);
  assert.equal(failed.by, 'coordinator');
  assert.equal(failed.failures[0].file, FILES[0]);
  assert.equal(flakes().length, 0, 'one red run alone does not prove a flake');
  assert.equal(box.git(box.remote, 'rev-parse', 'main'), remoteBefore, 'the red head stays local');
  assert.equal(json(box, box.repo, 'publish').waiting, true, 'the same red HEAD still waits');
  assert.equal(runs().length, 1, 'waiting records no fabricated execution');
  assert.equal(calls(box).length - before, 1);

  // New commit, unchanged tree: publish may try again without bypassing its same-HEAD retry guard.
  box.env.LAND_SUPPRESS_RED = '1';
  box.git(box.repo, 'commit', '--allow-empty', '-q', '-m', 'test: observe the same tree again [G1]');
  const greenHead = box.git(box.repo, 'rev-parse', 'HEAD');
  assert.notEqual(greenHead, firstHead);
  assert.equal(box.git(box.repo, 'rev-parse', 'HEAD^{tree}'), tree);
  assert.equal(json(box, box.repo, 'publish').published, true);
  assert.equal(box.git(box.remote, 'rev-parse', 'main'), greenHead);
  assert.deepEqual(runs().map(run => [run.tree, run.green]), [[tree, false], [tree, true]]);
  const [repair] = flakes();
  assert.equal(flakes().length, 1, 'publish alone proves the same-tree flake and files it once');
  assert.ok(repair.item_brief.includes(failed.id) && repair.item_brief.includes(runs()[1].id), 'the item cites both actual publish receipts');
  assert.equal(onBoard(box, board => nativeFlakeQuarantines(board)).length, 1);

  box.git(box.repo, 'commit', '--allow-empty', '-q', '-m', 'test: observe a third publish [G1]');
  assert.equal(json(box, box.repo, 'publish').published, true);
  assert.deepEqual(runs().map(run => [run.tree, run.green]), [[tree, false], [tree, true], [tree, true]]);
  assert.equal(flakes().length, 1, 'another publish receipt creates no duplicate flake item');
  assert.equal(calls(box).length - before, 3, 'each receipt represents one actual full publish gate');
});

// The landing-gate timeout case went with the host landing batch: a runner land job runs no host landing gate, and L6e
// deletes that engine (#6119), so it is no longer journeyed here [P7,#6577].
