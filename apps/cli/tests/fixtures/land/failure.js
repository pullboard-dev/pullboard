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


/**
 * Record one forced landing, no verdict, whose builder is a really submitted seat of the chosen model family, and return its item id.
 * Why: `verify.family` reads the builder's declared family, so a landing built by no seat, or by a seat of no family, is offered to
 * no reviewer and cannot prove the other-family offer (runs 47aea589 and f96787e7, #4992) [C7,#9862].
 *
 * @param {object} box - A box from `fixture`.
 * @param {object} t - The running test, for the submit settle.
 * @param {{ family: string, name?: string, land?: boolean }} options - The builder seat's declared family; `land: false` stops at the submitted, unreviewed item [C7,#9864].
 * @returns {Promise<number>}
 */
export async function landedBy(box, t, { family, name = `Landed by ${family}`, land = true }) {
  /** The public CLI, in process, exactly as `fixture` drives it. */
  const cli = (cwd, ...args) => captureCommandInProcess(main, args, { cwd, env: box.env });
  const slug = family.toLowerCase().replace(/[^a-z0-9]+/gu, '-');
  const file = `web/landed-by-${slug}.txt`;
  const seat = join(box.dir, `builder-${slug}`);
  box.git(box.repo, 'worktree', 'add', '-q', seat, '-b', `web/${slug}`, 'main');
  const joined = await cli(seat, 'join', 'web', '--family', family, '--model', FIXTURE_MODEL, '--json');
  assert.equal(joined.code, 0, joined.err + joined.out);
  const added = await cli(box.repo, 'add', 'web', name, '--specs', 'G1',
    '--brief', `Files: ${file}\nChange: add the marker\nTest: the marker file exists`, '--criterion', 'The change marker exists.', '--check', `test -f ${file}`, '--wait', '--json');
  assert.equal(added.code, 0, added.err + added.out);
  const item = JSON.parse(added.out).item.item_id;
  const claim = await cli(seat, 'claim', String(item));
  assert.equal(claim.code, 0, claim.err);
  writeFileSync(join(seat, file), 'source change\n');
  box.git(seat, 'add', '-A');
  box.git(seat, 'commit', '-q', '-m', 'feat(web): private landed-by source [G1]');
  const submitted = await cli(seat, 'submit', String(item), '--wait', '--no-next', '--json');
  assert.equal(submitted.code, 0, submitted.err + submitted.out);
  await settleSubmit(t, box, JSON.parse(submitted.out));
  // budget: hang ceiling for one receipt write after the gate job is done, never a speed assertion.
  const pending = await whenRunnerSettles(box.env, () => { const row = onBoard(box, board => getItem(board, item)); return row.item_status === 'claimed' ? null : row; },
    { deadlineMs: 60_000, what: `#${item} leaving claimed after its gate` });
  assert.equal(pending.item_status, 'submitted', `#${item} settled its gate but is ${pending.item_status}`);
  if (!land) return item;
  // A forced merge records only a commit already on main, as the blitz lander leaves it.
  box.git(box.repo, 'merge', '-q', '--no-edit', `web/${slug}`);
  const merged = await cli(box.repo, 'merged', String(item), pending.item_commit, '--forced', 'blitz lander landed it before review', '--waive-proof', 'fixture', '--json');
  assert.equal(merged.code, 0, merged.out + merged.err);
  return item;
}
