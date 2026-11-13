// pullboard: browser
import { test } from 'node:test';
import { privateFixtureFiles } from '../../../tests/fixtures/child.js';
import { roadmapStagesBoard } from '../../../tests/fixtures/cockpit/roadmap-stages.js';
import { startView } from '../../../tests/fixtures/cockpit/harness.js';
import { chromeExecutable } from '../../../tests/fixtures/cockpit/harness.js';
import { closeSnapshotChrome } from '../../../tests/fixtures/cockpit/harness.js';
import { settled } from '../../../tests/fixtures/cockpit/harness.js';
import { openRoadmapChrome } from '../../../tests/fixtures/cockpit/roadmap.js';
test('probe queue order [N26]', { timeout: 140_000 }, async () => {
  const { box } = await roadmapStagesBoard(() => {});
  const view = await startView(box);
  let chrome;
  try {
    chrome = await openRoadmapChrome(chromeExecutable(), new URL('/roadmap-demo/roadmap' + view.link.search, view.link).href, privateFixtureFiles('probe-').root);
    await settled(chrome, "!!data?.project && document.querySelectorAll('#roadmap .milestone').length === 3");
    console.log('PROBE-PAGE ' + await chrome.stable(`JSON.stringify({ api: data.project.milestones.map(m => [m.name, m.items.map(i => [i.id, i.position])]), dom: [...document.querySelectorAll('#roadmap .milestone-item')].map(r => [r.querySelector('.id')?.textContent, r.querySelector('.queue-position')?.textContent]) })`));
  } finally { if (chrome) await closeSnapshotChrome(chrome); await view.stop(); }
});
