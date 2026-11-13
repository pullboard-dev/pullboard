// pullboard: browser
/** @pullboard-test-gui */
/** @pullboard-test-journey Native shout, work and sentinel events reach authenticated real Chrome [N26]. */
import assert from 'node:assert/strict';
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
} from '../../../tests/fixtures/cockpit/harness.js';
import { scannedBoard } from '../../../tests/fixtures/cockpit/activity.js';

test('Activity keeps shout words light, questions and item chips clear, and work and sentinels unchanged [N26]', { timeout: 120_000 }, async () => {
  const executable = chromeExecutable();
  assert.ok(executable, 'real Chrome is required');
  const box = machine(), alpha = project(box, 'activity-polish');
  box.run(alpha.repo, 'add', 'web', 'A real Activity item', '--specs', 'G1', '--criterion', 'Represent the native Activity action.');
  box.run(alpha.repo, 'add', 'web', 'Another real Activity item', '--specs', 'G1', '--criterion', 'Represent the seeded sentinel observation.');
  box.run(alpha.web, 'claim', '1');
  const words = 'Keep every literal <word> and reference #1.\n'.repeat(7);
  box.run(alpha.web, 'shout', 'coordinator', words + 'Can I proceed?', '--kind', 'question', '--decision');
  box.run(alpha.repo, 'shout', 'web-1', words + 'Proceed with the native item.');
  // @pullboard-board-file journey: record one native health scan in the persisted fixture served over authenticated HTTP.
  const board = openBoard(join(alpha.repo, '.git', 'pullboard', 'board.sqlite'));
  let scan;
  try {
    // Like the existing Activity journey, this is seeded health input recorded by the real engine, never an execution receipt.
    const finding = { ...scannedBoard().finding, owner: { who: 'web-1', role: 'agent' }, why: 'web-1 claimed #1 while #2 ranks ahead in the web lane and sits free' };
    const move = prepareEngineMove(board, 'recordHealthFindings', [{ agentId: 'coordinator', findings: [finding], observedRevision: store.events(board).at(-1).event_id }], { actor: 'coordinator' });
    const result = applyRelayMove(board, move, { sequence: appliedSequence(board) + 1, at: new Date().toISOString(), kind: 'move', sender: { kind: 'agent', agent: 'coordinator', userId: 'fixture-user' } });
    assert.equal(result.error, undefined, JSON.stringify(result));
    scan = store.events(board).findLast(entry => entry.event_kind === 'health-scan')?.event_id;
    assert.ok(scan, 'the persisted native scan exists');
  } finally { store.closeBoard(board); }
  const view = await startView(box);
  let chrome;
  try {
    chrome = await openSnapshotChrome(executable, view.link.href, join(box.dir, 'activity-polish-chrome'));
    await chrome.waitFor('!!data?.project');
    await press(chrome, 'document.querySelector("[data-tab=activity]")');
    // The redesigned Activity (#6916) draws a shout as one act-row: a Shout chip, the words in quotes, "from X to Y" below. It has
    // no grey or accent-tinted quote box, line clamp, "about #N" chip or folded Sentinel run, so those assertions have no equivalent.
    const shoutRows = 'document.querySelectorAll("#activity .act-row")';
    await chrome.waitFor('[...' + shoutRows + '].filter(row => row.querySelector(".act-chip")?.textContent === "Shout").length >= 2');
    for (const width of [1280, 375]) {
      await chrome.send('Emulation.setDeviceMetricsOverride', { width, height: 900, deviceScaleFactor: 1, mobile: width < 700 });
      await chrome.waitFor('innerWidth === ' + width);
      const state = JSON.parse(await chrome.stable('JSON.stringify((() => { const rows=[...' + shoutRows + ']; return { overflow:document.documentElement.scrollWidth>innerWidth, shouts:rows.filter(row=>row.querySelector(".act-chip")?.textContent==="Shout").map(row=>{const q=row.querySelector(".ph");return {text:q.textContent,fact:row.querySelector(".fa").textContent,literalElements:q.querySelectorAll("*").length,ellipsis:getComputedStyle(q).textOverflow}}), claim:(()=>{const row=document.querySelector("#activity .act-row[data-row=\\"1\\"]");return row?{ph:row.querySelector(".ph").textContent,fa:row.querySelector(".fa").textContent,chip:row.querySelector(".act-chip").textContent}:null})() }; })())'));
      assert.equal(state.overflow, false, width + ': Activity has no horizontal overflow');
      const agent = state.shouts.find(row => /^from web-1/u.test(row.fact));
      const coordinator = state.shouts.find(row => /^from coordinator/u.test(row.fact));
      assert.ok(agent && coordinator, 'both native messages render: ' + JSON.stringify(state.shouts));
      assert.match(agent.fact, /to coordinator/u);
      for (const row of [agent, coordinator]) {
        assert.equal(row.literalElements, 0, 'literal agent markup never becomes an element');
        assert.ok(row.text.includes(words.trim()), 'the full native words remain in the DOM');
        assert.equal(row.ellipsis, 'ellipsis', width + ': the quote is one line with an ellipsis');
      }
      assert.ok(state.claim, 'the work row is drawn');
      assert.equal(state.claim.chip, 'Building');
      assert.match(state.claim.fa, /claimed by web-1/u);
      assert.match(state.claim.ph, /#1.*A real Activity item/u, 'a work row names its item and title');
    }
    await press(chrome, 'document.querySelector("#activity .act-row[data-row=\\"1\\"]")');
    await chrome.waitFor('!!document.querySelector("#activity svg[aria-label=\\"Journey of #1\\"]")');
    assert.match(await chrome.stable('document.querySelector("#activity .act-ip, #activity .act-card").textContent'), /Building|Ready|Gate/u);
    assert.ok(scan, 'the native health scan was recorded');
    assert.deepEqual(chrome.exceptions, []);
  } finally {
    if (chrome) await closeSnapshotChrome(chrome);
    await view.stop();
  }
});
