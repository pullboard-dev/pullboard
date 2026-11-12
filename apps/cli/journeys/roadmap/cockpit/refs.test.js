// pullboard: browser
/** @pullboard-test-gui */
/** Cockpit roadmap checks: references and send-backs, using the shared real-board fixtures [N26]. */
import assert from 'node:assert/strict';
import {
  mkdtempSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import {
  tapTarget,
  SPEC,
  machine,
  project,
  build,
  sendBack,
  startView,
  target,
  chromeExecutable,
  closeSnapshotChrome,
  press,
  pickProject,
  chooseFilter,
} from '../../../tests/fixtures/cockpit/harness.js';
import {
  openRoadmapChrome,
  openRoadmapItem,
} from '../../../tests/fixtures/cockpit/roadmap.js';

test('Roadmap references stay inline and rows expand before opening Items [N26,N38]', { timeout: 90_000 }, async (t) => {
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
    await press(chrome, "document.querySelector('[data-tab=items]')");
    await chrome.waitFor("document.querySelector('#chain .row[data-item=\"2\"]')");
    for (const width of [375, 1280]) {
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
        await chrome.click(`document.querySelector('[data-tab="${tab}"]')`);
        if (tab !== 'roadmap') await chrome.click(`document.querySelector('[data-rows="${tab}:all"]')`);
        const metrics = JSON.parse(await chrome.stable(`JSON.stringify((() => {
          const ref = document.querySelector(${JSON.stringify(selector)});
          const row = ref?.closest('.milestone-item');
          const style = ref && getComputedStyle(ref);
          return { present:!!ref, title:ref?.title, border:style?.borderWidth, height:ref?.getBoundingClientRect().height,
            line:style && parseFloat(style.lineHeight), nested:!!ref?.parentElement.closest('button'),
            rowHeight:row?.getBoundingClientRect().height };
        })())`));
        assert.ok(metrics.present, `${width}: ${selector} contains its inline reference`);
        assert.equal(metrics.title, target, `${width}: the reference tooltip names the target on its own board`);
        assert.equal(metrics.border, '0px', `${width}: ${selector} has no box`);
        assert.ok(Math.abs(metrics.height - metrics.line) < 1, `${width}: ${selector} keeps the text line height`);
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
          await chrome.waitFor("document.querySelector('[data-tab=items].on') && document.querySelector('#detail h2 > span')?.textContent === '#2'");
          assert.equal(await chrome.stable('view.root'), target === 'Remote target' ? other.repo : demo.repo);
          continue;
        }
        await chrome.click(`document.querySelector(${JSON.stringify(selector)})`);
        await chrome.waitFor("!document.body.classList.contains('switching') && document.querySelector('[data-tab=items].on') && document.querySelector('#detail h2 > span')?.textContent === '#1'");
        assert.ok((await chrome.stable("document.querySelector('#detail h2').textContent")).includes(target), 'the reference opens its target title');
        assert.equal(await chrome.stable('view.root'), target === 'Remote target' ? other.repo : demo.repo, 'duplicate item numbers stay bound to their own board');
      }
      await chrome.click(`document.querySelector('[data-tab="items"]')`); await chrome.click(`document.querySelector('#chain .row[data-item="2"]')`);
      // The latest verdict has its own panel, and the history row keeps its own copy (639c16dbb5); read the panel's.
      await chrome.waitFor("document.querySelector('#detail .item-panel-latest .verdict .note')");
      assert.equal(await chrome.stable("document.querySelectorAll('#detail .item-panel-latest .verdict .note .ref').length"), 1, 'verdict prose keeps its item reference');
      await chrome.click("document.querySelector('#detail .item-panel-latest .verdict .note .ref')");
      await chrome.waitFor("document.querySelector('#detail h2')?.textContent.includes('Local target')");
      await chooseFilter(chrome, 'state:active');
      const decision = "document.querySelector('#needs details[data-needs-key^=\"decision:\"]')";
      if (await chrome.stable(`${decision}.open`) !== true) await chrome.click(`${decision}.querySelector('summary')`);
      await chrome.click(`${decision}.querySelector('button[data-go^="decide:"]')`);
      assert.equal(await chrome.stable("document.querySelectorAll('#answering-q .ref').length"), 1, 'the answering question keeps its inline item reference');
      await chrome.click("document.querySelector('#answering-q .ref')");
      await chrome.waitFor("document.querySelector('#detail h2')?.textContent.includes('Local target') && document.querySelector('[data-tab=items].on')");
      await chrome.click("document.querySelector('[data-tab=roadmap]')");
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
});

test('the expanded row keeps send-backs short and names agents plainly [N26]', { timeout: 90_000 }, async () => {
  const executable = chromeExecutable();
  assert.ok(executable, 'Chrome is required for the roadmap send-back check.');
  const box = machine(), alpha = project(box, 'short-roadmap');
  const long = 'Evidence '.repeat(25).trim();
  box.run(alpha.repo, 'add', 'web', 'Several sentences', '--specs', 'G1', '--criterion', 'Ready.');
  build(box, alpha, 1, 'several.html');
  sendBack(box, alpha, 1, 'The heading is missing. The footer link is also broken.\nMore evidence stays in Items.');
  box.run(alpha.repo, 'add', 'web', 'One long sentence', '--specs', 'G1', '--criterion', 'Ready.');
  build(box, alpha, 2, 'long.html'); sendBack(box, alpha, 2, long);
  box.run(alpha.repo, 'milestone', 'add', 'Next', '--reason', 'Arrange fixture release', '--items', '1,2');
  const view = await startView(box), profile = mkdtempSync(join(tmpdir(), 'pullboard-short-roadmap-chrome-'));
  let chrome;
  const row = id => `[...document.querySelectorAll('#roadmap .milestone-item')].find(x=>x.querySelector('.id')?.textContent===${JSON.stringify(id)})`;
  /** Expand a row, if it is not open yet, and read its detail once it has loaded. */
  async function opened(id) {
    if (await chrome.stable(`${row(id)}?.getAttribute('aria-expanded')`) !== 'true') await press(chrome, row(id));
    await chrome.waitFor(`${row(id)}?.getAttribute('aria-expanded')==='true' && !${row(id)}.parentElement.querySelector('.milestone-why[aria-busy]')`);
    return await chrome.stable(`${row(id)}.parentElement.querySelector('.milestone-why').textContent`);
  }
  try {
    chrome = await openRoadmapChrome(executable, view.link.href, profile);
    await chrome.send('Emulation.setLocaleOverride', { locale: 'en-US' });
    await chrome.send('Page.reload');
    await chrome.waitFor('data?.project?.milestones?.length===1');
    await press(chrome, "document.querySelector('[data-tab=roadmap]')");
    await chrome.waitFor(`Boolean(${row('#2')})`);
    const several = await opened('#1');
    const returned = await chrome.stable(`${row('#1')}.parentElement.querySelector('.roadmap-return').textContent`);
    assert.match(returned, /^\d{1,2}:\d{2}\s[AP]M by coordinator: The heading is missing\.…$/u, 'a multi-sentence send-back shows only its first sentence, then an ellipsis');
    assert.doesNotMatch(several, /footer link|More evidence/u, 'the rest of the note stays out of the row; Open in Items shows it');
    await opened('#2');
    const capped = await chrome.stable(`${row('#2')}.parentElement.querySelector('.roadmap-return').textContent`);
    assert.equal(capped.replace(/^.*?by coordinator: /u, ''), long.slice(0, 160).trimEnd() + '…', 'a sentence longer than 160 characters is cut there, with an ellipsis');
    const panel = await opened('#1');
    assert.match(panel, /Agents.*web-1 \(Fixture Model\) built/u, 'an agent with a known model keeps the model after its name');
    assert.doesNotMatch(panel, /\(unknown\)/u, 'the coordinator, whose model is unknown, is named alone with no placeholder');
    const times = JSON.parse(await chrome.stable(`JSON.stringify([...${row('#1')}.parentElement.querySelectorAll('.roadmap-history time')].map(t=>[t.getAttribute('datetime'),t.textContent]))`));
    assert.ok(times.length >= 3, 'the history lists its moves with times');
    for (const [, text] of times) assert.match(text, /^\d{1,2}:\d{2}\s[AP]M$/u, 'history times use the viewer locale, such as 7:09 PM');
    assert.equal(await chrome.stable(`[...${row('#1')}.parentElement.querySelectorAll('.roadmap-history time')].every(t=>t.textContent===new Date(t.getAttribute('datetime')).toLocaleTimeString([],{hour:'numeric',minute:'2-digit'}))`), true, 'history times match the locale formatter');
    assert.deepEqual(chrome.exceptions, []);
  } finally { if(chrome) await closeSnapshotChrome(chrome); rmSync(profile,{recursive:true,force:true}); await view.stop(); }
});
