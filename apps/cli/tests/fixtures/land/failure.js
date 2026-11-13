/** The composed-landing parser-failure fixture: a private repository, persistent native board, submitted and accepted items [C7]. */
import assert from 'node:assert/strict';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { getItem } from '../../../../../packages/store/index.js';
import { createE2eHelpers } from '../e2e.js';
import { captureCommandInProcess } from '../process.js';
import { main } from '../native.js';
import { FIXTURE_MODEL } from '../testkit.js';
import { joinFixtureSeat } from '../testkit.js';
import { onBoard } from './board.js';
import { whenRunnerSettles } from '../runner/local-start.js';
import { settleSubmit } from '../submit/settle.js';
import { settleLand } from './settle.js';

/** Run actual submit, review and landing against one private Git repository and persistent native board. */
export async function fixture(t, { duplicate = false, unrelated = false } = {}) {
  const helpers = createE2eHelpers();
  t.after(helpers.cleanup);
  const box = helpers.project('true', helpers.sandbox({ declareFamilies: true }));
  /** The public CLI retains normal authorization, composition, proof writing and hooks. */
  const cli = (cwd, ...args) => captureCommandInProcess(main, args, { cwd, env: box.env });
  const marker = join(box.dir, 'candidate-module-executed');
  /** One item's row, read through the board kit on each call so a runner's later writes show. */
  const itemOf = id => onBoard(box, board => getItem(board, id));
  mkdirSync(join(box.repo, 'web'), { recursive: true });
  writeFileSync(join(box.repo, 'package.json'), '{"type":"module"}\n');
  writeFileSync(join(box.repo, 'web/value.js'), 'export const value = 1;\n');
  writeFileSync(join(box.repo, 'web/client.js'), "import { value } from './value.js';\nimport { writeFileSync } from 'node:fs';\n"
    + `writeFileSync(${JSON.stringify(marker)}, 'executed');\nexport const result = value;\n`);
  box.git(box.repo, 'add', '-A');
  box.git(box.repo, 'commit', '-q', '-m', 'chore: private healthy module graph');
  box.git(box.web, 'merge', '-q', '--ff-only', 'main');
  const remote = join(box.dir, 'origin.git');
  box.git(box.dir, 'init', '-q', '--bare', remote);
  box.git(box.repo, 'remote', 'add', 'origin', remote);
  box.git(box.repo, 'push', '-q', '-u', 'origin', 'main');
  /** Add, claim, commit, submit and independently accept one item from the given worktree; return its id. */
  const accepted = async (seat, name, file, bad, reviewerName) => {
  const added = await cli(box.repo, 'add', 'web', name, '--specs', 'G1',
    '--brief', `Files: ${file}\nChange: add the marker\nTest: the marker file exists`, '--criterion', 'The change marker exists.', '--check', `test -f ${file}`, '--wait', '--json');
  assert.equal(added.code, 0, added.err + added.out);
  const item = JSON.parse(added.out).item.item_id;
  const claim = await cli(seat, 'claim', String(item));
  assert.equal(claim.code, 0, claim.err);
  writeFileSync(join(seat, file), 'source change\n');
  if (bad) writeFileSync(join(seat, 'web/client.js'), "import { value } from './value.js';\nimport { value } from './value.js';\nexport const result = value;\n");
  box.git(seat, 'add', '-A');
  box.git(seat, 'commit', '-q', '-m', 'feat(web): private landing source [G1]');
  const submitted = await cli(seat, 'submit', String(item), '--wait', '--no-next', '--json');
  assert.equal(submitted.code, 0, submitted.err + submitted.out);
  const settled = await settleSubmit(t, box, JSON.parse(submitted.out));
  const reviewer = join(box.dir, reviewerName);
  // The gate job reads done a moment before its receipt moves the item off claimed; wait for that move, never past a red.
  // budget: hang ceiling for one receipt write after the gate job is done, never a speed assertion.
  const pending = await whenRunnerSettles(box.env, () => { const row = itemOf(item); return row.item_status === 'claimed' ? null : row; },
    { deadlineMs: 60_000, what: `#${item} leaving claimed after its gate` });
  assert.equal(pending.item_status, 'submitted', `#${item} settled its gate but is ${pending.item_status}: ${JSON.stringify(settled.gate ?? settled).slice(0, 600)}`);
  box.git(box.repo, 'worktree', 'add', '-q', '--detach', reviewer, pending.item_commit);
  const joinedReviewer = await cli(reviewer, 'join', 'api', '--family', 'Fixture Review Vendor', '--model', FIXTURE_MODEL, '--json');
  assert.equal(joinedReviewer.code, 0, joinedReviewer.err + joinedReviewer.out);
  const reserved = await cli(reviewer, 'next', '--verify', String(item), '--json');
  assert.equal(reserved.code, 0, reserved.err + reserved.out);
  const accepted = await cli(reviewer, 'verify', String(item), 'accept', '--no-next',
    '--note', 'The actual frozen change-marker command passed in the reserved composition.', '--json');
  assert.equal(accepted.code, 0, accepted.err + accepted.out);
  assert.equal(itemOf(item).item_status, 'verified');
  return item;
  };
  const item = await accepted(box.web, 'Source with landing inputs', 'web/change.txt', duplicate, 'landing-reviewer');
  const source = box.git(box.web, 'rev-parse', 'HEAD');
  let other = null;
  if (unrelated) {
    const second = join(box.dir, 'web-2');
    box.git(box.repo, 'worktree', 'add', '-q', second, '-b', 'web/two', 'main');
    const joined = joinFixtureSeat(box, second, 'web', { model: FIXTURE_MODEL });
    assert.equal(joined.code, 0, joined.out + joined.err);
    other = await accepted(second, 'Independent change', 'web/other.txt', false, 'landing-reviewer-two');
  }
  return { ...box, itemOf, item, other, source, marker, runLocal: cli, before: box.git(box.repo, 'rev-parse', 'main') };
}

/** Offer one land job and wait for its receipt; a blocked batch is the receipt's outcome, not an exit code [C7,#4265]. */
export async function landOnce(box) {
  const landed = await box.runLocal(box.repo, 'land', '--json');
  return settleLand(box, JSON.parse(landed.out));
}

