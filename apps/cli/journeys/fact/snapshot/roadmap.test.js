// pullboard: browser
/** @pullboard-test-gui */
/** Cockpit snapshot roadmap address under a folder, using the shared real-board fixtures [N26]. */
import assert from 'node:assert/strict';
import {
  mkdtempSync,
  rmSync,
} from 'node:fs';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import {
  machine,
  project,
  build,
  accept,
  chromeExecutable,
  openSnapshotChrome,
  closeSnapshotChrome,
  press,
  travel,
  settled,
  roadmapRow,
  showing,
  readRoadmap,
  openRoadmapParts,
  serveFolder,
  proofShot,
} from '../../../tests/fixtures/cockpit/harness.js';

test('an exported roadmap has its own address under a folder, and Back and Forward return to it [N38,A10]', { timeout: 120_000 }, async (t) => {
  const executable = chromeExecutable();
  if (!executable) return t.skip('Install Chrome or set PULLBOARD_CHROME for exported roadmap checks.');
  const box = machine();
  const alpha = project(box, 'roadmap-snapshot');
  const beacon = project(box, 'beacon');
  await box.inProcess(alpha.repo, 'add', 'web', 'Verified page', '--specs', 'G1', '--criterion', 'renders');
  await box.inProcess(alpha.repo, 'add', 'web', 'Open page', '--specs', 'G1', '--criterion', 'renders');
  build(box, alpha, 1, 'one.txt');
  accept(box, alpha, 1);
  await box.inProcess(beacon.repo, 'add', 'web', 'Billing webhook retries', '--specs', 'G1', '--criterion', 'retries');
  await box.inProcess(alpha.repo, 'milestone', 'add', 'Launch', '--note', 'Ships with the snapshot.', '--items', '1,2,beacon#1', '--reason', 'the fixture places its own items');
  await box.inProcess(alpha.repo, 'milestone', 'add', 'Later');
  const folder = join(box.dir, 'roadmap-export');
  await box.inProcess(alpha.repo, 'view', '--export', folder);
  const host = await serveFolder(folder, '/demo/');
  const profile = mkdtempSync(join(tmpdir(), 'pullboard-roadmap-export-chrome-'));
  const ready = "document.body.classList.contains('snapshot') && !!data?.project && snapshotReplay.index === snapshotReplay.events.length";
  let chrome;
  try {
    chrome = await openSnapshotChrome(executable, `${host.base}/demo/`, profile);
    await settled(chrome, ready);
    assert.equal(await chrome.stable("[...document.querySelectorAll('[data-pane]')].filter((each) => !each.hidden).map((each) => each.dataset.pane).join()"), 'dashboard', 'a fresh snapshot opens on Dashboard');
    assert.equal(await chrome.stable('location.pathname + location.hash'), '/demo/', 'Dashboard keeps the snapshot folder address');
    await press(chrome, `document.querySelector('[data-tab="roadmap"]')`);
    await chrome.waitFor(showing('roadmap', '/demo/#roadmap'));
    await openRoadmapParts(chrome);
    const seen = await readRoadmap(chrome);
    assert.deepEqual(seen.cards[0].rows.map(({ id, label, tone, button }) => ({ id, label, tone, button })), [
      { id: '#1', label: 'Verified', tone: 'verified', button: true },
      { id: '#2', label: 'Ready', tone: 'ready', button: true },
      { id: 'beacon#1', label: 'Ready', tone: 'ready', button: true },
    ], "the snapshot's rows expand in place, by stage first: verified, then ready in queue order (#6841); another repo's unavailable item has no Items link");
    assert.equal(seen.cards[0].rows.find((row) => row.id === 'beacon#1').tip, 'Billing webhook retries (not in this snapshot)', 'and says why');
    assert.deepEqual([seen.cards[1].name, seen.cards[1].empty], ['Later', 'No items yet.']);

    // Opening each release puts the last one opened in the address (#7303), so the tab's address from here carries it.
    const opened = '/demo/#roadmap?release=Later';
    await press(chrome, roadmapRow('beacon#1'));
    await chrome.waitFor(roadmapRow('beacon#1') + ".getAttribute('aria-expanded') === 'true'");
    assert.equal(await chrome.stable('location.pathname + location.hash'), opened);
    assert.match(await chrome.stable(roadmapRow('beacon#1') + ".parentElement.querySelector('.milestone-why').textContent"), /not in this snapshot/u);
    assert.equal(await chrome.stable(roadmapRow('beacon#1') + ".parentElement.querySelectorAll('.milestone-why a[data-go]').length"), 0, 'unavailable items expand to why, without a false navigation target');
    await press(chrome, roadmapRow('beacon#1'));

    // The address survives a reload on a static host, and Back and Forward show the tab it names,
    // whether the browser keeps the page for an entry or loads it again.
    await chrome.send('Page.reload');
    await settled(chrome, `${ready} && ${showing('roadmap', opened)} && !!${roadmapRow('#1')}`);
    await travel(chrome, -1);
    await settled(chrome, `${ready} && ${showing('dashboard', '/demo/')}`);
    await travel(chrome, 1);
    await settled(chrome, `${ready} && ${showing('roadmap', opened)} && !!${roadmapRow('#2')}`);
    await press(chrome, roadmapRow('#2'));
    await chrome.waitFor(roadmapRow('#2') + ".getAttribute('aria-expanded') === 'true'");
    assert.equal(await chrome.stable('location.pathname + location.hash'), opened, 'a snapshot row click stays on Roadmap');
    await press(chrome, roadmapRow('#2') + ".parentElement.querySelector('.milestone-why a[data-go]')");
    await chrome.waitFor(`${showing('items', '/demo/#items/2')} && document.querySelector('#detail h2')?.innerText.includes('Open page')`);
    await travel(chrome, -1);
    await settled(chrome, `${ready} && ${showing('roadmap', opened)}`);
    assert.equal(await chrome.stable("localStorage.getItem('snapshot.pb.tab')"), 'items', 'the earlier Items navigation remains the saved tab for this Chrome profile');

    // A fresh navigation in this profile restores Items, while an explicit #roadmap address still selects Roadmap.
    for (const [address, pane] of [['/demo/', 'items'], ['/demo/#roadmap', 'roadmap']]) {
      await chrome.send('Page.navigate', { url: 'about:blank' });
      await settled(chrome, "location.href === 'about:blank'");
      await chrome.send('Page.navigate', { url: `${host.base}${address}` });
      const navigationReady = `${ready} && ${showing(pane, address)}`;
      try {
        await settled(chrome, navigationReady);
      } catch (error) {
        const actual = await chrome.stable(`JSON.stringify({
          snapshotClass: document.body?.classList.contains('snapshot') ?? false,
          projectPresent: typeof data !== 'undefined' && !!data?.project,
          replay: typeof snapshotReplay === 'object' && snapshotReplay ? {
            index: snapshotReplay.index,
            eventsLength: Array.isArray(snapshotReplay.events) ? snapshotReplay.events.length : null,
            atEnd: Array.isArray(snapshotReplay.events) && snapshotReplay.index === snapshotReplay.events.length,
          } : null,
          visiblePanes: [...document.querySelectorAll('[data-pane]')].filter((each) => !each.hidden).map((each) => each.dataset.pane),
          paneMatches: [...document.querySelectorAll('[data-pane]')].filter((each) => !each.hidden).map((each) => each.dataset.pane).join() === ${JSON.stringify(pane)},
          pathname: location.pathname,
          hash: location.hash,
          address: location.pathname + location.hash,
          expectedPane: ${JSON.stringify(pane)},
          expectedAddress: ${JSON.stringify(address)},
          addressMatches: location.pathname + location.hash === ${JSON.stringify(address)},
        })`).catch((captureError) => `capture unavailable: ${captureError.message}`);
        throw new Error(`${error.message}; fresh-navigation state ${actual}`, { cause: error });
      }
    }
    for (const width of [375, 1280]) {
      await chrome.send('Emulation.setDeviceMetricsOverride', { width, height: 900, deviceScaleFactor: 1, mobile: false });
      await chrome.waitFor(`innerWidth === ${width}`);
      await openRoadmapParts(chrome);
      const layout = await readRoadmap(chrome);
      assert.ok(layout.document <= layout.client && layout.body <= layout.client, `${width}: no sideways scroll in the snapshot: ${JSON.stringify(layout)}`);
      await proofShot(chrome, 'snapshot-roadmap', width);
    }
    assert.deepEqual(host.requests.filter((request) => !request.path.startsWith('/demo/') || request.status !== 200), [], 'every request stays in the folder and finds its file');
    assert.deepEqual(chrome.exceptions, [], 'Chrome reports no uncaught page exceptions');
  } finally {
    if (chrome) await closeSnapshotChrome(chrome);
    await host.close();
    rmSync(profile, { recursive: true, force: true });
  }
});
