/** @pullboard-test-input apps/cli/src/io/landing/automatic.js apps/cli/tests/fixtures/child.js apps/cli/tests/fixtures/landing/backoff.js packages/landing/index.js */
/** An accept, a green gate or a held-test commit wakes a backed-off lander at once [C7]. */
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  after,
  test,
} from 'node:test';
import { createE2eHelpers } from '../../../tests/fixtures/e2e.js';
import { onBoard } from '../../../tests/fixtures/land/board.js';
import { makeLandProjectFixtures } from '../../../tests/fixtures/land/project.js';
import {
  fileFixtureItem,
  joinFixtureSeat,
} from '../../../tests/fixtures/testkit.js';
import {
  HELD,
  HELD_TEXT,
  backingOff,
  command,
  heldTrunk,
  landsBefore,
  leaseRequests,
  record,
  resumeLander,
} from '../../../tests/fixtures/landing/backoff.js';
import * as store from '../../../../../packages/store/index.js';

const e2e = createE2eHelpers();
after(e2e.cleanup);
const { sandbox, project, commitFile } = e2e;
const land = makeLandProjectFixtures({ sandbox, project, commitFile });
const { itemWorktree, acceptItem, submitItem } = land;

test('clause 2: an accept verdict recorded by the real pullboard verify command during a back-off wakes the lander at once [C7]', { timeout: 300_000 }, async t => { // budget: real lander processes on an idle trunk; hang ceiling, not speed.
  const { box } = heldTrunk(t, land);
  const second = itemWorktree(box, 2);
  submitItem(box, second);
  const backed = await backingOff(box);
  // An ordinary command while the lander backs off starts nothing: the back-off holds.
  command(box, 'list');
  assert.equal(record(box).backoff?.retryAt, backed.pending.backoff.retryAt, 'a command without a wake trigger keeps the back-off');
  assert.equal(leaseRequests(box).length, backed.requests, 'no new landing starts');
  acceptItem(box, second);
  await landsBefore(box, backed, second.item, 'the accept wakes the lander, which lands the accepted item');
});

test('clause 3: a green gate that verifies an item, recorded by the real submit, wakes the lander at once during a back-off [C7]', { timeout: 300_000 }, async t => { // budget: real lander processes on an idle trunk; hang ceiling, not speed.
  const { box } = heldTrunk(t, land);
  const path = join(box.dir, 'machine-1');
  box.git(box.repo, 'worktree', 'add', '-q', '-b', 'web/machine-1', path, 'main');
  assert.equal(joinFixtureSeat(box, path, 'web').code, 0);
  const file = 'web/machine-1.txt';
  const id = fileFixtureItem(box, box.repo, { lane: 'web', title: 'Machine fixture', criterion: '1. the result is built [command]',
    check: `test -f ${file}`, args: ['--specs', 'G1'] }).item_id;
  const commands = join(box.dir, 'machine-commands.json');
  writeFileSync(commands, JSON.stringify([{ clause: 1, command: `test "$(cat ${file})" = built` }]));
  command(box, 'edit', String(id), '--machine-verified', 'on', '--machine-commands-file', commands, '--reason', 'Every clause has an executable check');
  assert.equal((await box.runLocal(path, 'claim', String(id))).code, 0);
  assert.equal(commitFile(box, path, file, 'built\n', 'feat(web): build the machine fixture [G1]').status, 0);
  const ticked = await box.runLocal(path, 'fact', String(id), 'note', `clause 1 [command]: test "$(cat ${file})" = built exits 0`);
  assert.equal(ticked.code, 0, ticked.out + ticked.err);
  const backed = await backingOff(box);
  const submitted = await box.runLocal(path, 'submit', String(id), '--no-next');
  assert.equal(submitted.code, 0, submitted.out + submitted.err);
  assert.match(submitted.out + submitted.err, /machine-verified #\d+/u, 'the green gate verified the item');
  assert.equal(onBoard(box, board => store.getItem(board, id).item_status), 'verified');
  await landsBefore(box, backed, id, 'the green gate wakes the lander, which lands the verified item');
});

test('clause 4: a commit to main that touches the held test file wakes the lander at once; another commit does not [C7]', { timeout: 300_000 }, async t => { // budget: real idle landings in a private repo; hang ceiling, not speed.
  const { box } = heldTrunk(t, land);
  await backingOff(box);
  const observed = resumeLander(box, { commits: {
    2: { file: 'web/unrelated.txt', text: 'unrelated\n', message: 'chore: an unrelated trunk change' },
    4: { file: HELD, text: `${HELD_TEXT}// corrected\n`, message: 'test: correct the held fixture test' },
  } });
  assert.equal(observed.backoffs[0].outcome, 'NOTHING_TO_LAND');
  assert.equal(observed.backoffs[0].backoffMs, 120_000, 'the repeated idle landing doubled the first back-off');
  assert.equal(observed.polls, 4, 'the unrelated commit kept the back-off; the held-file commit ended it at the next look');
  assert.ok(observed.clock - observed.start < observed.backoffs[0].backoffMs, 'the wake came before the back-off ended');
  assert.equal(observed.result.backoff, undefined, 'the woken attempt carries no back-off');
  assert.equal(Date.parse(observed.result.reloadAt), observed.clock + 1000, 'the next attempt is due at once');
  assert.equal(observed.pending?.backoff, undefined, 'the pending wake no longer carries the back-off');
  assert.match(box.git(box.repo, 'log', '-1', '--format=%s', '--', HELD), /correct the held fixture test/u, 'a real commit on the trunk changed the held file');
});
