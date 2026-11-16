/** @pullboard-test-input source-tree packages/codemap/data/plan/cells.json packages/codemap/data/plan/** */
/** Every packages/state/data/history/<digits>.json is placed by one rule, so a landing that adds an engine never jams on it [C7]. */
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { unplanned } from '../../../../codemap/index.js';
import { readPlan } from '../../../../codemap/index.js';
import { moveHistoryPlacement } from '../../../../codemap/index.js';
import { requirePlannedSource } from '../../../../items/index.js';
import { runFixtureChild } from '../../fixtures/child.js';
import { fixture } from '../../../../landing/tests/fixtures/plan.js';
import { git } from '../../../../landing/tests/fixtures/plan.js';

const BIN = fileURLToPath(new URL('../../../../codemap/src/io/cells/scripts/plan.js', import.meta.url));

/** A committed fixture repository with a written plan, so the next history file is the only new path. */
function planned(t) {
  const box = fixture(t);
  const written = runFixtureChild(process.execPath, [BIN, '--write'], { cwd: box.root, encoding: 'utf8' });
  assert.equal(written.status, 0, written.stdout + written.stderr);
  git(box.root, 'add', '-A');
  git(box.root, 'commit', '-q', '-m', 'plan');
  return box;
}

test('clause 1: a new packages/state/data/history/999.json is placed by rule and --check reports nothing unplaced [C7]', t => {
  const { root, put } = planned(t);
  put('packages/state/data/history/999.json', '{"version":1,"engine":999,"declarations":{}}\n');
  git(root, 'add', '-A');
  const result = runFixtureChild(process.execPath, [BIN, '--check'], { cwd: root, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.doesNotMatch(result.stderr, /move-history/u);
  assert.deepEqual(unplanned(root, readPlan(root)), []);
  assert.match(moveHistoryPlacement('packages/state/data/history/999.json'), /canonical engine identity retained in src/u);
  assert.equal(moveHistoryPlacement('packages/state/data/history/legacy.json'), null, 'only digit names take the rule');
  assert.equal(moveHistoryPlacement('packages/state/data/history/999.json.bak'), null);
  assert.match(moveHistoryPlacement('src/move-history/152.json'), /canonical engine identity retained in src/u, 'a 0.9.3 board keeps its old folder');
});

test('clause 2: the merged-tree placement check accepts a new move-history file and, with plan placement dropped, refuses no source [C7]', t => {
  const { root, put } = planned(t);
  const base = git(root, 'rev-parse', 'HEAD').trim();
  put('packages/state/data/history/999.json', '{"version":1,"engine":999,"declarations":{}}\n');
  git(root, 'add', '-A');
  git(root, 'commit', '-q', '-m', 'engine history');
  const head = git(root, 'rev-parse', 'HEAD').trim();
  assert.doesNotThrow(() => requirePlannedSource(root, base, head));
  put('src/unplaced.js', 'export const unplaced = 1;\n');
  git(root, 'add', '-A');
  git(root, 'commit', '-q', '-m', 'unplaced source');
  // Plan placement is dropped (#6365): requirePlannedSource is a pinned no-op, so an unplaced source is no longer refused.
  assert.doesNotThrow(() => requirePlannedSource(root, base, git(root, 'rev-parse', 'HEAD').trim()));
});
