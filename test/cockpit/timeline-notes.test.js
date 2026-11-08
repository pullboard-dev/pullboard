// pullboard: browser
/** @pullboard-test-input source-tree */
/** @pullboard-test-gui */
/** @pullboard-test-journey Native long-note expansion and full-hash copy in Timeline, Needs you, and Items [N26]. */
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { boardOf } from './fixture.js';
import { chromeExecutable } from './fixture.js';
import { closeSnapshotChrome } from './fixture.js';
import { machine } from './fixture.js';
import { openSnapshotChrome } from './fixture.js';
import { press } from './fixture.js';
import { project } from './fixture.js';
import { startView } from './fixture.js';

/** Seed a private native board and inspect its actual HTTP and Chrome presentation. */
test('long timeline notes expand in place and hashes show twelve characters with full copy [N26]', { timeout: 180_000 }, async () => {
  const executable = chromeExecutable();
  assert.ok(executable, 'The timeline note and hash journey requires real Chrome.');
  const box = machine();
  const spec = '# Needs review\n\n## G · Goals\n- G1 [approved, must] The approved requirement carries an agent commit into Needs you. | gate: review\n';
  const demo = project(box, 'timeline-notes', spec, {}, { agentApproved: true });
  box.run(demo.repo, 'add', 'web', 'Long note and hashes', '--specs', 'G1', '--criterion', 'The actual item retains its submitted commit.');
  box.run(demo.web, 'claim', '1');
  const longNote = [
    'Line 1: the complete note remains available after expansion.',
    'Line 2: the complete note remains available after expansion.',
    'Line 3: the complete note remains available after expansion.',
    'Line 4: the complete note remains available after expansion.',
    'Line 5: the complete note remains available after expansion.',
    'Line 6: the complete note remains available after expansion.',
    'Line 7: the complete note remains available after expansion.',
    'Line 8: the complete note remains available after expansion.',
  ].join('\n');
  box.run(demo.web, 'fact', '1', 'note', longNote);
  mkdirSync(join(demo.web, 'web'), { recursive: true });
  writeFileSync(join(demo.web, 'web/timeline.js'), 'export const timelineFixture = true;\n');
  box.git(demo.web, 'add', 'web/timeline.js');
  box.git(demo.web, 'commit', '-q', '-m', 'feat(web): keep timeline fixture [G1]');
  const commit = box.git(demo.web, 'rev-parse', 'HEAD');
  box.run(demo.web, 'fact', '1', 'note', `The submitted commit is ${commit}.`);
  box.run(demo.web, 'submit', '1', '--no-next');
  const view = await startView(box);
  let chrome;
  try {
    const state = await boardOf(view, demo.repo);
    const approval = state.spec.find(row => row.id === 'G1')?.agentApproval?.commit;
    const itemCommit = state.items.find(row => row.id === 1)?.commit;
    assert.match(approval ?? '', /^[a-f0-9]{40}$/u, 'the seeded Needs you row has a full approval hash');
    assert.equal(itemCommit, commit, 'the seeded Items row retains the submitted commit');
    const href = new URL(view.link.href);
    href.pathname = '/items/1';
    chrome = await openSnapshotChrome(executable, href.href, join(box.dir, 'timeline-notes-chrome'));
    await chrome.waitFor('view.item === 1 && !!document.querySelector("#detail .tl-note")');
    const noteSelector = '#detail .tl-fact[data-timeline-kind="note"] .tl-note';
    const bodySelector = noteSelector + ' .tl-body';
    assert.equal(await chrome.stable(`getComputedStyle(document.querySelector(${JSON.stringify(bodySelector)})).webkitLineClamp`), '3');
    assert.equal(await chrome.stable(`(() => { const body = document.querySelector(${JSON.stringify(bodySelector)}), style = getComputedStyle(body); return body.getBoundingClientRect().height <= parseFloat(style.lineHeight) * 3 + 1; })()`), true, 'the note is clamped to three visible lines');
    assert.equal(await chrome.stable(`document.querySelector(${JSON.stringify(noteSelector + ' [data-timeline-more]')}).textContent`), 'Show all');
    await press(chrome, `document.querySelector(${JSON.stringify(noteSelector + ' [data-timeline-more]')})`);
    assert.equal(await chrome.stable(`document.querySelector(${JSON.stringify(noteSelector)}).classList.contains('expanded')`), true);
    assert.match(await chrome.stable(`document.querySelector(${JSON.stringify(noteSelector + ' .tl-body')}).textContent`), /Line 8: the complete note remains available after expansion/u);
    const timelineHash = '#detail .tl button.hash-copy';
    assert.equal(await chrome.stable(`document.querySelector(${JSON.stringify(timelineHash)}).textContent`), commit.slice(0, 12));
    assert.equal(await chrome.stable(`document.querySelector(${JSON.stringify(timelineHash)}).title`), commit);
    assert.equal(await chrome.stable(`document.querySelector(${JSON.stringify(timelineHash)}).dataset.copy`), commit);
    await press(chrome, `document.querySelector(${JSON.stringify(timelineHash)})`);
    assert.match(await chrome.stable(`document.querySelector(${JSON.stringify(timelineHash)}).title`), /^(Copied|Could not copy) full hash$/u);

    await chrome.click(`document.querySelector('[data-tab="items"]')`);
    await chrome.waitFor('view.tab === "items" && !!document.querySelector("#needs")');
    const needHash = '#needs [data-agent-approved="G1"] [data-needs-field="commit"] .hash-copy';
    await chrome.click(`document.querySelector(${JSON.stringify('#needs [data-agent-approved="G1"] summary')})`);
    await chrome.waitFor(`document.querySelector(${JSON.stringify(needHash)})`);
    assert.equal(await chrome.stable(`document.querySelector(${JSON.stringify(needHash)}).textContent`), approval.slice(0, 12));
    assert.equal(await chrome.stable(`document.querySelector(${JSON.stringify(needHash)}).title`), approval);
    assert.equal(await chrome.stable(`document.querySelector(${JSON.stringify(needHash)}).dataset.copy`), approval);
    await press(chrome, `document.querySelector(${JSON.stringify(needHash)})`);
    assert.match(await chrome.stable(`document.querySelector(${JSON.stringify(needHash)}).title`), /^(Copied|Could not copy) full hash$/u);

    await chrome.send('Page.navigate', { url: href.href });
    await chrome.waitFor('view.item === 1 && !!document.querySelector("#detail [data-copy]")');
    const itemHash = '#detail .stack [data-copy]';
    assert.equal(await chrome.stable(`document.querySelector(${JSON.stringify(itemHash)}).textContent`), commit.slice(0, 12));
    assert.equal(await chrome.stable(`document.querySelector(${JSON.stringify(itemHash)}).title`), commit);
    assert.equal(await chrome.stable(`document.querySelector(${JSON.stringify(itemHash)}).dataset.copy`), commit);
    await press(chrome, `document.querySelector(${JSON.stringify(itemHash)})`);
    assert.match(await chrome.stable(`document.querySelector(${JSON.stringify(itemHash)}).title`), /^(Copied|Could not copy) full hash$/u);
    assert.deepEqual(chrome.exceptions, []);
  } finally {
    if (chrome) await closeSnapshotChrome(chrome);
    await view.stop();
  }
});
