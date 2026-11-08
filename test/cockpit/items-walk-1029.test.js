// pullboard: browser
/** @pullboard-test-input source-tree */
/** @pullboard-test-gui */
/** Real private native lifecycle proves presentation only, never independent review assurance [N26]. */
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { test } from 'node:test';
import * as store from '../../src/board.js';
import { openBoard } from '../../apps/lib/index.js';
import { machine, project, build, startView, chromeExecutable, openSnapshotChrome, closeSnapshotChrome, press } from './fixture.js';

/** Record real health transitions after the private fixture's native review. */
function seedHealth(demo) {
  // @pullboard-board-file journey: native health moves are read through authenticated HTTP and real Chrome.
  const board = openBoard(join(demo.repo, '.git/pullboard/board.sqlite'));
  try {
    const finding = { key: 'items-walk-fixture', cause: 'NO_REVIEWER', item: 1, subject: '#1', title: 'needs a review',
      since: new Date().toISOString(), why: 'This private fixture exercises native health presentation.', next: 'Review the fixture.' };
    store.recordHealthFindings(board, { agentId: 'coordinator', observedRevision: store.events(board).at(-1).event_id, findings: [finding] });
    store.recordHealthFindings(board, { agentId: 'coordinator', observedRevision: store.events(board).at(-1).event_id, findings: [] });
  } finally { store.closeBoard(board); }
}

test('Items walk renders short context hashes, plain waiting chips and colored history in the person clock in Chrome [N26]', { timeout: 120_000 }, async () => { // budget: real native fixture, authenticated HTTP and desktop/phone Chrome.
  const box = machine(), demo = project(box, 'items-walk');
  for (const [title, extra] of [['History subject', []], ['Dependency', []], ['Waiting item', ['--after', '2']]])
    box.run(demo.repo, 'add', 'web', title, '--specs', 'G1', '--criterion', 'Render this private fixture.', ...extra);
  build(box, demo, 1, 'items-walk.txt');
  const head = box.git(demo.web, 'rev-parse', 'HEAD');
  box.run(demo.web, 'fact', '1', 'note', 'Keep this original note and full source ' + head + '.');
  const reviewer = JSON.parse(box.run(demo.repo, 'worktree', 'web', '--model', 'Items walk reviewer fixture', '--json'));
  box.git(reviewer.path, 'switch', '--detach', head);
  box.run(reviewer.path, 'next', '--verify', '1');
  box.run(reviewer.path, 'verify', '1', 'reject', '--reason', 'BEHAVIOR_MISMATCH', '--clause', 'Render this private fixture.', '--note', 'Reviewed submitted ' + head, '--no-next');
  seedHealth(demo);
  const server = await startView(box);
  let chrome;
  try {
    const executable = chromeExecutable(); assert.ok(executable, 'real Chrome is required');
    chrome = await openSnapshotChrome(executable, 'about:blank', join(box.dir, 'items-walk-chrome'));
    await chrome.send('Emulation.setTimezoneOverride', { timezoneId: 'America/Chicago' });
    const href = new URL(server.link.href); href.pathname = '/items/1';
    await chrome.send('Page.navigate', { url: href.href });
    await chrome.waitFor('view.item === 1 && document.querySelector("#detail .tl [data-timeline-kind=reject]")');
    await press(chrome, "document.querySelector('#chain [data-item=\"3\"]')");
    await chrome.waitFor("view.item === 3 && document.querySelector('#detail .waits-on [data-go=\"item:2\"]')");
    await press(chrome, "document.querySelector('#detail .waits-on [data-go=\"item:2\"]')");
    await chrome.waitFor("view.item === 2");
    await press(chrome, "document.querySelector('#chain [data-item=\"1\"]')");
    await chrome.waitFor('view.item === 1 && document.querySelector("#detail .tl [data-timeline-kind=reject]")');
    for (const width of [1440, 375]) {
      await chrome.send('Emulation.setDeviceMetricsOverride', { width, height: 1000, deviceScaleFactor: 1, mobile: width < 500 });
      const actual = JSON.parse(await chrome.stable(`JSON.stringify((() => {
        const rows = [...document.querySelectorAll('#detail .tl > li')];
        const waiting = document.querySelector('#chain [data-item="3"]');
        const kinds = ['claim', 'reserve', 'reject', 'health-failure', 'note'];
        return { visible:document.querySelector('[data-pane=items]').innerText,
          waiting:waiting.querySelector('.item-stage .stage-word').textContent, waitingDetail:waiting.querySelector('.item-stage .stage-detail').textContent,
          border:getComputedStyle(waiting).borderTopColor,
          kinds:kinds.map(kind => { const row = rows.find(row => row.dataset.timelineKind === kind), marker = row.querySelector('.tl-marker'), label = row.querySelector('.tl-kind');
            return {kind, icon:marker.innerHTML, color:getComputedStyle(marker).color, labelColor:getComputedStyle(label).color, label:label.textContent}; }),
          times:rows.map(row => row.querySelector('.tl-heading > time').textContent),
          copy:[...document.querySelectorAll('#detail .hash-copy')].map(node => [node.textContent,node.dataset.copy]) };
      })())`));
      assert.doesNotMatch(actual.visible, /\b[0-9a-f]{40}\b/u);
      assert.equal(actual.waiting, 'Gated'); assert.equal(actual.waitingDetail, 'by #2');
      assert.ok(['rgba(0, 0, 0, 0)', 'transparent'].includes(actual.border), width + ': no warning outline');
      assert.equal(new Set(actual.kinds.map(row => row.icon)).size, 5, 'each native kind has its approved verb icon');
      assert.equal(new Set(actual.kinds.map(row => row.color)).size, 5, 'build/review/back/sentinel/note have distinct tones');
      for (const row of actual.kinds) assert.equal(row.labelColor, row.color, row.kind + ': kind label matches icon tone');
      assert.deepEqual(actual.kinds.map(row => row.label), ['build', 'review', 'sent back', 'sentinel', 'note']);
      assert.ok(actual.times.every(time => /\b(?:1[0-2]|[1-9]):\d{2}\s*[AP]M\b/u.test(time)), JSON.stringify(actual.times));
      assert.ok(actual.copy.some(([label, full]) => label === head.slice(0, 12) && full === head), 'full source remains available to copy');
    }
    assert.equal(await chrome.stable("document.querySelector('#chain [data-item=\"1\"] .meta').textContent"), 'Behavior did not match Reviewed submitted ' + head.slice(0, 12));
    assert.deepEqual(chrome.exceptions, []);
  } finally {
    if (chrome) await closeSnapshotChrome(chrome);
    await server.stop();
  }
});
