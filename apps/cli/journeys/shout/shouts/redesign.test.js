// pullboard: browser
/** @pullboard-test-gui */
/** Native conversations and real Chrome bounds prove the Shouts redesign [N26]. */
import assert from 'node:assert/strict';
import {
  mkdtempSync,
  rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import {
  machine,
  project,
  build,
  startView,
  boardOf,
  chromeExecutable,
  openSnapshotChrome,
  closeSnapshotChrome,
  press,
} from '../../../tests/fixtures/cockpit/harness.js';
import {
  MACHINE_MODEL,
} from '../../../tests/fixtures/cockpit/machine.js';

/** Read rendered boxes and text through the shared stable browser observation boundary. */
async function observe(chrome, expression) {
  return JSON.parse(await chrome.stable('JSON.stringify(' + expression + ')'));
}

test('Shouts groups native messages and keeps conversation text clear of agents and status at desktop and phone widths [N26]', { timeout: 150_000 }, async () => {
  const executable = chromeExecutable();
  assert.ok(executable, 'real Chrome is required for conversation geometry');
  const box = machine(), demo = project(box, 'shouts-redesign');
  const longTitle = 'A long item title ' + 'bounded '.repeat(30);
  for (const title of ['Greeting', longTitle, 'Question for the person'])
    await box.inProcess(demo.repo, 'add', 'web', title, '--specs', 'G1', '--criterion', 'The page greets the visitor.');
  build(box, demo, 1, 'greeting.html');
  await box.inProcess(demo.web, 'claim', '2');
  await box.inProcess(demo.web, 'shout', 'coordinator', '#1: May I ship this greeting?', '--kind', 'question', '--decision');
  const longWords = ('#2: Keep these exact words. ' + 'A long native message with source and context. '.repeat(30)).slice(0, 399).trim();
  await box.inProcess(demo.web, 'shout', 'web', longWords);
  await box.inProcess(demo.repo, 'shout', 'web', '#2: Coordinator reply with src/cockpit.js and ABC_CODE and 0123456789abcdef0123456789abcdef01234567.');
  await box.inProcess(demo.repo, 'shout', 'person', '#3: Which greeting should we use?', '--decision');
  await box.inProcess(demo.repo, 'shout', 'web', 'A general update without an item.');
  const view = await startView(box), native = await boardOf(view, demo.repo);
  const question = native.shouts.find(message => message.shout_text === '#1: May I ship this greeting?');
  assert.ok(question, 'the real board recorded the agent question');
  const profile = mkdtempSync(join(tmpdir(), 'pullboard-shouts-redesign-chrome-'));
  let chrome;
  try {
    chrome = await openSnapshotChrome(executable, view.link.href, profile);
    await chrome.waitFor('!!data?.project && !!document.querySelector("[data-tab=shouts]")');
    await press(chrome, 'document.querySelector("[data-tab=shouts]")');
    await chrome.waitFor('document.querySelectorAll("#feed .sx-th").length === 4');
    const escape = () => chrome.stable("(document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })), true)");
    for (const width of [1280, 320]) {
      await chrome.send('Emulation.setDeviceMetricsOverride', { width, height: 900, deviceScaleFactor: 1, mobile: false });
      await chrome.waitFor('innerWidth === ' + width);
      await chrome.stable('new Promise(done => requestAnimationFrame(() => requestAnimationFrame(done)))');
      const list = await observe(chrome, `(() => {
        const box = selector => { const r = document.querySelector(selector).getBoundingClientRect(); return {left:r.left,right:r.right,top:r.top,bottom:r.bottom,width:r.width}; };
        const status = document.querySelector('.status'), style = getComputedStyle(status);
        const surface = document.createElement('i'); surface.style.background = 'var(--surface)'; document.body.append(surface);
        const opaqueSurface = getComputedStyle(surface).backgroundColor; surface.remove();
        const row = document.querySelector('#feed .sx-th');
        return { pageWidth:document.documentElement.scrollWidth, viewport:innerWidth, feed:box('#feed'), panel:box('#shouts-pane > aside'),
          composer:document.querySelector('#shout-form').getClientRects().length, status:{...box('.status'),visible:style.display !== 'none',background:style.backgroundColor,expected:opaqueSurface},
          component:document.querySelector('#page-controls [data-page-ctl=shouts]').dataset.pageCtl, rowBox:{height:row.getBoundingClientRect().height,lines:getComputedStyle(row).whiteSpace},
          open:document.querySelectorAll('#feed .sx-th.open').length, panels:document.querySelectorAll('#feed .sx-tp').length,
          needs:[...document.querySelectorAll('#shouts-needs .sx-th')].map(r => r.dataset.shoutThread), threads:[...document.querySelectorAll('#shouts-threads > .sx-th')].map(r => r.dataset.shoutThread),
          rows:[...document.querySelectorAll('#feed .sx-th')].map(r => ({key:r.dataset.shoutThread,title:r.querySelector('.sx-tt').textContent,count:r.querySelector('.sx-n').textContent,text:r.querySelector('.sx-tx').textContent,textLeft:r.querySelector('.sx-tx').getBoundingClientRect().left,textWidth:r.querySelector('.sx-tx').getBoundingClientRect().width,titleRight:r.querySelector('.sx-tt').getBoundingClientRect().right})),
          agent:{seat:document.querySelector('#agents .sx-ag .sx-seat')?.textContent,title:document.querySelector('#agents .sx-ag')?.title,
            age:document.querySelector('#agents .sx-ag time')?.textContent,item:document.querySelector('#agents .sx-ag .sx-it')?.textContent,
            group:document.querySelector('#agents .sx-grp')?.textContent, height:document.querySelector('#agents .sx-ag')?.getBoundingClientRect().height} };
      })()`);
      console.log('PULLBOARD_SHOUTS_REDESIGN ' + JSON.stringify({ width, list }));
      assert.equal(list.pageWidth, list.viewport, 'the feed never widens the viewport');
      if (width === 1280) assert.ok(list.feed.right <= list.panel.left, 'the feed column ends before Agents begins');
      assert.equal(list.composer, 0, 'the composer waits out of sight: replies are sent from inside a thread');
      assert.equal(list.component, 'shouts', 'the one filter set lives in the strip');
      assert.ok(list.rowBox.height <= 64 && list.rowBox.lines === 'nowrap', 'a thread is a two-line row that never wraps: ' + JSON.stringify([width, list.rowBox]));
      assert.deepEqual([list.open, list.panels], [0, 0], 'no thread is open until one is pressed');
      assert.deepEqual(list.needs, ['item:3'], 'the ask waiting on the person sits first, under Needs your answer');
      assert.deepEqual([...list.threads].sort(), ['item:1', 'item:2', 'none']);
      assert.equal(list.rows.find(row => row.key === 'item:2').count, '2');
      assert.equal(list.rows.find(row => row.key === 'item:1').count, '1');
      assert.ok(list.rows.find(row => row.key === 'item:2').text.startsWith('#2: Coordinator reply'), 'the row shows the latest words');
      assert.ok(list.rows.every(row => row.textWidth > 20 && row.textLeft >= 0), 'each row shows its latest words: ' + JSON.stringify([width, list.rows]));
      assert.equal(list.agent.seat, 'web-1');
      assert.equal(list.agent.group, 'Building1');
      assert.match(list.agent.title, /web-1 holds #2 and 1 more/);
      assert.ok(list.agent.title.includes(MACHINE_MODEL));
      assert.match(list.agent.age, /^(now|\d+[mhd])$/);
      assert.ok(list.agent.item.includes('#2'));
      assert.ok(list.agent.height <= 48, 'an agent is one line, a 44px target');
      if (list.status.visible) {
        assert.equal(list.status.background, list.status.expected, 'the status bar uses the opaque surface token');
        assert.equal(list.status.bottom, 900, 'the measured status surface covers the foot of the viewport');
      }
      // A thread opens in place under its row, one at a time, and closes with a second press, Esc or its x; the address keeps it.
      await press(chrome, 'document.querySelector(' + JSON.stringify('[data-shout-thread="item:2"]') + ')');
      await chrome.waitFor('document.querySelectorAll("#feed .sx-tp").length === 1 && document.querySelectorAll("#feed .sx-msg").length === 2');
      const conversation = await observe(chrome, `(() => {
        const message = [...document.querySelectorAll('#feed .sx-msg')].find(node => node.querySelector('.sx-sn').textContent === 'web-1');
        const row = document.querySelector('[data-shout-thread="item:2"]');
        return {words:message.querySelector('.sx-tx').textContent,clock:message.querySelector('time').textContent,
          under:row.nextElementSibling.classList.contains('sx-tp'),expanded:row.getAttribute('aria-expanded'),reply:document.querySelector('#feed [data-reply] input')?.placeholder,
          address:location.pathname + location.hash, hash:document.querySelector('#feed .sx-msg:not(.quiet) .sx-tx')?.textContent,
          item:document.querySelector('#feed .sx-ph a')?.textContent, coordinator:document.querySelectorAll('#feed .sx-si.coord').length > 0};
      })()`);
      assert.equal(conversation.words, longWords, 'native message words are never rewritten');
      assert.match(conversation.clock, /^\d{1,2}:\d{2} [AP]M$/, 'the opened conversation keeps the approved person clock');
      assert.equal(conversation.under, true, 'the thread opens right under its row');
      assert.equal(conversation.expanded, 'true');
      assert.equal(conversation.reply, 'Reply on #2');
      assert.match(conversation.address, /\/shouts\/\d+$/, 'the open thread is kept in the address: ' + conversation.address);
      assert.equal(conversation.item, 'Item #2 ›');
      assert.equal(conversation.coordinator, true, 'the coordinator has its own mark');
      await press(chrome, 'document.querySelector("#feed [data-shout-thread=\"item:1\"]")');
      await chrome.waitFor('document.querySelectorAll("#feed .sx-tp").length === 1 && document.querySelector("#feed .sx-th.open").dataset.shoutThread === "item:1"');
      await press(chrome, 'document.querySelector("#feed [data-shout-thread=\"item:1\"]")');
      await chrome.waitFor('document.querySelectorAll("#feed .sx-tp").length === 0');
      assert.doesNotMatch(await chrome.stable('location.pathname + location.hash'), /\/shouts\/\d+$/, 'closing a thread takes it out of the address');
      await press(chrome, 'document.querySelector("#feed [data-shout-thread=\"item:2\"]")');
      await chrome.waitFor('document.querySelectorAll("#feed .sx-tp").length === 1');
      await escape();
      await chrome.waitFor('document.querySelectorAll("#feed .sx-tp").length === 0');
      await press(chrome, 'document.querySelector("#feed [data-shout-thread=\"item:2\"]")');
      await chrome.waitFor('document.querySelectorAll("#feed .sx-tp").length === 1');
      await press(chrome, 'document.querySelector("#feed .sx-xb")');
      await chrome.waitFor('document.querySelectorAll("#feed .sx-tp").length === 0');
      await press(chrome, 'document.querySelector("[data-page-ctl=shouts][data-value=questions]")');
      await chrome.waitFor('document.querySelectorAll("#feed .sx-th").length === 2');
      await press(chrome, 'document.querySelector("[data-page-ctl=shouts][data-value=you]")');
      await chrome.waitFor('document.querySelectorAll("#feed .sx-th").length === 1 && document.querySelector("#feed .sx-th").dataset.shoutThread === "item:3"');
      await press(chrome, 'document.querySelector("[data-page-ctl=shouts][data-value=all]")');
      await chrome.waitFor('document.querySelectorAll("#feed .sx-th").length === 4');
    }
    // The ask waiting on the person is answered from inside its thread.
    await press(chrome, 'document.querySelector("#feed [data-shout-thread=\"item:3\"]")');
    await chrome.waitFor('!!document.querySelector("#feed [data-reply][data-ask] input")');
    assert.equal(await chrome.stable('document.querySelector("#feed [data-reply] input").placeholder'), 'Answer on #3');
    await chrome.stable('(() => { const input = document.querySelector("#feed [data-reply] input"); input.value = "Use the first greeting."; input.dispatchEvent(new Event("input", { bubbles: true })); input.closest("form").requestSubmit(); return true; })()');
    await chrome.waitFor('data.project.shouts.some(x => x.shout_text === "Use the first greeting.")');
    await box.inProcess(demo.repo, 'answer', String(question.shout_id), 'Ship the greeting.');
    await press(chrome, 'document.querySelector("[data-page-ctl=shouts][data-value=questions]")');
    await chrome.waitFor('document.querySelectorAll("#feed .sx-th").length === 0');
    await press(chrome, 'document.querySelector("[data-page-ctl=shouts][data-value=all]")');
    await chrome.waitFor('document.querySelector(\'[data-shout-thread="item:1"] .sx-n\')?.textContent === "2"');
  } finally {
    if (chrome) await closeSnapshotChrome(chrome);
    await view.stop();
    rmSync(profile, { recursive: true, force: true });
  }
});
