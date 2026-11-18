/** With verify.hunkFreshness on, show, list and the state projector read a verdict fresh or stale exactly as landing does [C7,#10170]. @pullboard-test-input source-cell apps/cli packages/verify packages/config */
import { mkdirSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { waitForCondition } from '../../../tests/fixtures/runner/holders.js';
import { helpers } from '../../../tests/fixtures/scenarios/team.js';
import { assert } from '../../../tests/fixtures/scenarios/team.js';
import { test } from '../../../tests/fixtures/scenarios/team.js';
import { withBoard } from '../../../tests/fixtures/scenarios/team.js';
import { store } from '../../../tests/fixtures/scenarios/team.js';
import { fileFixtureItem } from '../../../tests/fixtures/testkit.js';
import { joinFixtureSeat } from '../../../tests/fixtures/testkit.js';
import { verdictProjector } from '../../../../../packages/verify/index.js';

/** Thirty numbered lines, with the given line replaced and the given line inserted after line 1. */
const notes = ({ replace, insert } = {}) => {
  const lines = Array.from({ length: 30 }, (_, index) => `line ${index}`);
  if (replace) lines[19] = replace;
  if (insert) lines.splice(2, 0, insert);
  return `${lines.join('\n')}\n`;
};

/** Merge verify settings into the fixture machine's settings file, keeping what the fixture wrote. */
function verifySettings(box, values) {
  const file = join(box.env.PULLBOARD_MACHINE_HOME, 'settings.json');
  let settings = {};
  try { settings = JSON.parse(readFileSync(file, 'utf8')); } catch { /* the fixture wrote none */ }
  mkdirSync(box.env.PULLBOARD_MACHINE_HOME, { recursive: true });
  writeFileSync(file, JSON.stringify({ ...settings, verify: { ...settings.verify, ...values } }));
}

/** Merge verify.hunkFreshness into the fixture machine's settings file. */
function hunkFreshness(box, on) { verifySettings(box, { hunkFreshness: on }); }

test('cli.journeys-verify-team-hunk-views.with-verify-hunkfreshness-on-show-list: clause 1: with verify.hunkFreshness on, show, list and the projector landing builds all read an accepted verdict fresh when main only shifted its hunk; an edit to the reviewed hunk reads stale in all three [C7,#10170]', { timeout: 180_000 }, async t => { // budget: hang ceiling for one real repo and its CLI calls; not a speed target.
  const box = helpers.project();
  /** Run a fixture CLI command through the journey seam and return its output, failing on a refusal. */
  const run = async (root, ...args) => {
    const result = await box.runIn(root, ...args);
    assert.equal(result.code, 0, `${args.join(' ')}: ${result.err}${result.out}`);
    return result.out;
  };
  assert.equal((await helpers.commitFile(box, box.repo, 'web/notes.txt', notes(), 'feat(web): baseline [G1]')).status, 0);
  box.git(box.web, 'merge', '-q', '--ff-only', 'main');
  await fileFixtureItem(box, box.repo, { lane: 'web', title: 'Notes', check: "grep -q '^item twenty$' web/notes.txt", args: ['--specs', 'G1'], wait: true, run: box.runIn });
  await run(box.web, 'claim', '1');
  assert.equal((await helpers.commitFile(box, box.web, 'web/notes.txt', notes({ replace: 'item twenty' }), 'feat(web): notes [G1]')).status, 0);
  const submitted = box.git(box.web, 'rev-parse', 'HEAD');
  await run(box.web, 'submit', '1');
  const reviewer = join(box.dir, 'web-2');
  box.git(box.repo, 'worktree', 'add', '-q', '--detach', reviewer, submitted);
  assert.equal((await joinFixtureSeat(box, reviewer, 'web', { run: box.runIn })).code, 0);
  await run(reviewer, 'next', '--verify', '1');
  await run(reviewer, 'verify', '1', 'accept', '--note', 'The notes change line twenty and the frozen check observes it.');
  await waitForCondition(() => {
    const db = new DatabaseSync(join(box.repo, '.git/pullboard/board.sqlite'), { readOnly: true });
    try {
      const latest = db.prepare("SELECT event_detail FROM event WHERE event_kind = 'fact' AND event_detail LIKE '%Review comparison%' ORDER BY event_id DESC LIMIT 1").get();
      return Boolean(latest) && !latest.event_detail.includes('pending');
    } finally { db.close(); }
  }, 'the detached review comparison to record its result', { signal: t.signal });
  // Main inserts a line near the top: the reviewed hunk is untouched but its line numbers shift.
  assert.equal((await helpers.commitFile(box, box.repo, 'web/notes.txt', notes({ insert: 'main added' }), 'feat(web): main inserts [G1]')).status, 0);
  /** What show, list and the landing-style projector each say about item 1's verdict. */
  const states = async () => {
    const shown = JSON.parse(await run(box.repo, 'show', '1', '--json')).item_verdict_state?.code ?? null;
    const listed = JSON.parse(await run(box.repo, 'list', '--all', '--json'));
    const row = (Array.isArray(listed) ? listed : listed.items).find(item => item.item_id === 1);
    const tip = box.git(box.repo, 'rev-parse', 'HEAD');
    const landing = withBoard(box.repo, board => verdictProjector(box.repo, board, { main: tip },
      { events: store.events, acceptedVerdict: store.acceptedVerdict, verdictReviewProblem: store.verdictReviewProblem, hunkKeyed: true }).state(store.getItem(board, 1)))?.code ?? null;
    return { shown, listed: row.item_verdict_state?.code ?? null, landing };
  };
  hunkFreshness(box, true);
  assert.deepEqual(await states(), { shown: null, listed: null, landing: null }, 'on, a shifted hunk reads fresh in show, list and the landing projector alike');
  // Main then edits the reviewed line itself: every reader agrees the review is stale.
  assert.equal((await helpers.commitFile(box, box.repo, 'web/notes.txt', notes({ insert: 'main added', replace: 'main twenty' }), 'feat(web): main edits [G1]')).status, 0);
  assert.deepEqual(await states(), { shown: 'STALE_VERDICT', listed: 'STALE_VERDICT', landing: 'STALE_VERDICT' }, 'on, an edit to the reviewed hunk reads stale in all three');
});

/**
 * Review item 1 (it changes line twenty of web/notes.txt) with both settings on, and move main inside the frozen check: the check commits `payload` to
 * web/notes.txt on main while the review runs. Main first moves after the submit so the submit proof is unusable and the check really runs.
 */
async function acceptWhileMainMoves(box, payload) {
  const run = async (root, ...args) => {
    const result = await box.runIn(root, ...args);
    assert.equal(result.code, 0, `${args.join(' ')}: ${result.err}${result.out}`);
    return result.out;
  };
  const move = join(box.dir, 'move-main-during-review');
  const staged = join(box.dir, 'main-payload.txt');
  writeFileSync(staged, payload);
  assert.equal((await helpers.commitFile(box, box.repo, 'web/notes.txt', notes(), 'feat(web): baseline [G1]')).status, 0);
  box.git(box.web, 'merge', '-q', '--ff-only', 'main');
  const check = `grep -q '^item twenty$' web/notes.txt && if test -f '${move}'; then cp '${staged}' '${box.repo}/web/notes.txt' && git -C '${box.repo}' add web/notes.txt && git -C '${box.repo}' commit -q -m 'chore: main moves during review [G1]'; fi`;
  await fileFixtureItem(box, box.repo, { lane: 'web', title: 'Notes', check, args: ['--specs', 'G1'], wait: true, run: box.runIn });
  await run(box.web, 'claim', '1');
  assert.equal((await helpers.commitFile(box, box.web, 'web/notes.txt', notes({ replace: 'item twenty' }), 'feat(web): notes [G1]')).status, 0);
  const submitted = box.git(box.web, 'rev-parse', 'HEAD');
  await run(box.web, 'submit', '1');
  assert.equal((await helpers.commitFile(box, box.repo, 'web/notes.txt', notes({ insert: 'pre added' }), 'feat(web): main inserts after the submit [G1]')).status, 0);
  const reviewer = join(box.dir, 'web-2');
  box.git(box.repo, 'worktree', 'add', '-q', '--detach', reviewer, submitted);
  assert.equal((await joinFixtureSeat(box, reviewer, 'web', { run: box.runIn })).code, 0);
  await run(reviewer, 'next', '--verify', '1');
  verifySettings(box, { hunkFreshness: true, unrelatedTrunkMoves: true });
  writeFileSync(move, 'armed');
  return box.runIn(reviewer, 'verify', '1', 'accept', '--note', 'The notes change line twenty and the frozen check observes it.', '--json');
}

test('cli.journeys-verify-team-hunk-views.with-verify-unrelatedtrunkmoves-and-verify-hunkfreshness: clause 1: with verify.unrelatedTrunkMoves and verify.hunkFreshness on, accept succeeds after main changes the item file at a different hunk during review [C7,#2981]', { timeout: 240_000 }, async () => { // budget: hang ceiling for one real repo and its CLI calls; not a speed target.
  const box = helpers.project();
  const accepted = await acceptWhileMainMoves(box, notes({ insert: 'pre added' }).replace('line 29', 'main tail'));
  assert.equal(accepted.code, 0, accepted.out + accepted.err);
  assert.equal(withBoard(box.repo, board => store.verdictsFor(board, 1)).length, 1, 'the accept is recorded');
});

test('cli.journeys-verify-team-hunk-views.with-verify-unrelatedtrunkmoves-and-verify-hunkfreshness-on: clause 2: with verify.unrelatedTrunkMoves and verify.hunkFreshness on, accept is refused VERDICT_TRUNK_MOVED naming the changed hunk header when main changes a hunk of the item patch during review [C7,#2981]', { timeout: 240_000 }, async () => { // budget: hang ceiling for one real repo and its CLI calls; not a speed target.
  const box = helpers.project();
  const refused = await acceptWhileMainMoves(box, notes({ insert: 'pre added', replace: 'item twenty' }));
  // Main lands the very same line: it merges without a conflict, but the reviewed hunk no longer composes into a change.
  assert.equal(refused.code, 1, refused.out + refused.err);
  const { error } = JSON.parse(refused.out);
  assert.equal(error.code, 'VERDICT_TRUNK_MOVED');
  assert.match(error.message, /"web\/notes\.txt" "@@ -21 \+21 @@[^"]*"/u, 'the refusal names the changed hunk header: ' + error.message);
  assert.deepEqual(withBoard(box.repo, board => store.verdictsFor(board, 1)), [], 'no verdict is recorded');
});
