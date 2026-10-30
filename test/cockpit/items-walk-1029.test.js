/** @pullboard-test-input source-tree */
/** @pullboard-test-gui */
/** Native event-import fixture proves presentation only, never independent review assurance [N26]. */
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { renameSync } from 'node:fs';
import { test } from 'node:test';
import * as store from '../../src/board.js';
import { openBoard } from '../../src/native-board.js';
import { exportBoard, importBoard } from '../../src/exchange.js';
import { machine, project, startView, chromeExecutable, openSnapshotChrome, closeSnapshotChrome } from './fixture.js';

/** Add historical native-shaped review and sentinel events to the private presentation fixture. */
function seedHistory(box, demo, head) {
  const file = join(demo.repo, '.git/pullboard/board.sqlite');
  let document;
  // @pullboard-board-file journey: authenticated HTTP later reads this private native export/import.
  const board = openBoard(file);
  try {
    document = exportBoard(board);
    const subject = document.tables.item.find(row => row.item_id === 1);
    subject.item_status = 'open'; subject.item_owner = null; subject.item_lease_until = null;
    subject.item_verdict = JSON.stringify({ decision: 'REJECT', by: 'coordinator', at: new Date().toISOString(), commit: head, reason: 'BEHAVIOR_MISMATCH', note: 'Reviewed submitted ' + head });
    const rows = document.tables.event;
    const kinds = ['submit', 'reserve', 'reject', 'health-failure', 'health-resolved'];
    const base = Date.now() - 600_000;
    for (const [index, kind] of kinds.entries()) rows.push({ event_id: rows.at(-1).event_id + 1,
      event_at: new Date(base + index * 60_000).toISOString(), event_by: kind.startsWith('health') ? 'sentinel' : kind === 'submit' ? 'web-1' : 'coordinator',
      item_id: 1, event_kind: kind, event_detail: JSON.stringify({ commit: head, reason: 'BEHAVIOR_MISMATCH', note: 'Fixture review history', key: 'items-walk-fixture' }) });
    document.tables.sqlite_sequence.find(row => row.name === 'event').seq = rows.at(-1).event_id;
  } finally { store.closeBoard(board); }
  renameSync(file, join(demo.repo, '.git/pullboard/items-walk-original.sqlite'));
  // @pullboard-board-file journey: native import needs an empty destination, preserving the original private fixture.
  const restored = openBoard(file);
  try { importBoard(restored, document); } finally { store.closeBoard(restored); }
}

test('Items walk renders short context hashes, plain waiting chips and colored history in the person clock in Chrome [N26]', { timeout: 120_000 }, async () => { // budget: real native fixture, authenticated HTTP and desktop/phone Chrome.
  const box = machine(), demo = project(box, 'items-walk');
  for (const [title, extra] of [['History subject', []], ['Dependency', []], ['Waiting item', ['--after', '2']]])
    box.run(demo.repo, 'add', 'web', title, '--specs', 'G1', '--criterion', 'Render this private fixture.', ...extra);
  box.run(demo.web, 'claim', '1');
  const head = box.git(demo.repo, 'rev-parse', 'HEAD');
  box.run(demo.web, 'fact', '1', 'note', 'Keep this original note and full source ' + head + '.');
  seedHistory(box, demo, head);
  const server = await startView(box);
  let chrome;
  try {
    const executable = chromeExecutable(); assert.ok(executable, 'real Chrome is required');
    chrome = await openSnapshotChrome(executable, 'about:blank', join(box.dir, 'items-walk-chrome'));
    await chrome.send('Emulation.setTimezoneOverride', { timezoneId: 'America/Chicago' });
    const href = new URL(server.link.href); href.pathname = '/items/1';
    await chrome.send('Page.navigate', { url: href.href });
    await chrome.waitFor('view.item === 1 && document.querySelector("#detail .tl [data-timeline-kind=reject]")');
    for (const width of [1440, 375]) {
      await chrome.send('Emulation.setDeviceMetricsOverride', { width, height: 1000, deviceScaleFactor: 1, mobile: width < 500 });
      const actual = JSON.parse(await chrome.stable(`JSON.stringify((() => {
        const rows = [...document.querySelectorAll('#detail .tl > li')];
        const waiting = document.querySelector('#chain [data-item="3"]');
        const kinds = ['claim', 'reserve', 'reject', 'health-failure', 'note'];
        return { visible:document.querySelector('[data-pane=items]').innerText,
          waiting:waiting.querySelector('.chip').textContent, border:getComputedStyle(waiting).borderTopColor,
          link:waiting.querySelector('.chip [data-go]').dataset.go,
          kinds:kinds.map(kind => { const row = rows.find(row => row.dataset.timelineKind === kind), marker = row.querySelector('.tl-marker'), label = row.querySelector('.tl-kind');
            return {kind, icon:marker.innerHTML, color:getComputedStyle(marker).color, labelColor:getComputedStyle(label).color, label:label.textContent}; }),
          times:rows.map(row => row.querySelector('.tl-heading > time').textContent),
          copy:[...document.querySelectorAll('#detail .hash-copy')].map(node => [node.textContent,node.dataset.copy]) };
      })())`));
      assert.doesNotMatch(actual.visible, /\b[0-9a-f]{40}\b/u);
      assert.equal(actual.waiting, 'Waiting on #2'); assert.equal(actual.link, 'item:2');
      assert.ok(['rgba(0, 0, 0, 0)', 'transparent'].includes(actual.border), width + ': no warning outline');
      assert.equal(new Set(actual.kinds.map(row => row.icon)).size, 5, 'each native kind has its approved verb icon');
      assert.equal(new Set(actual.kinds.map(row => row.color)).size, 5, 'build/review/back/sentinel/note have distinct tones');
      for (const row of actual.kinds) assert.equal(row.labelColor, row.color, row.kind + ': kind label matches icon tone');
      assert.deepEqual(actual.kinds.map(row => row.label), ['build', 'review', 'sent back', 'sentinel', 'note']);
      assert.ok(actual.times.every(time => /\b(?:1[0-2]|[1-9]):\d{2}\s*[AP]M\b/u.test(time)), JSON.stringify(actual.times));
      assert.ok(actual.copy.some(([label, full]) => label === head.slice(0, 12) && full === head), 'full source remains available to copy');
    }
    assert.equal(await chrome.stable("document.querySelector('#chain [data-item=\"1\"] .meta .why').textContent"), 'Behavior did not match Reviewed submitted ' + head.slice(0, 12));
    assert.deepEqual(chrome.exceptions, []);
  } finally {
    if (chrome) await closeSnapshotChrome(chrome);
    await server.stop();
  }
});
