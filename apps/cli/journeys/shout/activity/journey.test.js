// pullboard: browser
/** @pullboard-test-gui */
/** @pullboard-test-journey Native Activity recording, HTTP state and Chrome interactions [N26,C7]. */
import assert from 'node:assert/strict';
import {
  mkdtempSync,
  rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import * as store from '../../../../../packages/store/index.js';
import { openBoard } from '../../../../lib/index.js';
import {
  applyRelayMove,
  appliedSequence,
  prepareEngineMove,
} from '../../../../../packages/state/index.js';
import {
  machine,
  project,
  startView,
  chromeExecutable,
  openSnapshotChrome,
  closeSnapshotChrome,
  press,
  proofShot,
} from '../../../tests/fixtures/cockpit/harness.js';

import {
  items,
  scannedBoard,
} from '../../../tests/fixtures/cockpit/activity.js';

test('real board Activity has sentence rows, working filters, full quotes and an ellipsized item on desktop and phone [N26]', { timeout: 120_000 }, async () => {
  const executable = chromeExecutable();
  assert.ok(executable, 'Chrome is required for the Activity sentence journey.');
  const box = machine(), alpha = project(box, 'sentences');
  box.run(alpha.repo, 'add', 'web', items[0].title, '--specs', 'G1', '--criterion', 'greets');
  box.run(alpha.web, 'claim', '1');
  box.run(alpha.web, 'shout', 'coordinator', 'Keep [MY_CODE] and these words.\nSecond line at 2026-10-28T04:12:00Z', '--kind', 'idea');
  const file = join(alpha.repo, '.git', 'pullboard', 'board.sqlite');
  // @pullboard-board-file journey: native health scans must reach this real view through its HTTP board snapshot.
  const board = openBoard(file);
  let scanId;
  try {
    const rank = { ...scannedBoard().finding, owner: { who: 'web-1', role: 'agent' }, why: 'web-1 claimed #1 while #2 ranks ahead in the web lane and sits free' };
    const waiting = { ...rank, key: 'AFTER_WITHDRAWN:item:1', cause: 'AFTER_WITHDRAWN', why: '#1 waits on withdrawn #2', next: 'drop the withdrawn dependency' };
    const idle = { ...rank, key: 'IDLE_AGENT:agent:web-1', cause: 'IDLE_AGENT', subject: 'web-1', item: null,
      why: 'web-1 has held no claim or review and pulled nothing for 30 minutes, while #2 waits in web and it could take it' };
    for (const findings of [[rank, waiting], [waiting, idle]]) {
      const args = { agentId: 'coordinator', findings, observedRevision: store.events(board).at(-1).event_id };
      const move = prepareEngineMove(board, 'recordHealthFindings', [args], { actor: 'coordinator' });
      const result = applyRelayMove(board, move, { sequence: appliedSequence(board) + 1, at: new Date().toISOString(), kind: 'move', sender: { kind: 'agent', agent: 'coordinator', userId: 'fixture-user' } });
      assert.equal(result.error, undefined, JSON.stringify(result));
    }
    scanId = store.events(board).findLast(entry => entry.event_kind === 'health-scan').event_id;
    assert.equal(store.allShouts(board).filter(entry => entry.shout_text.startsWith('Stuck:') && entry.shout_text.includes('[RANK_INVERSION]')).length, 2, 'native recording really sends the same notice to agent and coordinator');
  } finally { store.closeBoard(board); }
  const view = await startView(box), profile = mkdtempSync(join(tmpdir(), 'pullboard-activity-sentences-'));
  let chrome;
  assert.ok(scanId, 'the native health scan was recorded');
  try {
    chrome = await openSnapshotChrome(executable, view.link.href, profile);
    await chrome.waitFor('data?.project?.root === ' + JSON.stringify(alpha.repo));
    await press(chrome, 'document.querySelector("#tabs [data-tab=activity]")');
    // The redesigned Activity (#6916) draws one two-line act-row per lifecycle event, shout and Sentinel past-limit notice.
    // No equivalent in it: the health-scan run list (a scan's findings stay on the Shouts pane), the seat's model hover, the
    // work/sentinels/shouts filter counts matched to row counts (the strip's counts are for the whole window, rows page by ten).
    await chrome.waitFor('!!document.querySelector("#activity .act-row[data-row=\\"1\\"]")');
    const claim = 'document.querySelector("#activity .act-row[data-row=\\"1\\"] .fa")';
    assert.match(await chrome.stable(claim + '.textContent'), /claimed by web-1/u);
    assert.equal(await chrome.stable('document.querySelector("#activity .act-row[data-row=\\"1\\"] .act-chip").textContent'), 'Building');
    assert.doesNotMatch(await chrome.stable('document.querySelector("#activity").textContent'), /\(unknown\)/u);
    assert.equal(await chrome.stable('document.querySelectorAll("#activity [data-activity-kind], #activity .activity-event").length'), 0, 'the retired row markup is gone');
    for (const filter of ['shout', 'all']) {
      await press(chrome, 'document.querySelector("[data-page-ctl=activity][data-value=' + filter + ']")');
      await chrome.waitFor('document.querySelector("[data-page-ctl=activity][data-value=' + filter + ']").getAttribute("aria-pressed") === "true"');
      const chips = JSON.parse(await chrome.stable('JSON.stringify([...document.querySelectorAll("#activity .act-row .act-chip")].map(node => node.textContent))'));
      assert.ok(chips.length > 0, `${filter}: the open hour lists rows`);
      if (filter === 'shout') assert.ok(chips.every(chip => chip === 'Shout'), 'the Shouts filter keeps only shout rows: ' + JSON.stringify(chips));
      else assert.ok(chips.includes('Building') && chips.includes('Shout'), 'All shows building and shout rows: ' + JSON.stringify(chips));
    }
    for (const width of [1440, 375]) {
      await chrome.send('Emulation.setDeviceMetricsOverride', { width, height: 900, deviceScaleFactor: 1, mobile: width < 700 });
      await chrome.waitFor('innerWidth === ' + width);
      assert.equal(await chrome.stable('document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1'), true);
      assert.equal(await chrome.stable('getComputedStyle(document.querySelector("#activity .act-row .ph")).textOverflow'), 'ellipsis');
      const quote = await chrome.stable('[...document.querySelectorAll("#activity .act-row .ph")].map(node => node.textContent).find(text => text.includes("MY_CODE"))');
      // The page quotes a shout's own words exactly, a time in them included.
      assert.match(quote, /“Keep \[MY_CODE\] and these words\.\nSecond line at 2026-10-28T04:12:00Z”/u);
      await proofShot(chrome, 'activity-sentences', width);
    }
    await press(chrome, 'document.querySelector("#activity .act-row[data-row=\\"1\\"]")');
    await chrome.waitFor('!!document.querySelector("#activity svg[aria-label=\\"Journey of #1\\"]")');
    assert.deepEqual(chrome.exceptions, [], 'opening an item from its Activity row throws nothing');
  } finally {
    if (chrome) await closeSnapshotChrome(chrome);
    rmSync(profile, { recursive: true, force: true });
    await view.stop();
  }
});
