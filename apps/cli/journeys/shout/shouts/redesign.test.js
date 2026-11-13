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
    await chrome.waitFor('document.querySelectorAll(".conversation-row").length === 4');
    for (const width of [1280, 320]) {
      await chrome.send('Emulation.setDeviceMetricsOverride', { width, height: 900, deviceScaleFactor: 1, mobile: false });
      await chrome.waitFor('innerWidth === ' + width);
      await chrome.stable('new Promise(done => requestAnimationFrame(() => requestAnimationFrame(done)))');
      const list = await observe(chrome, `(() => {
        const box = selector => { const r = document.querySelector(selector).getBoundingClientRect(); return {left:r.left,right:r.right,top:r.top,bottom:r.bottom,width:r.width}; };
        const status = document.querySelector('.status'), style = getComputedStyle(status);
        const surface = document.createElement('i'); surface.style.background = 'var(--surface)'; document.body.append(surface);
        const opaqueSurface = getComputedStyle(surface).backgroundColor; surface.remove();
        return { pageWidth:document.documentElement.scrollWidth, viewport:innerWidth, feed:box('#feed'), panel:box('#shouts-pane > aside'),
          composer:box('#shout-form .composer'), toggle:box('#asks-slot .seg'), status:{...box('.status'),visible:style.display !== 'none',background:style.backgroundColor,expected:opaqueSurface},
          component:document.querySelector('#asks-slot .seg').dataset.segmentedControl,
          rows:[...document.querySelectorAll('.conversation-row')].map(row => ({key:row.dataset.shoutThread,title:row.querySelector('.conversation-title').textContent,preview:row.querySelector('.conversation-preview').textContent,chip:row.querySelector('.chip').textContent})),
          decisions:!document.querySelector('#coordinator-decisions').hidden,
          agent:{name:document.querySelector('#agents .agent-row .agent-who b')?.textContent,model:document.querySelector('#agents .agent-model')?.textContent,
            avatars:document.querySelectorAll('#agents .avatar').length,title:document.querySelector('#agents .agent-row')?.title,
            age:document.querySelector('#agents .agent-state time')?.textContent,item:document.querySelector('#agents .agent-doing')?.textContent,
            state:document.querySelector('#agents .agent-state .stage-word')?.textContent} };
      })()`);
      console.log('PULLBOARD_SHOUTS_REDESIGN ' + JSON.stringify({ width, list }));
      assert.equal(list.pageWidth, list.viewport, 'the feed and compact composer never widen the viewport');
      if (width === 1280) assert.ok(list.feed.right <= list.panel.left, 'the feed column ends before Agents begins');
      assert.ok(Math.min(list.composer.bottom, list.toggle.bottom) > Math.max(list.composer.top, list.toggle.top), 'composer and shared toggle occupy one row');
      assert.ok(Math.abs((list.composer.bottom - list.composer.top) - (list.toggle.bottom - list.toggle.top)) <= 16, 'the empty composer stays one line tall beside the toggle');
      assert.equal(list.component, 'data-shout-filter');
      assert.equal(list.rows.filter(row => row.key === 'item:2').length, 1, 'one item has one conversation');
      assert.equal(list.rows.find(row => row.key === 'item:2').chip, '2 messages');
      assert.ok(list.rows.find(row => row.key === 'item:2').preview.startsWith('coordinator: #2: Coordinator reply'));
      assert.equal(list.rows.find(row => row.key === 'item:1').chip, 'Question open');
      assert.equal(list.decisions, false, 'there is no pinned coordinator decisions wall');
      assert.equal(list.agent.name, 'web-1');
      assert.equal(list.agent.model, MACHINE_MODEL);
      assert.equal(list.agent.avatars, 0);
      assert.match(list.agent.title, /\+1 more item/);
      assert.match(list.agent.age, /^(now|\d+[mhd])$/);
      assert.ok(list.agent.item.includes('#2 '));
      assert.equal(list.agent.state, 'Building');
      if (list.status.visible) {
        assert.equal(list.status.background, list.status.expected, 'the status bar uses the opaque surface token');
        assert.equal(list.status.bottom, 900, 'the measured status surface covers the foot of the viewport');
      }
      await press(chrome, 'document.querySelector(' + JSON.stringify('[data-shout-thread="item:2"]') + ')');
      await chrome.waitFor('document.querySelectorAll("#feed .shout").length === 2');
      const conversation = await observe(chrome, `(() => {
        const message = [...document.querySelectorAll('#feed .shout')].find(node => node.querySelector('.who').textContent === 'web-1');
        const lead = document.querySelector('#feed .shout.lead'), text = message.querySelector('.text'), css = getComputedStyle(text), bounds = text.getBoundingClientRect();
        return {words:text.textContent,clamp:css.webkitLineClamp,height:bounds.height,lineHeight:parseFloat(css.lineHeight),
          more:message.querySelector('[data-more]').textContent,model:message.querySelector('.who').title,
          clock:message.querySelector('time').textContent,avatars:document.querySelectorAll('#feed .avatar').length,
          coordinatorBackground:getComputedStyle(lead).backgroundColor, hash:lead.querySelector('code.sha')?.textContent,
          path:lead.querySelector('code.path')?.textContent,code:lead.querySelector('code.code')?.textContent};
      })()`);
      assert.equal(conversation.words, longWords, 'native message words are never rewritten');
      assert.equal(conversation.clamp, '3');
      assert.ok(conversation.height <= conversation.lineHeight * 3 + 1, 'long messages occupy at most three lines');
      assert.equal(conversation.more, 'Show all');
      assert.equal(conversation.model, MACHINE_MODEL);
      assert.match(conversation.clock, /^\d{1,2}:\d{2} [AP]M$/, 'the opened conversation keeps the approved person clock');
      assert.equal(conversation.avatars, 0);
      assert.notEqual(conversation.coordinatorBackground, 'rgba(0, 0, 0, 0)');
      assert.equal(conversation.hash, '0123456789ab');
      assert.equal(conversation.path, 'src/cockpit.js');
      assert.equal(conversation.code, 'ABC_CODE');
      await press(chrome, 'document.querySelector("#feed .shout:not(.lead) [data-more]")');
      await chrome.waitFor('document.querySelector("#feed .shout:not(.lead)").classList.contains("open")');
      const expanded = await observe(chrome, `(() => { const text=document.querySelector('#feed .shout:not(.lead) .text');return {height:text.getBoundingClientRect().height,lineHeight:parseFloat(getComputedStyle(text).lineHeight)}; })()`);
      assert.ok(expanded.height > expanded.lineHeight * 3, 'Show all actually reveals the complete message');
      await press(chrome, 'document.querySelector("#feed .shout:not(.lead) [data-more]")');
      await chrome.waitFor('!document.querySelector("#feed .shout:not(.lead)").classList.contains("open")');
      await press(chrome, 'document.querySelector("[data-shout-filter=questions]")');
      await chrome.waitFor('document.querySelectorAll(".conversation-row").length === 2');
      await press(chrome, 'document.querySelector("[data-shout-filter=you]")');
      await chrome.waitFor('document.querySelectorAll(".conversation-row").length === 1 && document.querySelector(".conversation-row").dataset.shoutThread === "item:3"');
      await press(chrome, 'document.querySelector(\'[data-shout-thread="item:3"]\')');
      await chrome.waitFor('!!document.querySelector("#feed .answer[data-go]")');
      await press(chrome, 'document.querySelector("#feed .answer[data-go]")');
      await chrome.waitFor('!document.querySelector("#answering").hidden');
      const answering = await observe(chrome, `(() => {
        const composer = document.querySelector('#shout-form .composer').getBoundingClientRect();
        const toggle = document.querySelector('#asks-slot .seg').getBoundingClientRect();
        return { overlap:Math.min(composer.bottom,toggle.bottom)-Math.max(composer.top,toggle.top),
          width:document.documentElement.scrollWidth, viewport:innerWidth,
          question:document.querySelector('#answering-q').textContent,
          locked:document.querySelector('#shout-to').disabled, action:document.querySelector('#shout-send').getAttribute('aria-label') };
      })()`);
      assert.ok(answering.overlap > 0, 'the answer form keeps the composer beside the shared filter');
      assert.equal(answering.width, answering.viewport, 'answering never widens the phone or desktop');
      assert.equal(answering.question, '#3: Which greeting should we use?', 'the complete native question reaches the answer form');
      assert.equal(answering.locked, true);
      assert.equal(answering.action, 'Answer');
      await press(chrome, 'document.querySelector("#answer-cancel")');
      await chrome.waitFor('document.querySelector("#answering").hidden && !document.querySelector("#shout-to").disabled');
      await press(chrome, 'document.querySelector("[data-shout-filter=all]")');
      await chrome.waitFor('document.querySelectorAll(".conversation-row").length === 4');
    }
    await box.inProcess(demo.repo, 'answer', String(question.shout_id), 'Ship the greeting.');
    await press(chrome, 'document.querySelector("[data-shout-filter=questions]")');
    await chrome.waitFor('document.querySelectorAll(".conversation-row").length === 1 && document.querySelector(".conversation-row").dataset.shoutThread === "item:3"');
    await press(chrome, 'document.querySelector("[data-shout-filter=all]")');
    await chrome.waitFor('document.querySelector(\'[data-shout-thread="item:1"] .chip\')?.textContent === "2 messages"');
  } finally {
    if (chrome) await closeSnapshotChrome(chrome);
    await view.stop();
    rmSync(profile, { recursive: true, force: true });
  }
});
