// pullboard: browser
/** @pullboard-test-gui */
/** Cockpit roadmap checks: send-backs stay short and agents are named plainly, using the shared real-board fixtures [N26]. */
import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import { test } from 'node:test';
import {
  machine,
  project,
  build,
  sendBack,
  startView,
  chromeExecutable,
  closeSnapshotChrome,
  press,
} from '../../../tests/fixtures/cockpit/harness.js';
import { fileFixtureItem } from '../../../tests/fixtures/testkit.js';
import { privateFixtureFiles } from '../../../tests/fixtures/child.js';
import { MACHINE_MODEL } from '../../../tests/fixtures/cockpit/machine.js';
import { openRoadmapChrome } from '../../../tests/fixtures/cockpit/roadmap.js';

test('the expanded row keeps send-backs short and names agents plainly [N26]', { timeout: 90_000 }, async () => {
  const executable = chromeExecutable();
  assert.ok(executable, 'Chrome is required for the roadmap send-back check.');
  const box = machine(), alpha = project(box, 'short-roadmap');
  const long = 'Evidence '.repeat(25).trim();
  fileFixtureItem(box, alpha.repo, { lane: 'web', title: 'Several sentences', criterion: 'Ready.', check: null, args: ['--specs', 'G1'] });
  build(box, alpha, 1, 'several.html');
  sendBack(box, alpha, 1, 'The heading is missing. The footer link is also broken.\nMore evidence stays in Items.');
  fileFixtureItem(box, alpha.repo, { lane: 'web', title: 'One long sentence', criterion: 'Ready.', check: null, args: ['--specs', 'G1'] });
  build(box, alpha, 2, 'long.html'); sendBack(box, alpha, 2, long);
  box.run(alpha.repo, 'milestone', 'add', 'Next', '--reason', 'Arrange fixture release', '--items', '1,2');
  const view = await startView(box), profile = privateFixtureFiles('pullboard-short-roadmap-chrome-').root;
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
    assert.match(panel, new RegExp(`Agents.*web-1 \\(${MACHINE_MODEL}\\) built`, 'u'), 'an agent with a known model keeps the model after its name');
    assert.doesNotMatch(panel, /\(unknown\)/u, 'the coordinator, whose model is unknown, is named alone with no placeholder');
    const times = JSON.parse(await chrome.stable(`JSON.stringify([...${row('#1')}.parentElement.querySelectorAll('.roadmap-history time')].map(t=>[t.getAttribute('datetime'),t.textContent]))`));
    assert.ok(times.length >= 3, 'the history lists its moves with times');
    for (const [, text] of times) assert.match(text, /^\d{1,2}:\d{2}\s[AP]M$/u, 'history times use the viewer locale, such as 7:09 PM');
    assert.equal(await chrome.stable(`[...${row('#1')}.parentElement.querySelectorAll('.roadmap-history time')].every(t=>t.textContent===new Date(t.getAttribute('datetime')).toLocaleTimeString([],{hour:'numeric',minute:'2-digit'}))`), true, 'history times match the locale formatter');
    assert.deepEqual(chrome.exceptions, []);
  } finally { if(chrome) await closeSnapshotChrome(chrome); rmSync(profile,{recursive:true,force:true}); await view.stop(); }
});
