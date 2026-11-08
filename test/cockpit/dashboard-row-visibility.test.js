// pullboard: browser
/** @pullboard-test-gui */
/** Native offscreen Dashboard rows remain complete and become visible on actual scrolling [N26]. */
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import * as store from '../../src/board.js';
import { openBoard } from '../../apps/lib/index.js';
import { chromeExecutable, closeSnapshotChrome, machine, openSnapshotChrome, press, project, startView } from './fixture.js';

test('Dashboard retains offscreen agents and paints their real rows when scrolled into view [N26]', { timeout: 90000 }, async () => {
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
    await chrome.waitFor(`view.tab === 'dashboard' && document.querySelectorAll('#dashboard [data-dashboard-agent]').length >= ${agents.length}`);
    for (const width of [1280, 375]) {
      await chrome.send('Emulation.setDeviceMetricsOverride', { width, height: 800, deviceScaleFactor: 1, mobile: false });
      for (const id of [agents.at(-1), agents[0]]) {
        const row = `document.querySelector('#dashboard [data-dashboard-agent="${id}"]')`;
        await chrome.stable(`${row}.scrollIntoView({block:'center',behavior:'instant'}); true`);
        await chrome.waitFor(`(() => { const row=${row}, box=row.getBoundingClientRect(), name=row.querySelector('b').getBoundingClientRect();
          return box.bottom>0 && box.top<innerHeight && name.width>0 && name.height>0; })()`);
        const actual = await chrome.stable(`(() => { const row=${row}; return {id:row.dataset.dashboardAgent,name:row.querySelector('b').textContent,
          svg:!!row.querySelector('svg[aria-label]'),numbers:row.querySelectorAll('.dash-agent-number').length}; })()`);
        assert.equal(actual.id, id); assert.ok(actual.name.includes(id));
        assert.equal(actual.svg, true); assert.equal(actual.numbers, 3);
      }
      for (const id of agents) assert.equal(await chrome.stable(`!!document.querySelector('#dashboard [data-dashboard-agent="${id}"]')`), true);
    }
    // Advance only the displayed observation clock: the same real shouts become quiet after twenty minutes.
    await chrome.stable(`data.project.observedAt = new Date(Date.now()+30*60_000).toISOString(); render(); true`);
    await chrome.waitFor(`!!document.querySelector('#dashboard [data-dashboard-disclosure="quiet"]')`);
    assert.equal(await chrome.stable(`document.querySelectorAll('#dashboard [data-dashboard-disclosure="quiet"] [data-dashboard-agent]').length`), 0,
      'closed quiet disclosure does not build offscreen rows');
    await press(chrome, `document.querySelector('#dashboard [data-dashboard-disclosure="quiet"] summary')`);
    await chrome.waitFor(`document.querySelectorAll('#dashboard [data-dashboard-disclosure="quiet"] [data-dashboard-agent]').length >= ${agents.length}`);
    for (const id of agents) {
      const row = `document.querySelector('#dashboard [data-dashboard-agent="${id}"]')`;
      assert.deepEqual(await chrome.stable(`({svg:!!${row}.querySelector('svg[aria-label]'),numbers:${row}.querySelectorAll('.dash-agent-number').length})`), {svg:true,numbers:3});
    }
    await chrome.stable(`data.project.agents.find(agent=>agent.agent_id===${JSON.stringify(agents[0])}).model='fresh quiet model'; render(); true`);
    assert.equal(await chrome.stable(`document.querySelector('#dashboard [data-dashboard-disclosure="quiet"]').open`), true);
    assert.ok((await chrome.stable(`document.querySelector('#dashboard [data-dashboard-agent="${agents[0]}"] b').title`)).includes('fresh quiet model'),
      'an open disclosure redraws from the current model');
  } finally {
    try { if (chrome) await closeSnapshotChrome(chrome); }
    finally { await view.stop(); rmSync(profile, { recursive: true, force: true }); }
  }
});
