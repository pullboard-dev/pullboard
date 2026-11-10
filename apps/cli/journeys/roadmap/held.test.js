// pullboard: browser
/** @pullboard-test-gui */
/** A held item reads held, with its reason, in the Roadmap and Items lists, matching the header's count [N26]. */
import assert from 'node:assert/strict';
import {
  mkdtempSync,
  rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import {
  SPEC,
  machine,
  project,
  startView,
  chromeExecutable,
  openSnapshotChrome,
  closeSnapshotChrome,
  press,
} from '../../tests/fixtures/cockpit/harness.js';

test('a held item shows held with its reason in the roadmap list, matching the header count [N26]', { timeout: 90_000 }, async () => {
  const executable = chromeExecutable();
  assert.ok(executable, 'Chrome is required for the held roadmap rows.');
  const box = machine();
  // Two lanes, so one item can be held on its own and another through its lane.
  const alpha = project(box, 'held-rows', SPEC, { lanes: { web: { owns: ['web/'], specs: ['G'] }, docs: { owns: ['docs/'], specs: ['G'] } } });
  box.run(alpha.repo, 'add', 'web', 'Held on its own', '--specs', 'G1', '--criterion', 'renders');
  box.run(alpha.repo, 'add', 'web', 'Free to take', '--specs', 'G1', '--criterion', 'renders');
  box.run(alpha.repo, 'add', 'docs', 'Held with its lane', '--specs', 'G1', '--criterion', 'renders');
  box.run(alpha.repo, 'hold', '1', 'waits on the vendor reply');
  box.run(alpha.repo, 'hold', 'docs', '--reason', 'docs frozen for the release');
  box.run(alpha.repo, 'milestone', 'add', 'Next', '--reason', 'Arrange fixture release', '--items', '1,2,3');
  // The board orders the release by its placement rule, so the held rows follow the real roadmap API's order.
  const heldOrder = JSON.parse(box.run(alpha.repo, 'roadmap', '--json')).milestones.find((m) => m.name === 'Next').items
    .map((item) => `#${item.id}`).filter((id) => ['#1', '#3'].includes(id));
  const view = await startView(box);
  const profile = mkdtempSync(join(tmpdir(), 'pullboard-held-rows-chrome-'));
  let chrome;
  /** What a person sees of each Roadmap row and the header's held count. */
  const read = async () => JSON.parse(await chrome.stable(`JSON.stringify((() => {
    const next = document.querySelector('#roadmap-list > [data-key="m:Next"]');
    const rows = [...next.querySelectorAll(':scope > .milestone-body > ul > li')].filter((li) => !li.hidden).map((li) => {
      const stage = li.querySelector('.roadmap-status .item-stage');
      const mark = stage.querySelector('.stage-mark');
      return { id: li.querySelector('.id').textContent, chip: stage.querySelector('.stage-word').textContent.trim(), tone: stage.dataset.stage,
        why: mark?.getAttribute('title') || '' };
    });
    const count = next.querySelector('[data-summary-state=held]');
    return { rows, held: Number(count.querySelector('b').textContent), link: Boolean(count.closest('button, a')) };
  })())`));
  try {
    chrome = await openSnapshotChrome(executable, view.link.href, profile);
    await chrome.waitFor('data?.project?.milestones?.length === 1');
    await press(chrome, "document.querySelector('[data-tab=roadmap]')");
    await chrome.waitFor("!document.querySelector('[data-pane=roadmap]').hidden && document.querySelector('#roadmap-list > [data-key=\"m:Next\"] .milestone-item')");
    for (const width of [375, 1280]) {
      await chrome.send('Emulation.setDeviceMetricsOverride', { width, height: 900, deviceScaleFactor: 1, mobile: false });
      await chrome.waitFor(`innerWidth === ${width}`);
      const seen = await read();
      const byId = Object.fromEntries(seen.rows.map((row) => [row.id, row]));
      assert.deepEqual([byId['#1'].chip, byId['#1'].tone], ['Gated', 'gated'], `${width}: an item held on its own keeps its lifecycle stage`);
      assert.match(byId['#1'].why, /Held: waits on the vendor reply/u, `${width}: the hold mark names the item's reason on hover`);
      assert.deepEqual([byId['#3'].chip, byId['#3'].tone], ['Gated', 'gated'], `${width}: an item in a held lane keeps its lifecycle stage`);
      assert.match(byId['#3'].why, /Lane held: docs frozen for the release/u, `${width}: the lane mark names its reason on hover`);
      assert.deepEqual([byId['#2'].chip, byId['#2'].tone], ['Ready', 'ready'], `${width}: an item nobody held stays unclaimed`);
      assert.equal(seen.rows.filter((row) => row.why.startsWith('Held:') || row.why.startsWith('Lane held:')).length, seen.held, `${width}: the list's held rows match the header's held count`);
      assert.equal(seen.held, 2, `${width}: the header counts both holds`);
      assert.ok(seen.link, `${width}: the header's held count is a link`);
      // The count opens the held items alone, and shows them all again on a second press.
      await press(chrome, "document.querySelector('#roadmap-list > [data-key=\"m:Next\"] [data-summary-state=held]').closest('button, a')");
      await chrome.waitFor("[...document.querySelectorAll('#roadmap-list > [data-key=\"m:Next\"] > .milestone-body > ul > li')].filter((li) => !li.hidden).length === 2");
      assert.equal(heldOrder.length, 2, 'the real roadmap API lists both held items');
      assert.deepEqual((await read()).rows.map((row) => row.id), heldOrder, `${width}: the held count lists exactly the held items`);
      await press(chrome, "document.querySelector('#roadmap-list > [data-key=\"m:Next\"] [data-summary-state=held]').closest('button, a')");
      await chrome.waitFor("[...document.querySelectorAll('#roadmap-list > [data-key=\"m:Next\"] > .milestone-body > ul > li')].filter((li) => !li.hidden).length === 3");
      // A tap opens the row in place, and its detail says why it is held.
      const row = "document.querySelector('#roadmap-list [data-roadmap-key=\"i:#1\"]')";
      await press(chrome, row);
      await chrome.waitFor(row + ".getAttribute('aria-expanded') === 'true'");
      assert.match(await chrome.stable(row + ".parentElement.querySelector('.milestone-why').textContent"), /held[^]*waits on the vendor reply/u, `${width}: tapping the row shows the hold reason`);
      await press(chrome, row);
      await chrome.waitFor(row + ".getAttribute('aria-expanded') === 'false'");
    }
    // The Items list says the same of the same item.
    await press(chrome, "document.querySelector('[data-tab=items]')");
    await chrome.waitFor("document.querySelector('#chain [data-item=\"1\"]')");
    const items = JSON.parse(await chrome.stable(`JSON.stringify([1, 2].map((id) => {
      const stage = document.querySelector('#chain [data-item="' + id + '"] .item-stage');
      const mark = stage.querySelector('.stage-mark');
      return { chip: stage.querySelector('.stage-word').textContent.trim(), why: mark?.getAttribute('title') || '' };
    }))`));
    assert.equal(items[0].chip, 'Gated', 'the Items row preserves the held item lifecycle stage');
    assert.match(items[0].why, /Held: waits on the vendor reply/u, 'the Items row names the hold reason on hover');
    assert.equal(items[1].chip, 'Ready', 'the Items row of a free item stays unclaimed');
    assert.deepEqual(chrome.exceptions, [], 'the held rows raise no uncaught page exception');
  } finally {
    if (chrome) await closeSnapshotChrome(chrome);
    rmSync(profile, { recursive: true, force: true });
    await view.stop();
  }
});
