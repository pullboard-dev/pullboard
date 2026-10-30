/** @pullboard-test-gui */
/** @pullboard-view-test journey
 * A private landed item is projected by the native API and compared field-for-field with the Dashboard in real Chrome. */
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { accept } from './fixture.js';
import { boardOf } from './fixture.js';
import { build } from './fixture.js';
import { chromeExecutable } from './fixture.js';
import { closeSnapshotChrome } from './fixture.js';
import { machine } from './fixture.js';
import { openSnapshotChrome } from './fixture.js';
import { pickProject } from './fixture.js';
import { project } from './fixture.js';
import { startView } from './fixture.js';

/** Compare native pipeline fields with the Dashboard rendered by a real private Chrome journey. */
async function pipelinePanelJourney() {
  const executable = chromeExecutable();
  assert.ok(executable, 'Chrome is required for the pipeline journey.');
  const box = machine();
  const alpha = project(box, 'dashboard-pipeline');
  box.run(alpha.repo, 'add', 'web', 'Pipeline fixture item', '--specs', 'G1',
    '--criterion', 'The native pipeline report is visible unchanged.', '--check', 'test -f pullboard.json', '--wait');
  build(box, alpha, 1, 'pipeline-fixture.txt');
  accept(box, alpha, 1);
  const mergeBranch = alpha.itemBranches.get(`${alpha.baseBranch}:1`);
  box.git(alpha.repo, 'merge', '--no-ff', '-m', 'chore: merge pipeline fixture', mergeBranch);
  const mergeCommit = box.git(alpha.repo, 'rev-parse', 'HEAD');
  box.run(alpha.repo, 'merged', '1', mergeCommit);

  const view = await startView(box);
  const profile = mkdtempSync(join(tmpdir(), 'pullboard-pipeline-panel-chrome-'));
  let chrome;
  try {
    chrome = await openSnapshotChrome(executable, view.link.href, profile);
    await chrome.waitFor('!!data?.project');
    await pickProject(chrome, `document.querySelector('[data-root=${JSON.stringify(alpha.repo)}]')`);
    await chrome.waitFor(`data?.project?.root === ${JSON.stringify(alpha.repo)}`);
    const state = await boardOf(view, alpha.repo);
    const expected = state.statsPipeline;
    assert.equal(expected.count, 1, 'the actual API reports the landed fixture item');
    assert.equal(expected.items[0].id, 1);
    await chrome.waitFor(`document.querySelectorAll('#dashboard [data-pipeline-item]').length === ${expected.count}`);
    const actual = JSON.parse(await chrome.stable(`JSON.stringify((() => {
      const card = document.querySelector('#dashboard [aria-label="Pipeline"]');
      return {
        item: [...card.querySelectorAll('[data-pipeline-item]')].map(item => ({
          id: Number(item.dataset.pipelineItem),
          stages: Object.fromEntries([...item.querySelectorAll('[data-pipeline-stage]')].map(stage => [stage.dataset.pipelineStage, JSON.parse(stage.dataset.value)])),
          retries: [...item.querySelectorAll('[data-pipeline-retry]')].map(row => row.dataset.pipelineRetry),
          gaps: [...item.querySelectorAll('.dash-pipeline-gaps li')].map(row => row.textContent.trim()),
        })),
        totals: Object.fromEntries([...card.querySelectorAll('[data-pipeline-total]')].map(row => [row.dataset.pipelineTotal, JSON.parse(row.dataset.value)])),
        causes: Object.fromEntries([...card.querySelectorAll('[data-pipeline-cause]')].map(row => [row.dataset.pipelineCause, JSON.parse(row.dataset.value)])),
        unknown: [...card.querySelectorAll('[data-pipeline-gap]')].map(row => row.textContent.trim()),
      };
    })())`));
    assert.deepEqual(actual.item, expected.items.map(entry => ({ id: entry.id, stages: entry.stages,
      retries: entry.retries.map(retry => retry.cause), gaps: entry.gaps.map(gap => `Unmeasured ${gap.stages.join(', ')}: ${gap.reason}`) })),
    'each landed item shows the native stage measurements, retries, and named gaps unchanged');
    assert.deepEqual(actual.totals, Object.fromEntries(Object.entries(expected.totals).map(([stage, value]) => [stage, value.measuredMs])),
      'stage totals are copied from the same API projection');
    assert.deepEqual(actual.causes, expected.causes, 'every retry or reopen cause total matches the native API');
    assert.ok(actual.unknown.some(row => row.includes(expected.unmeasuredGaps[0].kind)
      && row.includes(expected.unmeasuredGaps[0].reason)), 'unrecorded attempts stay explicitly named as unmeasured');
    assert.equal(await chrome.stable('document.querySelectorAll("#dashboard [data-pipeline-stage]").length'), 5,
      'all five native lifecycle stages are visible for the landed item');
    assert.deepEqual(chrome.exceptions, [], 'the Dashboard pipeline has no uncaught browser errors');
  } finally {
    if (chrome) await closeSnapshotChrome(chrome);
    await view.stop();
    rmSync(profile, { recursive: true, force: true });
  }
}

test('Dashboard pipeline values match the native API projection in Chrome [N26,R1]', { timeout: 90_000 }, pipelinePanelJourney);
