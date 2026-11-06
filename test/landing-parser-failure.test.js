/** A parser failure in a composed landing blocks its batch and charges the implicated item, not the train [C7]. */
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { openBoard } from '../apps/lib/index.js';
import { closeBoard, getItem, checkedLandingCommit } from '../packages/store/index.js';
import { createE2eHelpers } from './e2e-helpers.js';
import { captureCommandInProcess } from './cli-in-process-fixture.js';
import { main } from './native-cli-fixture.js';

/** Run actual submit, review and landing against one private Git repository and persistent native board. */
async function fixture(t, { duplicate = false } = {}) {
  const helpers = createE2eHelpers();
  t.after(helpers.cleanup);
  const box = helpers.project('true', helpers.sandbox({ declareFamilies: true }));
  /** The public CLI retains normal authorization, composition, proof writing and hooks. */
  const cli = (cwd, ...args) => captureCommandInProcess(main, args, { cwd, env: box.env });
  const marker = join(box.dir, 'candidate-module-executed');
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
  const added = await cli(box.repo, 'add', 'web', 'Source with landing inputs', '--specs', 'G1',
    '--brief', 'Files: web/change.txt\nChange: add the marker\nTest: the marker file exists', '--criterion', 'The change marker exists.', '--check', 'test -f web/change.txt', '--wait', '--json');
  assert.equal(added.code, 0, added.err + added.out);
  const item = JSON.parse(added.out).item.item_id;
  const claim = await cli(box.web, 'claim', String(item));
  assert.equal(claim.code, 0, claim.err);
  writeFileSync(join(box.web, 'web/change.txt'), 'source change\n');
  if (duplicate) writeFileSync(join(box.web, 'web/client.js'), "import { value } from './value.js';\nimport { value } from './value.js';\nexport const result = value;\n");
  box.git(box.web, 'add', '-A');
  box.git(box.web, 'commit', '-q', '-m', 'feat(web): private landing source [G1]');
  const source = box.git(box.web, 'rev-parse', 'HEAD');
  const submitted = await cli(box.web, 'submit', String(item), '--wait', '--no-next', '--json');
  assert.equal(submitted.code, 0, submitted.err + submitted.out);
  const board = openBoard(join(box.repo, '.git/pullboard/board.sqlite'), undefined, { gitRoot: box.repo });
  t.after(() => closeBoard(board));
  const reviewer = join(box.dir, 'landing-reviewer');
  box.git(box.repo, 'worktree', 'add', '-q', '--detach', reviewer, getItem(board, item).item_commit);
  const joinedReviewer = await cli(reviewer, 'join', 'api', '--family', 'Fixture Review Vendor', '--model', 'fixture-reviewer', '--json');
  assert.equal(joinedReviewer.code, 0, joinedReviewer.err + joinedReviewer.out);
  const reserved = await cli(reviewer, 'next', '--verify', String(item), '--json');
  assert.equal(reserved.code, 0, reserved.err + reserved.out);
  const accepted = await cli(reviewer, 'verify', String(item), 'accept', '--no-next',
    '--note', 'The actual frozen change-marker command passed in the reserved composition.', '--json');
  assert.equal(accepted.code, 0, accepted.err + accepted.out);
  assert.equal(getItem(board, item).item_status, 'verified');
  return { ...box, board, item, source, marker, cli, before: box.git(box.repo, 'rev-parse', 'main') };
}

test('clause 1: a duplicate import in the composed landing blocks its batch and returns the implicated item, main unmoved [C7]', async t => {
  const box = await fixture(t, { duplicate: true });
  const landed = await box.cli(box.repo, 'land', '--json');
  assert.equal(landed.code, 0, landed.err + landed.out);
  const batch = JSON.parse(landed.out).batch;
  assert.equal(batch.state, 'blocked');
  assert.match(batch.refusal?.code ?? JSON.stringify(batch), /LAND_MODULE_PARSE/u);
  assert.match(landed.out, /web\/client\.js/u);
  assert.equal(getItem(box.board, box.item).item_status, 'open', 'the implicated item goes back to open');
  assert.equal(box.git(box.repo, 'rev-parse', 'main'), box.before);
  assert.equal(existsSync(box.marker), false);
});

test('clause 2: the next landing proceeds without adopting the same parser failure again [C7]', async t => {
  const box = await fixture(t, { duplicate: true });
  assert.equal((await box.cli(box.repo, 'land', '--json')).code, 0);
  const next = await box.cli(box.repo, 'land', '--json');
  assert.equal(next.code, 0, next.err + next.out);
  assert.doesNotMatch(next.out + next.err, /LAND_ADOPT|LAND_MODULE_PARSE/u);
  assert.equal(box.git(box.repo, 'rev-parse', 'main'), box.before);
});
