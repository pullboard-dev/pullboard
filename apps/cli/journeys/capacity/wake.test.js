/** Native health sweeps supply independent review capacity through the local wake contract [C7]. */
import assert from 'node:assert/strict';
import {
  chmodSync,
  existsSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { openBoard } from '../../../lib/index.js';
import {
  closeBoard,
  getItem,
  heartbeatSeat,
  recentShouts,
} from '../../../../packages/store/index.js';
import { REVIEW_WAKE_WAIT_MS } from '../../../../packages/sentinels/index.js';
import { SEAT_LIVE_WINDOW_MS } from '../../../../packages/store/index.js';
import { createE2eHelpers } from '../../tests/fixtures/e2e.js';
import { captureCommandInProcess } from '../../tests/fixtures/process.js';
import { main } from '../../tests/fixtures/native.js';

/** Submit real source-bound green work, then advance only the injected native clock. */
async function fixture(t, { command = true, fails = false, awake = false } = {}) {
  const helpers = createE2eHelpers();
  t.after(helpers.cleanup);
  const box = helpers.project('true');
  const staleBy = Math.max(0, SEAT_LIVE_WINDOW_MS - REVIEW_WAKE_WAIT_MS + 2);
  let at = Date.now();
  const clock = { now: () => new Date(at) };
  /** Preserve actual parsing, authorization, board writes, health scans and executable delivery. */
  const cli = (cwd, ...argv) => captureCommandInProcess((args, streams) => main(args, { ...streams, clock }), argv,
    { cwd, env: box.env });
  const added = await cli(box.repo, 'add', 'web', 'Waiting native review', '--specs', 'G1',
    '--criterion', 'The source marker exists.', '--check', 'test -f web/review-ready', '--brief', 'Files: web/review-ready\nTest: the source marker exists.', '--wait', '--json');
  assert.equal(added.code, 0, added.err + added.out);
  const item = JSON.parse(added.out).item.item_id;
  const claim = await cli(box.web, 'claim', String(item));
  assert.equal(claim.code, 0, claim.err);
  const built = helpers.commitFile(box, box.web, 'web/review-ready', 'ready', 'feat(web): native review source [G1]');
  assert.equal(built.status, 0, built.stderr);
  const submitted = await cli(box.web, 'submit', String(item), '--wait', '--no-next');
  assert.equal(submitted.code, 0, submitted.err + submitted.out);
  const output = join(box.dir, 'wake-arguments.jsonl');
  const executable = join(box.dir, 'reviewer-wake.mjs');
  writeFileSync(executable, `#!${process.execPath}\nimport { appendFileSync } from 'node:fs';\nappendFileSync(${JSON.stringify(output)},JSON.stringify(process.argv.slice(2))+'\\n');\nprocess.exitCode=${fails ? 1 : 0};\n`);
  chmodSync(executable, 0o755);
  const reviewer = join(box.dir, 'independent-reviewer');
  box.git(box.repo, 'worktree', 'add', '-q', '-b', 'api/reviewer-wake', reviewer);
  // The reviewer enrolled before the submission, so its heartbeat is already past the live window at the sweep.
  at -= staleBy;
  const joined = await cli(reviewer, 'join', 'api', '--model', 'Independent fixture reviewer', '--family', 'Independent Fixture Vendor',
    ...(command ? ['--wake', executable] : []), '--json');
  assert.equal(joined.code, 0, joined.err + joined.out);
  at += staleBy;
  // @pullboard-board-file journey: the real CLI in this fixture repo owns the board file; the test seeds or reads that same file.
  const board = openBoard(join(box.repo, '.git/pullboard/board.sqlite'), clock);
  t.after(() => closeBoard(board));
  assert.equal(getItem(board, item).item_status, 'submitted');
  // Wake tests need an idle reviewer even when the queue's deadline is shorter than seat liveness.
  at += REVIEW_WAKE_WAIT_MS - 1;
  if (awake) {
    assert.equal(heartbeatSeat(board, JSON.parse(joined.out).agent), true, 'the native local observation protocol marks the reviewer awake');
  }
  /** Run exactly the background health-sweep entry point through its native coordinator. */
  const sweep = () => cli(box.repo, 'sentinel', 'run', '--health-only', '--json');
  /** Observe the real executable's completed writes rather than its launch notification. */
  const wakes = () => existsSync(output) ? readFileSync(output, 'utf8').trim().split('\n').map(row => JSON.parse(row)) : [];
  /** Count only person requests from this capacity rule, excluding ordinary health notices. */
  const requests = () => recentShouts(board).filter(row => row.shout_to === 'person' && row.shout_text.startsWith(`#${item} needs an independent reviewer:`));
  /** Advance the injected fixture clock without sleeping or changing recorded event timestamps. */
  function advance(milliseconds) { at += milliseconds; }
  return { ...box, item, board, sweep, wakes, requests, advance };
}

test('one health sweep wakes an eligible independent reviewer with its exact green item once [C7]', async t => {
  const box = await fixture(t);
  const early = await box.sweep();
  assert.equal(early.code, 0, early.err + early.out);
  assert.deepEqual(box.wakes(), [], 'the five-minute review deadline has not passed');
  assert.deepEqual(box.requests(), []);
  box.advance(1);
  for (let sweep = 0; sweep < 2; sweep++) {
    const result = await box.sweep();
    assert.equal(result.code, 0, result.err + result.out);
  }
  assert.deepEqual(box.wakes(), [[String(box.item)]]);
  assert.deepEqual(box.requests(), [], 'a successful registered wake never asks the person');
});

test('an eligible awake reviewer needs no new wake or person request [C7]', async t => {
  const box = await fixture(t, { awake: true });
  const early = await box.sweep();
  assert.equal(early.code, 0, early.err + early.out);
  assert.deepEqual(box.requests(), []);
  box.advance(1);
  const result = await box.sweep();
  assert.equal(result.code, 0, result.err + result.out);
  assert.deepEqual(box.wakes(), []);
  assert.deepEqual(box.requests(), []);
});

test('clause 1: missing or failed eligible reviewer wake commands ask the person once per item [C7]', async t => {
  for (const options of [{ command: false }, { fails: true }]) {
    await t.test(options.fails ? 'registered command fails [C7]' : 'no registered command [C7]', async child => {
      const box = await fixture(child, options);
      const early = await box.sweep();
      assert.equal(early.code, 0, early.err + early.out);
      assert.deepEqual(box.wakes(), [], 'the five-minute review deadline has not passed');
      assert.deepEqual(box.requests(), []);
      box.advance(1);
      for (let sweep = 0; sweep < 2; sweep++) {
        const result = await box.sweep();
        assert.equal(result.code, 0, result.err + result.out);
      }
      assert.equal(box.wakes().length, options.fails ? 1 : 0);
      assert.equal(box.requests().length, 1);
      assert.match(box.requests()[0].shout_text, /required reviewer family: independent fixture vendor/u);
    });
  }
});
