/**
 * A reject or reopen during landing [C7]: two verified items are selected for one landing batch, and while the
 * batch's landing gate holds (after select, before any merge reaches main) the coordinator reopens the second.
 * The invariant: every landing step re-checks verified at the commit, so the reopened item drops out of the batch;
 * main never takes its commit, it records no merge, and the item stays open. The other item still lands.
 * Run alone with `node packages/gate/tests/fixtures/pipeline/a-reject-or-reopen-during-landing.js`.
 */
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { existsSync } from 'node:fs';
import { test } from 'node:test';
import {
  ROOT,
  from,
  guardProcesses,
  hopCheck,
  track,
  waitUntil,
} from './kit.js';

const { createE2eHelpers } = await from('apps/cli/tests/fixtures/e2e.js');
const { makeLandProjectFixtures } = await from('apps/cli/tests/fixtures/land/project.js');
const { startFixtureChild } = await from('apps/cli/tests/fixtures/child.js');

const helpers = createE2eHelpers();
const { landProject, itemWorktree, submitItem, acceptItem, moveMainPastSubmit } = makeLandProjectFixtures(helpers);
let box;
guardProcesses({ before: () => { if (box) writeFileSync(box.release, 'release\n'); } });

test('a reopen between select and merge drops the item from the landing batch; main never takes it [C7]', { timeout: 240_000 }, async () => {
  await hopCheck('landing-reopen', async () => {
    box = landProject();
    track(box.dir);
    const kept = itemWorktree(box, 1);
    const dropped = itemWorktree(box, 2);
    for (const entry of [kept, dropped]) submitItem(box, entry);
    for (const entry of [kept, dropped]) acceptItem(box, entry);
    // Main moves past the submits, so the landing runs its own gate instead of reusing a submit's receipt.
    moveMainPastSubmit(box, 1);
    writeFileSync(box.hold, 'armed');
    const started = Date.now();
    const landing = startFixtureChild(process.execPath, [`${ROOT}/apps/cli/pullboard.js`, 'land', '--max', '2', '--json'], { cwd: box.repo, env: box.env, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '', err = '';
    landing.stdout.on('data', part => { out += part; });
    landing.stderr.on('data', part => { err += part; });
    const closed = new Promise(done => landing.once('close', code => done(code)));
    await waitUntil(() => existsSync(box.entered), 'the landing gate holds with both items selected', 120_000, 100);
    const reopened = box.run(box.repo, 'reopen', String(dropped.item), '--note', `packages/gate/tests/fixtures/pipeline/a-reject-or-reopen-during-landing.js: reopened while its landing gate held; merge commit ${dropped.commit}`);
    assert.equal(reopened.code, 0, reopened.err + reopened.out);
    writeFileSync(box.release, 'release\n');
    const code = await closed;
    const show = id => JSON.parse(box.run(box.repo, 'show', String(id), '--json').out);
    const after = show(dropped.item);
    assert.notEqual(after.item_status, 'verified', 'the reopened item is no longer verified');
    assert.equal(after.item_merged_commit, null, 'the reopened item records no merge');
    const onMain = box.git(box.repo, 'branch', '--contains', dropped.commit, '--list', 'main');
    assert.equal(onMain, '', 'main never took the reopened item\'s commit');
    assert.ok(box.tryGit(box.repo, 'merge-base', '--is-ancestor', dropped.commit, 'origin/main').status !== 0, 'origin never took it either');
    // The batch built before the reopen is refused whole (LAND_ITEM_MOVED); the next landing rebuilds it without the reopened item.
    assert.match(out + err, /LAND_ITEM_MOVED/u, `the stale batch is refused, not published (exit ${code}): ${err.slice(-300)}${out.slice(-300)}`);
    const again = box.run(box.repo, 'land', '--max', '2', '--json');
    assert.ok(show(kept.item).item_merged_commit, `the next landing lands the other item (exit ${again.code}): ${again.err.slice(-300)}${again.out.slice(-300)}`);
    assert.equal(box.git(box.repo, 'branch', '--contains', dropped.commit, '--list', 'main'), '', `main still never took the reopened item's commit; dropped is ${show(dropped.item).item_status}; land said ${again.out.slice(-600)}; main log ${box.git(box.repo, 'log', '--oneline', '-6', 'main')}; dropped ${dropped.commit}`);
    return { ms: Date.now() - started, measured: `reopened #${dropped.item} mid-gate; it stayed ${after.item_status}, #${kept.item} landed on the next landing, main untouched by it` };
  });
});
