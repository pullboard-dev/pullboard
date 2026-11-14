// pullboard: browser
/** @pullboard-test-gui */
/** Cockpit items checks (detail), using the shared real-board fixtures [N26]. */
import assert from 'node:assert/strict';
import {
  mkdtempSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import {
  tmpdir,
} from 'node:os';
import {
  join,
} from 'node:path';
import {
  test,
} from 'node:test';
import {
  tapTarget,
  SPEC,
  machine,
  project,
  startView,
  element,
  target,
  chromeExecutable,
  openSnapshotChrome,
  closeSnapshotChrome,
  earlier,
  chooseFilter,
  openItemsNeeds,
} from '../../../tests/fixtures/cockpit/harness.js';
test('in-text item references stay inline and open their target at phone and desktop widths [N26]', { timeout: 90_000 }, async (t) => {
  const executable = chromeExecutable();
  if (!executable) return t.skip('Install Chrome or set PULLBOARD_CHROME for item-reference layout checks.');

  const box = machine();
  const demo = project(box, 'inline-references', SPEC, { practice: 'ways.md' });
  writeFileSync(join(demo.repo, 'ways.md'), '# Local rules\n\n## Team\n- G1 [approved, must] Items carry the page behavior. | gate: review\n');
  await box.inProcess(demo.repo, 'add', 'web', 'Target item', '--specs', 'G1', '--criterion', 'the linked target');
  await box.inProcess(demo.repo, 'add', 'web', 'Title links to #1', '--specs', 'G1', '--criterion', 'Criterion links to #1', '--brief', 'Brief links to #1');
  await box.inProcess(demo.web, 'claim', '2');
  await box.inProcess(demo.repo, 'shout', 'person', 'Please choose #1 next', '--decision');
  const view = await startView(box);
  const profile = mkdtempSync(join(tmpdir(), 'pullboard-inline-references-chrome-'));
  let chrome;
  try {
    chrome = await openSnapshotChrome(executable, view.link.href, profile);
    await chrome.click("document.querySelector('[data-tab=items]')");
    await chrome.send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });
    await chrome.waitFor('document.querySelectorAll("#chain .row").length >= 2 && document.querySelector("#needs .needs-call")');

    for (const width of [375, 1280]) {
      await chrome.send('Emulation.setDeviceMetricsOverride', { width, height: 900, deviceScaleFactor: 1, mobile: false });
      // Needs you heads the Items list under Active; the steps below leave other tabs and filters open.
      await chrome.click("document.querySelector('[data-tab=items]')"); await chooseFilter(chrome, 'state:active');
      await openItemsNeeds(chrome);
      const decision = "document.querySelector('#needs details[data-needs-key^=\"decision:\"]')";
      if (await chrome.stable(`${decision}.open`) !== true) await chrome.click(`${decision}.querySelector('summary')`);
      // The inline reference stays on its actual question line in the approved Needs disclosure.
      const rendered = JSON.parse(await chrome.stable(`JSON.stringify((() => {
        const row = document.querySelector('#chain .row[data-item="2"]');
        const plain = document.querySelector('#chain .row[data-item="1"]');
        const titleRef = row?.querySelector('.t a.ref[data-go]');
        const need = [...document.querySelectorAll('#needs .needs-call')].find((entry) => entry.textContent.includes('Please choose'));
        const needRef = need?.querySelector('.needs-detail p a.ref[data-go]');
        const needAction = need?.querySelector('.needs-detail button[data-go]');
        const realButton = document.querySelector('button[data-page-ctl="new"]');
        /** Measure the element box independently of the inline-link assertion. */
        const rect = node => { const r=node.getBoundingClientRect(); return {height:r.height,width:r.width}; };
        return {
          titleRef: titleRef && { ...rect(titleRef), border:getComputedStyle(titleRef).borderWidth, lineHeight:getComputedStyle(titleRef).lineHeight },
          linkedTitle: row && rect(row.querySelector('.t')),
          plainTitle: plain && rect(plain.querySelector('.t')),
          needRef: needRef && { ...rect(needRef), border:getComputedStyle(needRef).borderWidth, lineHeight:getComputedStyle(needRef).lineHeight },
          needText: need?.querySelector('.needs-detail p') && rect(need.querySelector('.needs-detail p')),
          needAction: needAction && rect(needAction), realButton: realButton && rect(realButton),
        };
      })())`));
      assert.ok(rendered.titleRef && rendered.needRef, `${width}: list and Needs-you references are links: ${JSON.stringify(rendered)}`);
      assert.equal(rendered.titleRef.border, '0px', `${width}: the title reference has no button border`);
      assert.equal(rendered.needRef.border, '0px', `${width}: the Needs-you reference has no button border`);
      assert.ok(Math.abs(rendered.linkedTitle.height - rendered.plainTitle.height) < 1,
        `${width}: the title line matches a plain title: ${JSON.stringify(rendered)}`);
      assert.ok(Math.abs(rendered.titleRef.height - rendered.linkedTitle.height) < 1,
        `${width}: the title link has the surrounding line height: ${JSON.stringify(rendered)}`);
      assert.ok(Math.abs(rendered.needRef.height - rendered.needText.height) < 1,
        `${width}: the Needs-you link has the surrounding line height: ${JSON.stringify(rendered)}`);
      assert.ok(rendered.needAction.height >= tapTarget(width) && (width >= 900 || rendered.realButton.height >= tapTarget(width)), // the desktop strip keeps compact text controls (nav.css .pagectl)
        `${width}: real controls keep their targets: ${JSON.stringify(rendered)}`);

      // The agents rail is one line per agent and no longer lists an agent's items, so only Spec and Doctrine carry item references.
      for (const section of ['spec', 'doctrine']) {
        if (section === 'agents') {
          await chrome.click(`document.querySelector('[data-tab="shouts"]')`);
          const agent = await chrome.stable("(() => { const item=data.project.items.find(i => i.id===2); return item.claim?.by || item.builtBy; })()");
          if (!await chrome.stable(`!!document.querySelector('#agents .agent-card.on [data-agent="${agent}"]')`)) await chrome.click(`document.querySelector('#agents [data-agent="${agent}"]')`);
          await chrome.waitFor('document.querySelector("#agents [data-item=\\"2\\"]")');
        } else {
          await chrome.click(`document.querySelector('[data-tab="${section}"]')`);
          await chrome.click(`document.querySelector('[data-rows="${section}:all"]')`);
          const citedRow = 'G1';
          if (section === 'doctrine') {
            await chrome.waitFor('data?.project?.practice?.some(row => row.id === "G1") && data?.project?.items?.some(item => item.id === 2 && item.specs.includes("G1"))');
          }
          await chrome.waitFor(`document.querySelector('#${section}-list [data-row="${section}:${citedRow}"]')`);
          await chrome.click(`document.querySelector('#${section}-list [data-row="${section}:${citedRow}"]')`);
          await chrome.waitFor(`document.querySelector('#${section}-detail [data-item="2"]')`);
        }
        const selector = section === 'agents' ? '#agents [data-item="2"] .ref' : `#${section}-detail .links [data-item="2"] .ref`;
        const metrics = JSON.parse(await chrome.stable(`JSON.stringify((() => {
          const ref = document.querySelector(${JSON.stringify(selector)});
          const container = ref?.closest('[data-item="2"]');
          const r = ref?.getBoundingClientRect();
          const c = container?.getBoundingClientRect();
          return { present:!!ref, border:ref && getComputedStyle(ref).borderWidth,
            refHeight:r?.height, lineHeight:ref && parseFloat(getComputedStyle(ref).lineHeight),
            containerHeight:c?.height, nestedButtons:container ? [...container.querySelectorAll('.ref')].filter(link => link.parentElement.closest('button')).length : 0 };
        })())`));
        assert.ok(metrics.present, `${width}: ${section} citing title renders a compact item reference: ${JSON.stringify(metrics)}`);
        assert.equal(metrics.border, '0px', `${width}: ${section} reference has no button border`);
        assert.ok(Math.abs(metrics.refHeight - metrics.lineHeight) < 1, `${width}: ${section} reference keeps the text line height: ${JSON.stringify(metrics)}`);
        assert.ok(metrics.containerHeight >= tapTarget(width), `${width}: ${section} containing item keeps a target`);
        assert.equal(metrics.nestedButtons, 0, `${width}: ${section} title has no nested controls`);
        await chrome.click(`document.querySelector(${JSON.stringify(selector)})`);
        await chrome.waitFor("document.querySelector('[data-tab=items].on') && document.querySelector('#detail h2')?.textContent.includes('Target item')");
        await chrome.click(`document.querySelector('[data-tab="${section === 'agents' ? 'shouts' : section}"]')`);
        await chrome.click(`document.querySelector(${JSON.stringify(selector)}).closest('[data-item="2"]')`);
        await chrome.waitFor("document.querySelector('#detail h2')?.textContent.includes('Title links to #1')");
      }

      await chrome.click(`document.querySelector('[data-tab="items"]')`);
      await chrome.click(`document.querySelector('#chain .row[data-item="2"] .t a.ref[data-go]')`);
      await chrome.waitFor("document.querySelector('#detail h2')?.textContent.includes('Target item')");
      await chooseFilter(chrome, 'state:active');
      if (await chrome.stable(`${decision}.open`) !== true) await chrome.click(`${decision}.querySelector('summary')`);
      await chrome.click(`${decision}.querySelector('.needs-detail p a.ref[data-go]')`);
      await chrome.waitFor("document.querySelector('[data-tab=items].on') && document.querySelector('#detail h2')?.textContent.includes('Target item')");

      // The redesigned Activity page (#7507) has no inline item link in a shout's words: a row about #1 opens #1's journey, as the Activity journeys assert.
      await chrome.click(`document.querySelector('[data-tab="activity"]')`);
      await chrome.waitFor(`document.querySelector('#activity .act-row[data-row="1"]')`);
      await chrome.click(`document.querySelector('#activity .act-row[data-row="1"]')`);
      await chrome.waitFor(`!!document.querySelector('#activity svg[aria-label="Journey of #1"]')`);
      await chrome.click(`document.querySelector('[data-tab="items"]')`);
      await chrome.click(`document.querySelector('#chain .row[data-item="1"]')`);
      await chrome.waitFor("document.querySelector('[data-tab=items].on') && document.querySelector('#detail h2')?.textContent.includes('Target item')");

      await chrome.click(`document.querySelector('#chain .row[data-item="2"]')`);
      await chrome.waitFor("document.querySelector('#detail h2')?.textContent.includes('Title links to #1') && document.querySelector('#detail .item-panel-expand-text a.ref[data-go]') && document.querySelector('#detail .item-panel-brief a.ref[data-go]')");
      await chrome.click(`document.querySelector('#detail .item-panel-expand-text a.ref[data-go]')`);
      await chrome.waitFor("document.querySelector('#detail h2')?.textContent.includes('Target item')");
      await chrome.click(`document.querySelector('#chain .row[data-item="2"]')`);
      await chrome.waitFor("document.querySelector('#detail .item-panel-brief a.ref[data-go]')");
      await chrome.click(`document.querySelector('#detail .item-panel-brief a.ref[data-go]')`);
      await chrome.waitFor("document.querySelector('#detail h2')?.textContent.includes('Target item')");
    }
  } finally {
    if (chrome) await closeSnapshotChrome(chrome);
    rmSync(profile, { recursive: true, force: true });
    await view.stop();
  }
});
