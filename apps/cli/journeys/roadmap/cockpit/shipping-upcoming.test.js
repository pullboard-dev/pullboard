// pullboard: browser
/** @pullboard-test-gui */
/** Cockpit roadmap checks: every upcoming release open [N26]. */
import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import {
  machine,
  project,
  buildLocal,
  startView,
  chromeExecutable,
  closeSnapshotChrome,
  press,
  acceptLocal,
  settled,
  proofShot,
} from '../../../tests/fixtures/cockpit/harness.js';
import { openRoadmapChrome } from '../../../tests/fixtures/cockpit/roadmap.js';

/**
 * Build, accept and land one item, awaiting each board command in this process rather than launching a Node per call.
 * Why: under pull dispatch every submit and verify waits on the local runner, and a launch per command put this file past its budget [C7].
 */
async function landLocal(box, p, id) {
  await buildLocal(box, p, id, `page-${id}.html`);
  await acceptLocal(box, p, id);
  box.git(p.repo, 'merge', '--no-ff', '--no-edit', p.itemBranches.get(`${p.baseBranch}:${id}`));
  await box.inProcess(p.repo, 'merged', String(id), box.git(p.repo, 'rev-parse', 'HEAD'));
}

test('the roadmap keeps every upcoming release open [N26]', {
  timeout: 90_000, //budget: real Chrome startup, two viewport layouts, and reload; test assertions bound each state.
}, async (t) => {
  const executable = chromeExecutable();
  assert.ok(executable, 'Chrome is required for roadmap disclosure checks.');
  const box = machine();
  const alpha = project(box, 'all-upcoming-open');
  for (const title of ['Shipped one', 'Shipped two', 'Next release', 'Later release']) await box.inProcess(alpha.repo, 'add', 'web', title, '--specs', 'G1', '--criterion', 'renders');
  for (const id of [1, 2]) await landLocal(box, alpha, id);
  await box.inProcess(alpha.repo, 'milestone', 'add', '0.1', '--reason', 'Arrange fixture release', '--items', '1');
  await box.inProcess(alpha.repo, 'milestone', 'add', '0.2', '--reason', 'Arrange fixture release', '--items', '2');
  await box.inProcess(alpha.repo, 'milestone', 'add', '0.3', '--note', 'Next out.', '--reason', 'Arrange fixture release', '--items', '3');
  await box.inProcess(alpha.repo, 'milestone', 'add', '0.4', '--note', 'Queued next.', '--reason', 'Arrange fixture release', '--items', '4');
  await box.inProcess(alpha.repo, 'milestone', 'add', 'Later', '--note', 'No work filed yet.');
  await box.inProcess(alpha.repo, 'milestone', 'ship', '0.1', '--next', '0.3');
  await box.inProcess(alpha.repo, 'milestone', 'ship', '0.2', '--next', '0.3', '--as', 'person', '--reason', 'Arrange fixture release'); // a second ship is the person's past the coordinator-actions ratchet
  const view = await startView(box);
  const profile = join(box.dir, 'chrome-profile');
  let chrome;
  /** Read default disclosures, their visible content, status label, and viewport overflow. */
  const read = async () => JSON.parse(await chrome.stable(`JSON.stringify((() => {
    const parts=[...document.querySelectorAll('#roadmap-list > [data-key]')];
    // A release with work left opens from the shared release header (0ab202b994).
    const readPart=part=>{const head=part.querySelector(':scope > .milestone-head, :scope > .release-header > .milestone-head'),body=part.querySelector(':scope > .milestone-body');
      const rows=[...body.querySelectorAll(':scope > ul .milestone-item')];
      return {key:part.dataset.key,open:head.getAttribute('aria-expanded')==='true',rows:rows.map(row=>row.querySelector('.id').textContent),visibleRows:rows.filter(row=>row.getBoundingClientRect().height>0).length,
        empty:body.querySelector('.milestone-empty')?.textContent??null,note:body.querySelector('.milestone-note')?.textContent??null,
        shipped:[...body.querySelectorAll(':scope > .shipped-one')].map(readPart)};};
    return {parts:parts.map(readPart),status:document.querySelector('[data-status=release]')?.textContent.replace(/\\s+/g,' ').trim()??null,
      viewport:document.documentElement.clientWidth,scroll:document.documentElement.scrollWidth,body:document.body.scrollWidth};
  })())`));
  try {
    chrome = await openRoadmapChrome(executable, view.link.href, profile);
    await chrome.waitFor("data?.project?.milestones?.length === 5");
    await press(chrome, "document.querySelector('[data-tab=roadmap]')");
    for (const width of [375, 1280]) {
      await chrome.send('Emulation.setDeviceMetricsOverride', { width, height: width === 375 ? 812 : 800, deviceScaleFactor: 1, mobile: false });
      await chrome.waitFor(`innerWidth === ${width}`);
      const initial = await read();
      assert.deepEqual(initial.parts.map(({ key, open }) => [key, open]), [['m:0.3', true], ['m:0.4', true], ['m:Later', true], ['shipped', false]], `${width}: every upcoming release opens while Shipped stays folded`);
      assert.deepEqual(initial.parts.slice(0, 2).map((part) => [part.rows, part.visibleRows]), [[['#3'], 1], [['#4'], 1]], `${width}: both upcoming item lists are visible`);
      assert.deepEqual([initial.parts[2].empty, initial.parts[2].note], ['No items yet.', 'No work filed yet.'], `${width}: the empty upcoming release shows its note`);
      assert.equal(initial.parts[3].shipped.length, 2, `${width}: both shipped releases are present`);
      assert.equal(initial.parts[3].shipped.every((part) => !part.open && part.visibleRows === 0), true, `${width}: both shipped releases remain folded`);
      assert.equal(initial.status, '0.3 0/1', `${width}: the status bar still names the next release`);
      assert.ok(initial.scroll <= initial.viewport && initial.body <= initial.viewport, `${width}: no sideways scrolling`);
      await proofShot(chrome, 'roadmap-upcoming-open', width);
      if (width === 375) {
        await press(chrome, "document.querySelector('[data-roadmap-key=\"m:0.4\"]')");
        await chrome.waitFor("document.querySelector('[data-roadmap-key=\"m:0.4\"]').getAttribute('aria-expanded') === 'false'");
        assert.equal((await read()).parts[1].open, false, 'the person can fold an upcoming release for this visit');
        await chrome.send('Page.reload');
        await settled(chrome, "data?.project?.milestones?.length === 5 && !document.querySelector('[data-pane=roadmap]').hidden");
        assert.deepEqual((await read()).parts.map(({ key, open }) => [key, open]), [['m:0.3', true], ['m:0.4', true], ['m:Later', true], ['shipped', false]], 'the next visit reopens upcoming releases and folds Shipped');
      }
    }
  } finally {
    if (chrome) await closeSnapshotChrome(chrome);
    rmSync(profile, { recursive: true, force: true });
    await view.stop();
  }
});
