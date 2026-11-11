// pullboard: browser
/** @pullboard-test-gui */
/** Board automation remains visible as history and Needs, never as an agent seat [N26]. */
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { test } from 'node:test';
import * as store from '../../../../packages/store/index.js';
import {
  decideSentinel,
  sentinels,
} from '../../../../packages/sentinels/index.js';
import {
  boardOf,
  chromeExecutable,
  closeSnapshotChrome,
  earlier,
  machine,
  openSnapshotChrome,
  press,
  project,
  startView,
} from '../../tests/fixtures/cockpit/harness.js';

test('Rigor drafts and executed sentinels do not create agent rows or increase agent counts [N26]', { timeout: 90_000 }, async () => {
  const box = machine(), alpha = project(box, 'agents-board-actors');
  box.run(alpha.repo, 'add', 'web', 'Keep the real seat visible', '--specs', 'G1', '--route', 'strong',
    '--criterion', 'The real seat stays visible.', '--check', 'true', '--wait');
  box.run(alpha.web, 'claim', '1');
  const view = await startView(box);
  let chrome;
  try {
    assert.ok(chromeExecutable(), 'Chrome is required for both actual agent surfaces');
    chrome = await openSnapshotChrome(chromeExecutable(), view.link.href, join(box.dir, 'agents-board-actors-chrome'));
    // A board with no landing opens the first-run Dashboard (0de17112c6); set it aside so the usual cards are measured.
    await chrome.waitFor('!!data?.project');
    await chrome.stable("(() => { keep('pb.firstrun.' + view.root, 'hidden'); render(); return true; })()");
    await chrome.waitFor(`!!document.querySelector('#dashboard [data-dashboard-agent="web-1"]')`);
    const beforeFloor = await chrome.stable('Array.from(document.querySelectorAll("#dashboard [data-dashboard-agent]"), row => row.dataset.dashboardAgent)');
    const beforeHeadline = await chrome.stable('document.querySelector("#dashboard h1").textContent');
    earlier(alpha.repo, Date.now(), board => store.appendFact(board, 1, {
      agentId: 'coordinator', kind: 'root-cause', text: 'Keep board actors separate from seats.',
      cause: 'row:G1', neverAgain: true, asPerson: true, channel: 'terminal',
    }));
    box.run(alpha.repo, 'sentinel', 'propose', 'agent-count-watch', '--check', 'false', '--every', 'hourly', '--owner', 'coordinator');
    earlier(alpha.repo, Date.now(), board => {
      const row = sentinels(board).find(entry => entry.name === 'agent-count-watch');
      decideSentinel(board, { agentId: 'person', channel: 'terminal', name: row.name, digest: row.digest, decision: 'approve' });
    });
    box.run(alpha.repo, 'sentinel', 'run');
    const after = await boardOf(view, alpha.repo);
    earlier(alpha.repo, Date.now(), board => {
      const history = store.events(board);
      assert.ok(history.some(event => event.event_by === 'rigor' && event.event_kind === 'rigor-draft'), 'Rigor really recorded a native draft');
      assert.ok(history.some(event => event.event_by === 'sentinel' && event.event_kind === 'sentinel-failure'), 'the actual failed watch recorded its board actor');
      assert.equal(sentinels(board).find(row => row.name === 'agent-count-watch').lastRun.code, 1, 'the false command actually ran');
    });
    await chrome.waitFor('data.project.sequence >= ' + after.sequence);
    await chrome.waitFor('!document.querySelector("#dashboard").textContent.includes("Complete history is loading")');
    assert.deepEqual(await chrome.stable('Array.from(document.querySelectorAll("#dashboard [data-dashboard-agent]"), row => row.dataset.dashboardAgent)'), beforeFloor, 'automation cannot create Dashboard agent rows');
    assert.equal(await chrome.stable('document.querySelector("#dashboard h1").textContent'), beforeHeadline, 'the Dashboard agent count stays unchanged');
    for (const actor of ['rigor', 'sentinel']) assert.ok(!after.agents.some(agent => agent.agent_id === actor), actor + ' is not a joined API seat');
    await press(chrome, 'document.querySelector("[data-tab=shouts]")');
    await chrome.waitFor('view.tab === "shouts"');
    await chrome.stable('view.allAgents = true; view.open.idle = true; render(); true');
    assert.ok((await chrome.stable('Array.from(document.querySelectorAll("#agents [data-agent]"), row => row.dataset.agent)')).includes('web-1'), 'the real agent remains in the Agents panel');
    for (const actor of ['rigor', 'sentinel']) assert.equal(await chrome.stable(`!!document.querySelector('#agents [data-agent="${actor}"]')`), false, actor + ' is not an Agents panel row');
  } finally {
    if (chrome) await closeSnapshotChrome(chrome);
    await view.stop();
  }
});
