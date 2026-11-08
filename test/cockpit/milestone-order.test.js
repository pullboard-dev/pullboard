// pullboard: browser
/** @pullboard-test-gui */
/** Real native milestone ordering across lifecycle groups, queue ties and coordinator pins [N26]. */
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import {
  SPEC,
  machine,
  project,
  build,
  sendBack,
  accept,
  startView,
  chromeExecutable,
  openSnapshotChrome,
  closeSnapshotChrome,
  press,
  settled,
  roadmapRow,
  proofShot,
} from './fixture.js';

/** Record a real Git merge and its ordinary native landing receipt, rather than inventing a rendered status. */
function landItem(box, project, id) {
  box.git(project.repo, 'merge', '--no-ff', '--no-edit', project.itemBranches.get(`${project.baseBranch}:${id}`));
  box.run(project.repo, 'merged', String(id), box.git(project.repo, 'rev-parse', 'HEAD'));
}

/** Read actual rendered rows, including their original native key and layout visibility. */
async function readRows(chrome) {
  return JSON.parse(await chrome.stable(`JSON.stringify((() => {
    const milestone = document.querySelector('#roadmap-list > [data-key="m:State order"]');
    return [...milestone.querySelectorAll(':scope > .milestone-body > ul .milestone-item')].map(row => {
      const rect = row.getBoundingClientRect();
      return { id: row.querySelector('.id')?.textContent, key: row.dataset.roadmapKey,
        text: row.textContent, visible: !row.closest('[hidden]') && getComputedStyle(row).visibility !== 'hidden'
          && rect.width > 0 && rect.height > 0 };
    });
  })())`));
}

/** Read the genuine native milestone without deriving expected order from the renderer under test. */
function nativeMilestone(box, project) {
  return JSON.parse(box.run(project.repo, 'roadmap', '--json')).milestones.find(row => row.name === 'State order');
}

test('Roadmap lifecycle groups outrank shuffled and pinned queue order while preserving ties [N26]', {
  timeout: 180_000, // budget: hang ceiling for eight real lifecycle fixtures and Chrome at two viewport widths.
}, async () => {
  const executable = chromeExecutable();
  assert.ok(executable, 'Chrome is required for native milestone ordering checks.');
  const box = machine();
  const demo = project(box, 'milestone-order', SPEC, {
    lanes: { web: { owns: ['web/'], specs: ['G'] }, ops: { owns: ['ops/'], specs: ['G'] } },
  });
  const titles = ['Landed item', 'Accepted item', 'Sent back item', 'Review item',
    'Building item', 'Unclaimed second', 'Held item', 'Pinned unclaimed first'];
  for (const [index, title] of titles.entries()) {
    box.run(demo.repo, 'add', index === 6 ? 'ops' : 'web', title, '--specs', 'G1', '--criterion', 'The page renders.');
  }
  build(box, demo, 1, 'landed.txt');
  accept(box, demo, 1);
  landItem(box, demo, 1);
  build(box, demo, 2, 'accepted.txt');
  accept(box, demo, 2);
  build(box, demo, 3, 'sent-back.txt');
  sendBack(box, demo, 3, 'The page does not render the required greeting.');
  build(box, demo, 4, 'review.txt');
  box.run(demo.web, 'claim', '5');
  box.run(demo.repo, 'hold', 'ops', '--reason', 'Waiting for the person to approve the operational change.');
  // IDs and creation order intentionally disagree with the milestone queue's same-state tie.
  box.run(demo.repo, 'milestone', 'add', 'State order', '--reason', 'Arrange fixture release', '--items', '7,8,1,3,5,6,4,2');
  box.run(demo.repo, 'milestone', 'pin', 'State order', '8', '--reason', 'Prioritize this unclaimed item within its group.');
  const before = nativeMilestone(box, demo);
  const queue = JSON.parse(box.run(demo.repo, 'queue', '--json'));
  const queueIds = queue.releases.find(row => row.name === 'State order').items.map(row => row.id);
  assert.equal(queueIds[0], 8, 'the real coordinator pin puts an unclaimed item first in the native work queue');
  const head = box.git(demo.repo, 'rev-parse', 'HEAD');
  const worktree = box.git(demo.repo, 'status', '--porcelain');
  const expected = queueIds.map(id => '#' + id).concat(['#2', '#1']);
  assert.deepEqual([...expected].sort(), ['#1', '#2', '#3', '#4', '#5', '#6', '#7', '#8'], 'queue ordering retains every original milestone member');
  const view = await startView(box);
  const profile = mkdtempSync(join(tmpdir(), 'pullboard-milestone-order-chrome-'));
  let chrome;
  try {
    chrome = await openSnapshotChrome(executable, view.link.href, profile);
    await chrome.waitFor('data?.project?.milestones?.some(row => row.name === "State order")');
    await press(chrome, "document.querySelector('[data-tab=roadmap]')");
    await settled(chrome, "!document.querySelector('[data-pane=roadmap]').hidden && !!document.querySelector('#roadmap-list > [data-key=\"m:State order\"]')");
    const heading = "document.querySelector('#roadmap-list > [data-key=\"m:State order\"] .milestone-head')";
    if (await chrome.stable(`${heading}.getAttribute('aria-expanded')`) !== 'true') await press(chrome, heading);
    for (const width of [375, 1280]) {
      await chrome.send('Emulation.setDeviceMetricsOverride', { width, height: 900, deviceScaleFactor: 1, mobile: false });
      await chrome.waitFor(`innerWidth === ${width}`);
      const rows = await readRows(chrome);
      assert.deepEqual(rows.map(row => row.id), expected, `${width}: backend queue positions, then unpositioned accepted and landed items`);
      assert.equal(new Set(rows.map(row => row.id)).size, 8, `${width}: no duplicate or missing native items`);
      assert.ok(rows.every(row => row.visible), `${width}: every milestone row is visibly rendered`);
      assert.deepEqual(rows.map(row => row.key), expected.map(id => `i:${id}`), `${width}: native row tokens remain unchanged`);
      for (const [index, id] of expected.entries()) {
        assert.ok(rows[index].text.includes(titles[Number(id.slice(1)) - 1]), `${width}: ${id} retains its own exact title`);
        const row = roadmapRow(id);
        if (await chrome.stable(`${row}.getAttribute('aria-expanded')`) !== 'true') await press(chrome, row);
        await chrome.waitFor(`${row}.nextElementSibling.querySelector('a[data-go="item:${id.slice(1)}"]') !== null`);
        assert.equal(await chrome.stable(`${row}.nextElementSibling.querySelector('a[data-go]').getAttribute('data-go')`),
          `item:${id.slice(1)}`, `${width}: ${id} still targets its original native item`);
      }
      await proofShot(chrome, 'milestone-state-order', width);
    }
    assert.deepEqual(chrome.exceptions, [], 'Chrome reports no uncaught page exceptions');
    assert.deepEqual(nativeMilestone(box, demo), before, 'rendering and expanding rows do not mutate native milestone membership');
    const afterQueue = JSON.parse(box.run(demo.repo, 'queue', '--json'));
    assert.deepEqual(afterQueue.releases.find(row => row.name === 'State order').items.map(row => row.id), queueIds,
      'rendering and expanding rows do not change the native work queue or pin priority');
    assert.equal(box.git(demo.repo, 'rev-parse', 'HEAD'), head, 'Roadmap navigation does not change the source head');
    assert.equal(box.git(demo.repo, 'status', '--porcelain'), worktree, 'Roadmap navigation does not edit the source checkout');
  } finally {
    if (chrome) await closeSnapshotChrome(chrome);
    await view.stop();
    rmSync(profile, { recursive: true, force: true });
  }
});
