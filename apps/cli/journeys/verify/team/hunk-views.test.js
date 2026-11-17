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

/** Merge verify.hunkFreshness into the fixture machine's settings file, keeping what the fixture wrote. */
function hunkFreshness(box, on) {
  const file = join(box.env.PULLBOARD_MACHINE_HOME, 'settings.json');
  let settings = {};
  try { settings = JSON.parse(readFileSync(file, 'utf8')); } catch { /* the fixture wrote none */ }
  mkdirSync(box.env.PULLBOARD_MACHINE_HOME, { recursive: true });
  writeFileSync(file, JSON.stringify({ ...settings, verify: { ...settings.verify, hunkFreshness: on } }));
}

test('clause 1: with verify.hunkFreshness on, show, list and the projector landing builds all read an accepted verdict fresh when main only shifted its hunk; off, all read it stale [C7,#10170]', { timeout: 180_000 }, async t => { // budget: hang ceiling for one real repo and its CLI calls; not a speed target.
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
      { events: store.events, acceptedVerdict: store.acceptedVerdict, verdictReviewProblem: store.verdictReviewProblem, hunkKeyed: hunkFreshnessOn }).state(store.getItem(board, 1)))?.code ?? null;
    return { shown, listed: row.item_verdict_state?.code ?? null, landing };
  };
  let hunkFreshnessOn = false;
  hunkFreshness(box, false);
  assert.deepEqual(await states(), { shown: 'STALE_VERDICT', listed: 'STALE_VERDICT', landing: 'STALE_VERDICT' }, 'off, a shifted hunk reads stale everywhere');
  hunkFreshnessOn = true;
  hunkFreshness(box, true);
  assert.deepEqual(await states(), { shown: null, listed: null, landing: null }, 'on, the shifted hunk reads fresh in show, list and the landing projector alike');
});
