// pullboard: browser
/** @pullboard-test-gui */
/** Native offscreen Dashboard rows remain complete and become visible on actual scrolling [N26]. */
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
  chromeExecutable,
  closeSnapshotChrome,
  machine,
  openSnapshotChrome,
  press,
  project,
  startView,
} from '../../../tests/fixtures/cockpit/harness.js';

test('Dashboard keeps between-items agents behind one line and paints their real rows when opened and scrolled into view [N26]', { timeout: 90000 }, async () => {
  const executable = chromeExecutable();
  assert.ok(executable, 'Chrome is required for the native row visibility contract.');
  const box = machine(), alpha = project(box, 'dashboard-offscreen');
  // @pullboard-board-file journey: normal native registration and shouts seed the real HTTP projection.
  const board = openBoard(join(alpha.repo, '.git', 'pullboard', 'board.sqlite'));
  const agents = [];
  try {
    for (let index = 0; index < 48; index++) {
      const agent = store.register(board, { lane: 'web', path: join(box.dir, 'offscreen-seat-' + index), model: 'fixture', family: 'fixture' });
      store.shout(board, { from: agent, to: 'person', text: 'Which release should this native fixture observe?' });
      agents.push(agent);
    }
  } finally { store.closeBoard(board); }
  const view = await startView(box), profile = mkdtempSync(join(tmpdir(), 'pullboard-dashboard-rows-'));
  let chrome;
  try {
    chrome = await openSnapshotChrome(executable, view.link.href, profile);
    // A board with no landing opens the first-run Dashboard (0de17112c6); set it aside so the usual cards are measured.
    await chrome.waitFor('!!data?.project');
    await chrome.stable("(() => { keep('pb.firstrun.' + view.root, 'hidden'); render(); return true; })()");
    // The table lists the agents the notch counts (#6773). These seats only shouted, so the journey hands the notch's list
    // all of them, as the sentinel journeys hand the page its calls; at work and holding nothing, they are between items,
    // which the /live-style table keeps behind one line until it is opened (#6847).
    await chrome.stable(`(() => { globalThis.ownNavNumbers = navNumbers; navNumbers = p => ({ ...ownNavNumbers(p), agentIds: p.agents.filter(agent => agent.agent_id !== 'coordinator').map(agent => agent.agent_id) }); view.allAgents = !view.allAgents; render(); return true; })()`);
    await chrome.waitFor(`view.tab === 'dashboard' && !!document.querySelector('#dashboard [data-dashboard-quiet]')`);
    assert.equal(await chrome.stable(`document.querySelectorAll('#dashboard [data-dashboard-quiet-rows] [data-dashboard-agent]').length`), 0,
      'the closed between-items rows are not built offscreen');
    await press(chrome, `document.querySelector('#dashboard [data-dashboard-quiet]')`);
    await chrome.waitFor(`document.querySelectorAll('#dashboard [data-dashboard-quiet-rows]:not([hidden]) [data-dashboard-agent]').length >= ${agents.length}`);
    for (const width of [1280, 375]) {
      await chrome.send('Emulation.setDeviceMetricsOverride', { width, height: 800, deviceScaleFactor: 1, mobile: false });
      for (const id of [agents.at(-1), agents[0]]) {
        const row = `document.querySelector('#dashboard [data-dashboard-agent="${id}"]')`;
        await chrome.stable(`${row}.scrollIntoView({block:'center',behavior:'instant'}); true`);
        await chrome.waitFor(`(() => { const row=${row}, box=row.getBoundingClientRect(), name=row.querySelector('td.who').getBoundingClientRect();
          return box.bottom>0 && box.top<innerHeight && name.width>0 && name.height>0; })()`);
        const actual = await chrome.stable(`(() => { const row=${row}; return {id:row.dataset.dashboardAgent,name:row.querySelector('td.who').textContent,
          svg:!!row.querySelector('svg[aria-label]'),numbers:row.querySelectorAll('.dash-num').length}; })()`);
        assert.equal(actual.id, id); assert.ok(actual.name.includes(id));
        assert.equal(actual.svg, true); assert.equal(actual.numbers, 4);
      }
      for (const id of agents) assert.equal(await chrome.stable(`!!document.querySelector('#dashboard [data-dashboard-agent="${id}"]')`), true);
    }
    // The opened rows stay open across a live redraw and draw from the current model.
    await chrome.stable(`data.project.agents.find(agent=>agent.agent_id===${JSON.stringify(agents[0])}).model='fresh model'; render(); true`);
    assert.equal(await chrome.stable(`document.querySelector('#dashboard [data-dashboard-quiet-rows]').hidden`), false);
    assert.ok((await chrome.stable(`document.querySelector('#dashboard [data-dashboard-agent="${agents[0]}"] td.who').title`)).includes('fresh model'),
      'an open table redraws from the current model');
    // Back on the notch's own list, which counts no seat that holds nothing, the seats leave the table.
    await chrome.stable(`(() => { navNumbers = ownNavNumbers; view.allAgents = !view.allAgents; render(); return true; })()`);
    await chrome.waitFor(`!document.querySelector('#dashboard [data-dashboard-agent]')`);
  } finally {
    try { if (chrome) await closeSnapshotChrome(chrome); }
    finally { await view.stop(); rmSync(profile, { recursive: true, force: true }); }
  }
});
