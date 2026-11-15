// pullboard: browser
/** @pullboard-test-input source-tree */
/** @pullboard-test-gui */
/** @pullboard-test-loads apps/cli/src/io/view.js apps/cli/index.js */
/** Cockpit sidebar grouping of readable and unreadable boards [N33, N34, N36]. */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { SPEC } from '../../tests/fixtures/cockpit/harness.js';
import { machine } from '../../tests/fixtures/cockpit/harness.js';
import { project } from '../../tests/fixtures/cockpit/harness.js';
import { buildLocal } from '../../tests/fixtures/cockpit/harness.js';
import { fetchLive } from '../../tests/fixtures/cockpit/harness.js';
import { startView } from '../../tests/fixtures/cockpit/harness.js';
import { openPage } from '../../tests/fixtures/cockpit/harness.js';

/** The coordinator sends an item back from a checkout of its submitted commit, awaiting each board command in this process. */
async function sendBackLocal(box, p, id, note) {
  box.git(p.repo, 'switch', '-q', '--detach', p.itemBranches.get(`${p.baseBranch}:${id}`) ?? p.branch);
  const item = JSON.parse(await box.inProcess(p.repo, 'show', String(id), '--json'));
  const clause = JSON.parse(item.item_frozen).criterion;
  await box.inProcess(p.repo, 'verify', String(id), 'reject', '--reason', 'BEHAVIOR_MISMATCH', '--clause', clause, '--note', note, '--as', 'coordinator');
  box.git(p.repo, 'switch', '-q', 'main');
}

test('unreadable boards collapse to one line with Forget all while projects group readable repos with combined needs and activity [N33, N34, N36]', async () => {
  const box = machine();
  const core = project(box, 'core', `${SPEC}- G3 [pending] Should #1 greet in French?\n`, { name: 'Core API', project: 'Atlas' });
  await box.inProcess(core.repo, 'add', 'web', 'Core target #1', '--specs', 'G1', '--criterion', 'greets');
  await buildLocal(box, core, 1, 'greeting.html', { queued: true });
  const web = project(box, 'web', SPEC, { name: 'Web UI', project: 'Atlas' });
  await box.inProcess(web.repo, 'add', 'web', 'Target for #1', '--specs', 'G1', '--criterion', 'has a header');
  await buildLocal(box, web, 1, 'header.html', { queued: true });
  box.settled(core.repo, 1);
  box.settled(web.repo, 1);
  await sendBackLocal(box, core, 1, 'the page needs a greeting');
  await box.inProcess(web.repo, 'shout', 'person', 'Ship #1 today?', '--decision');
  const standalone = project(box, 'standalone', SPEC, { name: 'Scratchpad' }, { joinSeat: false, bare: true });
  const broken = project(box, 'broken', SPEC, { name: 'Broken repo', project: 'Atlas' }, { joinSeat: false, bare: true });
  const brokenTwo = project(box, 'broken-two', SPEC, { name: 'Broken repo two', project: 'Atlas' }, { joinSeat: false, bare: true });
  const brokenThree = project(box, 'broken-three', SPEC, { name: 'Broken repo three', project: 'Elsewhere' }, { joinSeat: false, bare: true });
  const recoveredConfig = readFileSync(join(brokenThree.repo, 'pullboard.json'));
  const view = await startView(box);
  try {
    const headers = { 'x-pullboard-key': view.key };
    let response = await fetchLive(`${view.base}/api/v1/boards`, { headers });
    let state = await response.json();
    assert.deepEqual(state.boards.filter((repo) => repo.project === 'Atlas').map((repo) => repo.name), ['Core API', 'Web UI', 'Broken repo', 'Broken repo two']);
    writeFileSync(join(broken.repo, 'pullboard.json'), '{not valid json');
    writeFileSync(join(brokenTwo.repo, 'pullboard.json'), '{not valid json');
    writeFileSync(join(brokenThree.repo, 'pullboard.json'), '{not valid json');
    response = await fetchLive(`${view.base}/api/v1/boards`, { headers });
    state = await response.json();
    const unreadable = state.warnings.find((repo) => repo.root === broken.repo);
    assert.equal(state.warnings.length, 3);
    assert.equal(unreadable.error.version, 1);
    assert.equal(unreadable.error.error.code, 'BOARD_UNAVAILABLE');
    assert.match(unreadable.error.error.message, /cannot be read/);
    assert.match(unreadable.error.error.message, /pullboard forget/);
    assert.doesNotMatch(unreadable.error.error.message, /BAD_CONFIG|SyntaxError/);

    const page = await openPage(view);
    const side = page.show('proj-list');
    assert.match(side, /class="repo-group"/);
    assert.match(side, /data-root="group:Atlas"/);
    assert.match(side, /Core API/);
    assert.match(side, /Web UI/);
    assert.match(side, /Scratchpad/);
    assert.match(side, /<summary>3 boards can no longer be found<\/summary>/);
    const disclosure = side.indexOf('<details class="unreadable-projects">');
    assert.ok(disclosure >= 0, 'the path list stays collapsed until opened');
    for (const root of [broken.repo, brokenTwo.repo, brokenThree.repo]) assert.ok(!side.slice(0, disclosure).includes(root), 'paths are disclosed only in the expanded list');
    assert.match(side, /<b>Broken repo<\/b> <code>[^<]+<\/code>/);
    assert.match(side, /<b>Broken repo two<\/b> <code>[^<]+<\/code>/);
    assert.match(side, /<b>Broken repo three<\/b> <code>[^<]+<\/code>/);
    assert.doesNotMatch(side, /registered project [^<]+ cannot be read/);
    assert.match(side, /data-forget-unreadable>Forget all<\/button>/);
    assert.doesNotMatch(side, /class="small bad"|class="bad"/);

    response = await fetchLive(`${view.base}/api/v1/projects/forget-unreadable`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ confirm: true }),
    });
    assert.equal(response.status, 403, 'the mutation requires this view session key');
    response = await fetchLive(`${view.base}/api/v1/projects/forget-unreadable`, {
      method: 'POST', headers: { ...headers, 'content-type': 'application/json' }, body: JSON.stringify({ confirm: true, roots: [broken.repo] }),
    });
    assert.equal(response.status, 400, 'the browser cannot choose project roots');

    page.run('globalThis.__forgetConfirmCalls = 0; globalThis.confirm = () => { globalThis.__forgetConfirmCalls++; return false; }');
    await page.click({ forgetUnreadable: '' });
    assert.equal(page.run('globalThis.__forgetConfirmCalls'), 1);
    assert.equal(page.requests.filter((request) => request.path === '/api/v1/projects/forget-unreadable').length, 0, 'cancel leaves the registry unchanged');

    // A stale disclosure cannot forget a board that became readable after the page listed it.
    writeFileSync(join(brokenThree.repo, 'pullboard.json'), recoveredConfig);
    page.run('globalThis.confirm = () => { globalThis.__forgetConfirmCalls++; return true; }');
    await page.click({ forgetUnreadable: '' });
    assert.equal(page.run('globalThis.__forgetConfirmCalls'), 2);
    assert.ok(page.requests.some((request) => request.path === '/api/v1/projects/forget-unreadable' && request.method === 'POST' && request.body?.confirm === true));
    assert.ok(page.requests.filter((request) => request.path === '/api/v1/projects/forget-unreadable').every((request) => Object.keys(request.body).length === 1), 'the browser sends confirmation, never project paths');
    assert.doesNotMatch(page.show('proj-list'), /unreadable-projects|<b>Broken repo<\/b>|<b>Broken repo two<\/b>/);
    assert.match(page.show('proj-list'), /Broken repo three/);
    response = await fetchLive(`${view.base}/api/v1/boards`, { headers });
    state = await response.json();
    assert.equal(state.warnings.length, 0);
    assert.ok(state.boards.some((repo) => repo.root === brokenThree.repo && repo.name === 'Broken repo three'));
    assert.ok(state.boards.some((repo) => repo.root === core.repo), 'healthy registered boards are preserved');

    await page.click({ root: 'group:Atlas' });
    assert.equal(page.element('group-view').hidden, false);
    assert.equal(page.element('tabs').hidden, true);
    assert.match(page.show('group-needs'), /Core API/);
    assert.match(page.show('group-needs'), /Web UI/);
    assert.match(page.show('group-needs'), /<b>Core API<\/b><code>G3<\/code><span>Should <a class="ref" href="\/Core%20API\/items\/1" data-go="item:1" data-board="[^"]+" title="Core target #1">#1<\/a> greet in French\?<\/span><button data-root="[^"]+" type="button"><em>answer G3 →<\/em><\/button>/, "a question in one repo's spec, in the person's words");
    assert.doesNotMatch(page.show('group-needs'), /pullboard spec answer|answer in SPEC\.md/, 'the person never gets a command or the old wording on a button (#875)');
    assert.match(page.show('group-needs'), /<b>Web UI<\/b><code>coordinator \(unknown\)<\/code><span>Ship <a class="ref" href="\/Web%20UI\/items\/1" data-go="item:1" data-board="[^"]+" title="Target for #1">#1<\/a> today\?<\/span><button data-root="[^"]+" type="button"><em>decision, /, "and a decision in another's");
    assert.doesNotMatch(page.show('group-needs'), /sent back|to verify|Greeting|Header/, "work sent back or waiting for a verdict is the agents', not the person's");
    assert.match(page.show('group-activity'), /Core API/);
    assert.match(page.show('group-activity'), /Web UI/);
    assert.match(page.show('group-activity'), /Greeting|Target/);
    const activityRefs = [...page.show('group-activity').matchAll(/<a class="ref" href="[^"]+" data-go="item:1" data-board="([^"]+)" title="([^"]+)"/g)].map((link) => [link[1], link[2]]);
    assert.ok(activityRefs.some(([root, title]) => root === core.repo && title === 'Core target #1'), 'activity links bind Core API #1 to its repo');
    assert.ok(activityRefs.some(([root, title]) => root === web.repo && title === 'Target for #1'), 'activity links bind Web UI #1 to its repo');

    assert.deepEqual([...page.show('group-needs').matchAll(/<a class="ref" href="[^"]+" data-go="item:1" data-board="([^"]+)" title="([^"]+)"/g)].map((link) => [link[1], link[2]]), [
      [core.repo, 'Core target #1'], [web.repo, 'Target for #1'],
    ], 'each duplicate #1 keeps the repo where it was written');
    page.run("view.tab = 'activity'");
    await page.click({ board: core.repo, go: 'item:1' });
    assert.equal(page.run('view.root'), core.repo, 'the Core API link opens its own repo');
    assert.equal(page.run('view.item'), 1, 'the Core API link opens its #1');
    assert.equal(page.run('view.tab'), 'items', 'the Core API link opens its item detail');
    await page.click({ root: 'group:Atlas' });
    page.run("view.tab = 'activity'");
    await page.click({ board: web.repo, go: 'item:1' });
    assert.equal(page.run('view.root'), web.repo, 'the Web UI link opens its own repo');
    assert.equal(page.run('view.item'), 1, 'the Web UI link opens its #1');
    assert.equal(page.run('view.tab'), 'items', 'the Web UI link opens its item detail');
    await page.click({ root: 'group:Atlas' });

    await page.click({ root: core.repo });
    assert.equal(page.element('group-view').hidden, true);
    assert.equal(page.element('tabs').hidden, false);
    assert.match(page.show('chain'), /Core target/);
    assert.doesNotMatch(page.show('chain'), /Header/);
    assert.ok(side.includes(`data-root="${standalone.repo}"`), 'the repo without a project stands alone');
  } finally {
    await view.stop();
  }
});
