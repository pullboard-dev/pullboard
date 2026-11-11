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
    await chrome.waitFor('document.querySelectorAll("#activity [data-activity-kind=shout]").length >= 2');
    for (const width of [1280, 375]) {
      await chrome.send('Emulation.setDeviceMetricsOverride', { width, height: 900, deviceScaleFactor: 1, mobile: width < 700 });
      await chrome.waitFor('innerWidth === ' + width);
      const state = JSON.parse(await chrome.stable('JSON.stringify((() => { const rows=[...document.querySelectorAll("#activity [data-activity-kind=shout]")]; return { overflow:document.documentElement.scrollWidth>innerWidth, accent:getComputedStyle(document.querySelector("#activity [data-activity-kind=claim] .activity-verb")).backgroundColor, rows:rows.map(row=>{const q=row.querySelector(".activity-quote"),s=getComputedStyle(q),chip=row.querySelector(".activity-about");return {coordinator:row.querySelector(".activity-who").textContent==="The coordinator",sentence:row.querySelector(".activity-say p").textContent,text:q.textContent,clamp:s.webkitLineClamp,background:s.backgroundColor,padding:s.padding,color:s.color,height:q.getBoundingClientRect().height,lineHeight:parseFloat(s.lineHeight),chip:chip?.textContent??null,chipInSentence:!!chip?.closest("p"),chipColor:chip?getComputedStyle(chip).color:null,target:chip?.dataset.go??null,literalElements:q.querySelectorAll("word").length};})}; })())'));
      assert.equal(state.overflow, false, width + ': Activity has no horizontal overflow');
      const agent = state.rows.find(row => row.sentence.startsWith('web-1'));
      const coordinator = state.rows.find(row => row.coordinator);
      assert.ok(agent && coordinator, 'both native messages render');
      assert.match(agent.sentence, /asked the coordinator/u);
      for (const row of [agent, coordinator]) {
        assert.equal(row.chip, 'about #1');
        assert.equal(row.chipInSentence, true);
        assert.equal(row.target, 'item:1');
        assert.equal(row.literalElements, 0, 'literal agent markup never becomes an element');
        assert.ok(row.text.includes(words.trim()), 'the full native words remain in the DOM');
        const lines = row.coordinator ? 3 : 2;
        assert.equal(row.clamp, String(lines));
        const padding = row.coordinator ? 8 : 0;
        assert.ok(row.height <= row.lineHeight * lines + padding + 2, width + ': visible words stay within the approved line clamp: ' + JSON.stringify(row));
      }
      assert.equal(agent.background, 'rgba(0, 0, 0, 0)', 'agent words lose the grey box');
      assert.equal(agent.padding, '0px');
      assert.equal(coordinator.padding, '4px 8px', 'coordinator padding follows the approved mockup');
      assert.equal(coordinator.background, state.accent, 'coordinator words use the established accent-soft tint');
      assert.equal(agent.chipColor, agent.color, 'the related item chip keeps the muted text tone');
      assert.notEqual(coordinator.color, agent.color, 'agent words use the quieter text tone');
      assert.match(await chrome.stable('document.querySelector("#activity [data-activity-kind=claim]").textContent'), /started building.*#1/u);
      assert.equal(await chrome.stable('document.querySelector("#activity [data-activity-kind=claim] .activity-about")'), null, 'work rows retain their existing item presentation');
      const sentinel = 'document.querySelector("[data-activity-run=\\"sentinels:' + scan + '\\"]")';
      assert.equal(await chrome.stable(sentinel + '.open'), false, 'the native scan remains folded');
    }
    await press(chrome, 'document.querySelector("#activity .activity-about[data-go=\\"item:1\\"]")');
    await chrome.waitFor('view.tab === "items" && view.item === 1');
    assert.match(await chrome.stable('document.querySelector("#detail").textContent'), /A real Activity item/u);
    assert.deepEqual(chrome.exceptions, []);
  } finally {
    if (chrome) await closeSnapshotChrome(chrome);
    await view.stop();
  }
});
