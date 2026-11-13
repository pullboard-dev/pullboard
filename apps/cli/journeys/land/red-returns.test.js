/** With no affectedTests (the init default), a red at landing goes back to its builder with its failing cases [C7,#6270]. */
import assert from 'node:assert/strict';
import {
  chmodSync,
  copyFileSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from 'node:fs';
import {
  isAbsolute,
  join,
} from 'node:path';
import {
  after,
  test,
} from 'node:test';
import { createE2eHelpers } from '../../tests/fixtures/e2e.js';
import { makeLandProjectFixtures } from '../../tests/fixtures/land/project.js';

const e2e = createE2eHelpers();
after(e2e.cleanup);
const { landProject, itemWorktree, submitItem, acceptItem, moveMainPastSubmit } = makeLandProjectFixtures(e2e);

/** A plain landing project in the default shape: no affectedTests, per-item landing, no landing.publish, pushed to its origin. */
function defaultProject() {
  const box = landProject();
  const path = join(box.repo, 'pullboard.json');
  const config = JSON.parse(readFileSync(path, 'utf8'));
  delete config.affectedTests;
  delete config.landing.perItem;
  delete config.landing.publish;
  writeFileSync(path, JSON.stringify(config, null, 2));
  box.git(box.repo, 'commit', '-q', '-am', 'chore: the init default has no affectedTests');
  box.git(box.repo, 'push', '-q', 'origin', 'main');
  return box;
}

/** Build, submit and accept one item whose file is red in the whole suite, with the red hidden while it is proved. */
function acceptedRedItem(box) {
  const entry = itemWorktree(box, 1);
  box.env.LAND_SUPPRESS_RED = '1';
  try { submitItem(box, entry, 'RED\n'); acceptItem(box, entry); } finally { delete box.env.LAND_SUPPRESS_RED; }
  return entry;
}

/** The item's board row, read through show --json. */
async function itemRow(box, id) {
  const shown = await box.runLocal(box.repo, 'show', String(id), '--json');
  assert.equal(shown.code, 0, shown.out + shown.err);
  const document = JSON.parse(shown.out);
  return document.item ?? document;
}

/** The builder claims the returned item again, fixes it and resubmits green. */
async function fixAndResubmit(box, entry) {
  const claimed = await box.runLocal(entry.path, 'claim', String(entry.item));
  assert.equal(claimed.code, 0, claimed.out + claimed.err);
  submitItem(box, entry, 'PASS\n');
}

/** Wrap the repository's pre-push hook so it runs the whole gate with the red visible and no green stamp to skip on. */
function strictPrePush(box) {
  const configured = box.tryGit(box.repo, 'config', 'core.hooksPath').stdout.trim();
  const source = configured ? (isAbsolute(configured) ? configured : join(box.repo, configured)) : join(box.repo, '.git', 'hooks');
  const hooks = join(box.dir, 'strict-hooks');
  mkdirSync(hooks, { recursive: true });
  for (const name of readdirSync(source)) if (!name.endsWith('.sample')) { copyFileSync(join(source, name), join(hooks, name)); chmodSync(join(hooks, name), 0o755); }
  copyFileSync(join(source, 'pre-push'), join(hooks, 'pre-push.real'));
  writeFileSync(join(hooks, 'pre-push'), '#!/bin/sh\nunset LAND_SUPPRESS_RED\nrm -f "$(git rev-parse --git-path pullboard-gate-green)"\nexec "$(dirname "$0")/pre-push.real" "$@"\n');
  chmodSync(join(hooks, 'pre-push'), 0o755);
  box.git(box.repo, 'config', 'core.hooksPath', hooks);
}

test('clause 1: with no affectedTests a red at landing returns the item to its builder with its failing case; main and origin stay untouched [C7,#6270]', { timeout: 180_000 }, // budget: one real submit, accept, landing and resubmit; hang ceiling only.
async () => {
  const box = defaultProject();
  const entry = acceptedRedItem(box);
  moveMainPastSubmit(box);
  const main = box.git(box.repo, 'rev-parse', 'main'), origin = box.git(box.repo, 'rev-parse', 'origin/main');
  const landed = await box.runLocal(box.repo, 'land', '--json');
  const output = landed.out + landed.err;
  assert.doesNotMatch(output, /LAND_MAIN_COMPARISON/u, output);
  assert.equal(box.git(box.repo, 'rev-parse', 'main'), main, 'main keeps its tree');
  assert.equal(box.tryGit(box.repo, 'ls-remote', 'origin', 'main').stdout.split(/\s+/u)[0], origin, 'origin keeps its tree');
  const row = await itemRow(box, entry.item);
  assert.equal(row.item_status ?? row.status, 'open', output);
  assert.ok(!(row.item_hold_at ?? row.hold), 'the item is not parked');
  const shown = await box.runLocal(box.repo, 'show', String(entry.item));
  assert.match(shown.out, /web\/land-1\.test\.js/u, 'show names the failing case');
  await fixAndResubmit(box, entry);
});

test('clause 2: a pre-push hook red returns the item the same way instead of parking LAND_PUSH [C7,#6270]', { timeout: 180_000 }, // budget: one real submit, accept, landing push and resubmit; hang ceiling only.
async () => {
  const box = defaultProject();
  const entry = acceptedRedItem(box);
  strictPrePush(box);
  const main = box.git(box.repo, 'rev-parse', 'main'), origin = box.git(box.repo, 'rev-parse', 'origin/main');
  box.env.LAND_SUPPRESS_RED = '1';
  let output;
  try { const landed = await box.runLocal(box.repo, 'land', '--json'); output = landed.out + landed.err; }
  finally { delete box.env.LAND_SUPPRESS_RED; }
  assert.match(output, /LAND_PUSH|pre-push/u, `the push reached the red pre-push gate: ${output}`);
  assert.equal(box.git(box.repo, 'rev-parse', 'main'), main, 'main keeps its tree');
  assert.equal(box.tryGit(box.repo, 'ls-remote', 'origin', 'main').stdout.split(/\s+/u)[0], origin, 'origin keeps its tree');
  const row = await itemRow(box, entry.item);
  assert.equal(row.item_status ?? row.status, 'open', output);
  assert.ok(!(row.item_hold_at ?? row.hold), 'the item is not parked LAND_PUSH');
  const shown = await box.runLocal(box.repo, 'show', String(entry.item));
  assert.match(shown.out, /the gate is red/u, 'show prints the pre-push red');
  await fixAndResubmit(box, entry);
});
