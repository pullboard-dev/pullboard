/** @pullboard-test-input apps/cli/src/io/commands/show.js apps/cli/src/io/commands/list.js */
/** @pullboard-world-pin: the wiring clause reads the show and list sources, whose call into the merge index is the subject of that clause. */
/** pullboard show and list read an accepted item fresh when its only conflict with main is one the mechanical merge resolves [C7,#3064,#11417]. */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { waitForCondition } from '../../tests/fixtures/runner/holders.js';
import { helpers } from '../../tests/fixtures/scenarios/team.js';
import { assert } from '../../tests/fixtures/scenarios/team.js';
import { test } from '../../tests/fixtures/scenarios/team.js';
import { fileFixtureItem } from '../../tests/fixtures/testkit.js';
import { joinFixtureSeat } from '../../tests/fixtures/testkit.js';
import { mechanicalOnlyConflictTexts } from '../../tests/fixtures/landing/conflict-repos.js';
import { realConflictTexts } from '../../tests/fixtures/landing/conflict-repos.js';

/**
 * Accept item 1 after it changed `texts.file` from `texts.base` to `texts.item`, then land `texts.main` on main: git alone conflicts on that file.
 * The web lane of the fixture project is widened so its builder may commit the helper's own paths.
 */
async function acceptedThenMainMoves(box, texts) {
  const run = async (root, ...args) => {
    const result = await box.runIn(root, ...args);
    assert.equal(result.code, 0, `${args.join(' ')}: ${result.err}${result.out}`);
    return result.out;
  };
  const config = JSON.parse(readFileSync(join(box.repo, 'pullboard.json'), 'utf8'));
  config.lanes.web.owns = ['web/', 'packages/', 'src/'];
  assert.equal((await helpers.commitFile(box, box.repo, 'pullboard.json', JSON.stringify(config, null, 2), 'chore: web lane owns the conflict files [G1]')).status, 0);
  assert.equal((await helpers.commitFile(box, box.repo, texts.file, texts.base, 'feat(web): baseline [G1]')).status, 0);
  box.git(box.web, 'merge', '-q', '--ff-only', 'main');
  await fileFixtureItem(box, box.repo, { lane: 'web', title: 'Conflict', check: `test -f ${texts.file}`, args: ['--specs', 'G1'], wait: true, run: box.runIn });
  await run(box.web, 'claim', '1');
  assert.equal((await helpers.commitFile(box, box.web, texts.file, texts.item, 'feat(web): item edit [G1]')).status, 0);
  const submitted = box.git(box.web, 'rev-parse', 'HEAD');
  await run(box.web, 'submit', '1');
  const reviewer = join(box.dir, 'web-2');
  box.git(box.repo, 'worktree', 'add', '-q', '--detach', reviewer, submitted);
  assert.equal((await joinFixtureSeat(box, reviewer, 'web', { run: box.runIn })).code, 0);
  await run(reviewer, 'next', '--verify', '1');
  await run(reviewer, 'verify', '1', 'accept', '--note', 'The item edit is the whole change and the frozen check observes the file.');
  await waitForCondition(() => {
    const db = new DatabaseSync(join(box.repo, '.git/pullboard/board.sqlite'), { readOnly: true });
    try {
      const latest = db.prepare("SELECT event_detail FROM event WHERE event_kind = 'fact' AND event_detail LIKE '%Review comparison%' ORDER BY event_id DESC LIMIT 1").get();
      return Boolean(latest) && !latest.event_detail.includes('pending');
    } finally { db.close(); }
  }, 'the detached review comparison to record its result');
  assert.equal((await helpers.commitFile(box, box.repo, texts.file, texts.main, 'feat(web): main edits the same file [G1]')).status, 0);
  /** What show and list each say about item 1's verdict state, as the whole record. */
  return async () => {
    const shown = JSON.parse(await run(box.repo, 'show', '1', '--json'));
    const listed = JSON.parse(await run(box.repo, 'list', '--all', '--json'));
    const row = (Array.isArray(listed) ? listed : listed.items).find(item => item.item_id === 1);
    return { shown: shown.item_verdict_state ?? null, listed: row.item_verdict_state ?? null, status: shown.item_status };
  };
}

test('cli.journeys-verify-mechanical-conflict.fresh: clause 1: an accepted item whose only conflict with main is mechanical shows as verified and not stale in pullboard show and pullboard list [C7,#3064,#11417]', async () => {
  const box = helpers.project();
  const states = await acceptedThenMainMoves(box, mechanicalOnlyConflictTexts());
  assert.deepEqual(await states(), { shown: null, listed: null, status: 'verified' }, 'a conflict the mechanical merge resolves leaves the accept fresh in both');
});

test('cli.journeys-verify-mechanical-conflict.stale: clause 2: a real source conflict still shows STALE_VERDICT naming the file in pullboard show and pullboard list [C7,#3064,#11417]', async () => {
  const box = helpers.project();
  const texts = realConflictTexts();
  const states = await acceptedThenMainMoves(box, texts);
  const { shown, listed } = await states();
  for (const state of [shown, listed]) {
    assert.equal(state?.code, 'STALE_VERDICT');
    assert.equal(state.file, texts.file);
  }
});

test('cli.journeys-verify-mechanical-conflict.wiring: clause 3: show and list pass mechanicalConflictFiles from the merge index as residualConflicts to verdictProjector [C7,#3064,#11417]', () => {
  for (const command of ['show', 'list']) {
    const source = readFileSync(join(import.meta.dirname, `../../src/io/commands/${command}.js`), 'utf8');
    assert.match(source, /import\('\.\.\/\.\.\/\.\.\/\.\.\/\.\.\/packages\/merge\/index\.js'\)\)\.mechanicalConflictFiles/u, `${command} reads the port from the merge index`);
    assert.match(source, /verdictProjector\([^\n]*residualConflicts/u, `${command} hands it to verdictProjector`);
  }
});
