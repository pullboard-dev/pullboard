/** Roadmap cockpit fixture: the inline-reference check both viewport-width journeys run, one width each [N26,N38]. */
import assert from 'node:assert/strict';
import {
  mkdtempSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  tapTarget,
  SPEC,
  machine,
  project,
  build,
  sendBack,
  startView,
  chromeExecutable,
  closeSnapshotChrome,
  press,
  pressTab,
  pickProject,
  chooseFilter,
  openItemsNeeds,
} from './harness.js';
import {
  openRoadmapChrome,
  openRoadmapItem,
} from './roadmap.js';

/**
 * Check the inline Roadmap references at one viewport width.
 * Why one width per journey file: each width takes about 80 s, and two together exceed a file's 180 s budget.
 */
export async function proseReferencesAt(t, width) {
  const executable = chromeExecutable();
  if (!executable) return t.skip('Install Chrome or set PULLBOARD_CHROME for prose-reference checks.');
  const box = machine();
  const demo = project(box, 'a-inline-prose', `${SPEC}- G3 [approved, must] Follow #1 first. | gate: review\n`, { practice: 'ways.md' });
  writeFileSync(join(demo.repo, 'ways.md'), '# Local rules\n\n## Team\n- R1 [approved, must] Review #1 first. | gate: review\n');
  box.run(demo.repo, 'add', 'web', 'Local target', '--specs', 'G1', '--criterion', 'target');
  box.run(demo.repo, 'add', 'web', 'Local title links to #1', '--specs', 'G1', '--criterion', 'title');
  build(box, demo, 2, 'title.txt');
  sendBack(box, demo, 2, 'Review #1 before accepting.');
  const other = project(box, 'beacon-prose');
  box.run(other.repo, 'add', 'web', 'Remote target', '--specs', 'G1', '--criterion', 'target');
  box.run(other.repo, 'add', 'web', 'Remote title links to #1', '--specs', 'G1', '--criterion', 'title');
  box.run(demo.repo, 'milestone', 'add', 'Choose #1', '--note', 'Review #1 next.', '--reason', 'Arrange fixture release', '--items', '2,beacon-prose#2');
  box.run(demo.repo, 'shout', 'person', 'Choose #1 before shipping.', '--decision');
  const view = await startView(box);
  const profile = mkdtempSync(join(tmpdir(), 'pullboard-prose-references-chrome-'));
  let chrome;
  try {
    chrome = await openRoadmapChrome(executable, view.link.href, profile);
    await pressTab(chrome, 'items');
    await chrome.waitFor("document.querySelector('#chain .row[data-item=\"2\"]')");
    {
      await chrome.send('Emulation.setDeviceMetricsOverride', { width, height: 900, deviceScaleFactor: 1, mobile: false });
      const contexts = [
        ['roadmap', '#roadmap .milestone h2 .ref', 'Local target'],
        ['roadmap', '#roadmap .milestone-note .ref', 'Local target'],
        ['roadmap', '#roadmap .milestone-item[data-roadmap-key="i:#2"]:not([data-board]) .t .ref', 'Local target', true],
        ['roadmap', '#roadmap .milestone-item[data-board] .t .ref', 'Remote target', true],
        ['spec', '#spec-list [data-row="spec:G3"] .ref', 'Local target'],
        ['doctrine', '#doctrine-list [data-row="doctrine:R1"] .ref', 'Local target'],
      ];
      for (const [tab, selector, target, expands] of contexts) {
        await pickProject(chrome, `document.querySelector('[data-root=${JSON.stringify(demo.repo)}]')`);
        await chrome.waitFor("data?.project?.root === view.root && !document.body.classList.contains('switching') && document.querySelector('#proj-name').textContent === 'a-inline-prose'");
        await pressTab(chrome, `${tab}`);
        if (tab !== 'roadmap') await chrome.click(`document.querySelector('[data-rows="${tab}:all"]')`);
        const metrics = JSON.parse(await chrome.stable(`JSON.stringify((() => {
          const ref = document.querySelector(${JSON.stringify(selector)});
          const row = ref?.closest('.milestone-item');
          const style = ref && getComputedStyle(ref);
          return { present:!!ref, title:ref?.title, border:style?.borderWidth, display:style?.display, height:ref?.getBoundingClientRect().height,
            line:style && parseFloat(style.lineHeight), nested:!!ref?.parentElement.closest('button'),
            rowHeight:row?.getBoundingClientRect().height };
        })())`));
        assert.ok(metrics.present, `${width}: ${selector} contains its inline reference`);
        assert.equal(metrics.title, target, `${width}: the reference tooltip names the target on its own board`);
        assert.equal(metrics.border, '0px', `${width}: ${selector} has no box`);
        // A block-level reference fills the text line; an inline one (a Spec or Doctrine row's span) is only the glyph box, shorter than a 1.5 leading line, and adds nothing to the line.
        assert.ok(metrics.display === 'inline' ? metrics.height <= metrics.line + 1 : Math.abs(metrics.height - metrics.line) < 1, `${width}: ${selector} keeps the text line height: ${JSON.stringify(metrics)}`);
        assert.equal(metrics.nested, false, `${width}: ${selector} never nests buttons`);
        if (metrics.rowHeight !== undefined) assert.ok(metrics.rowHeight >= tapTarget(width), `${width}: the containing Roadmap control keeps its target`);
        if (expands) {
          const ref = `document.querySelector(${JSON.stringify(selector)})`;
          const row = ref + ".closest('.milestone-item')";
          if (await chrome.stable(row + ".getAttribute('aria-expanded')") === 'true') await chrome.click(ref);
          const address = await chrome.stable('location.href');
          await chrome.click(ref);
          await chrome.waitFor(row + ".getAttribute('aria-expanded') === 'true'");
          assert.equal(await chrome.stable('location.href'), address, 'inline title text expands without leaving Roadmap');
          assert.equal(await chrome.stable('view.tab'), 'roadmap');
          await chrome.click(row + ".parentElement.querySelector('.milestone-why a[data-go]')");
          await chrome.waitFor("document.querySelector('[data-tab=items].on') && document.querySelector('#detail .item-panel-head .id')?.textContent === '#2'");
          assert.equal(await chrome.stable('view.root'), target === 'Remote target' ? other.repo : demo.repo);
          continue;
        }
        await chrome.click(`document.querySelector(${JSON.stringify(selector)})`);
        await chrome.waitFor("!document.body.classList.contains('switching') && document.querySelector('[data-tab=items].on') && document.querySelector('#detail .item-panel-head .id')?.textContent === '#1'");
        assert.ok((await chrome.stable("document.querySelector('#detail h2').textContent")).includes(target), 'the reference opens its target title');
        assert.equal(await chrome.stable('view.root'), target === 'Remote target' ? other.repo : demo.repo, 'duplicate item numbers stay bound to their own board');
      }
      await pressTab(chrome, 'items'); await chrome.click(`document.querySelector('#chain .row[data-item="2"]')`);
      // The latest verdict has its own panel, and the history row keeps its own copy (639c16dbb5); read the panel's.
      await chrome.waitFor("document.querySelector('#detail .item-panel-latest .note')");
      assert.equal(await chrome.stable("document.querySelectorAll('#detail .item-panel-latest .note .ref').length"), 1, 'verdict prose keeps its item reference');
      await chrome.click("document.querySelector('#detail .item-panel-latest .note .ref')");
      await chrome.waitFor("document.querySelector('#detail h2')?.textContent.includes('Local target')");
      await chooseFilter(chrome, 'state:active');
      await openItemsNeeds(chrome);
      const decision = "document.querySelector('#needs details[data-needs-key^=\"decision:\"]')";
      if (await chrome.stable(`${decision}.open`) !== true) await chrome.click(`${decision}.querySelector('summary')`);
      await chrome.click(`${decision}.querySelector('button[data-go^="decide:"]')`);
      // A ruling answers in its opened thread, where the message text carries the reference; the composer's answering line stays hidden (154e174c55).
      const asked = "document.querySelector('#feed [data-thread-panel] .sx-msg .sx-tx .ref')";
      await chrome.waitFor(asked + ' !== null');
      assert.equal(await chrome.stable("document.querySelectorAll('#feed [data-thread-panel] .sx-msg .sx-tx .ref').length"), 1, 'the answered question keeps its inline item reference');
      await chrome.click(asked);
      await chrome.waitFor("document.querySelector('#detail h2')?.textContent.includes('Local target') && document.querySelector('[data-tab=items].on')");
      await pressTab(chrome, 'roadmap');
      const keyboardRow = "document.querySelector('#roadmap .milestone-item[role=button]:not([data-board])')";
      if (await chrome.stable(keyboardRow + ".getAttribute('aria-expanded')") === 'true') await chrome.click(keyboardRow);
      await chrome.stable(keyboardRow + ".dispatchEvent(new KeyboardEvent('keydown', {key:'Enter',bubbles:true}))");
      await chrome.waitFor(keyboardRow + ".getAttribute('aria-expanded') === 'true' && view.tab === 'roadmap'");
      await openRoadmapItem(chrome, '#2');
      await chrome.waitFor("document.querySelector('#detail h2')?.textContent.includes('Local title links to #1') && document.querySelector('[data-tab=items].on')");
    }
  } finally {
    if (chrome) await closeSnapshotChrome(chrome);
    rmSync(profile, { recursive: true, force: true });
    await view.stop();
  }
}
