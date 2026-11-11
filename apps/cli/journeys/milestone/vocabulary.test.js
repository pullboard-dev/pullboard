// pullboard: browser
/** @pullboard-test-gui */
/** @pullboard-view-test journey
 * Real native lifecycle states are presented with one stage vocabulary across the item screens in Chrome.
 */
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import * as store from '../../../../packages/store/index.js';
import { openBoard } from '../../../lib/index.js';
import { accept } from '../../tests/fixtures/cockpit/harness.js';
import { build } from '../../tests/fixtures/cockpit/harness.js';
import { chromeExecutable } from '../../tests/fixtures/cockpit/harness.js';
import { closeSnapshotChrome } from '../../tests/fixtures/cockpit/harness.js';
import { machine } from '../../tests/fixtures/cockpit/harness.js';
import { openSnapshotChrome } from '../../tests/fixtures/cockpit/harness.js';
import { pickProject } from '../../tests/fixtures/cockpit/harness.js';
import { project } from '../../tests/fixtures/cockpit/harness.js';
import { press } from '../../tests/fixtures/cockpit/harness.js';
import { searchFor } from '../../tests/fixtures/cockpit/harness.js';
import { sendBack } from '../../tests/fixtures/cockpit/harness.js';
import { startView } from '../../tests/fixtures/cockpit/harness.js';

/** Prove stage words, detail lines and state marks through an authenticated native board and real Chrome. */
test('every screen shows an item\'s stage from the seven approved words, in order, with marks beside them [N28]', { timeout: 180_000 }, async () => {
  const executable = chromeExecutable();
  assert.ok(executable, 'Chrome is required for the stage vocabulary journey.');
  const box = machine();
  const alpha = project(box, 'stage-vocabulary', undefined, {
    lanes: { web: { owns: ['web/'], specs: ['G'] }, docs: { owns: ['docs/'], specs: ['G'] }, tests: { owns: [], specs: ['G'] } },
  });
  const titles = ['Ready work', 'Gated dependency', 'Building work', 'Review work', 'Active landing', 'Merged work',
    'Verified work', 'Held item', 'Held lane', 'Sent back work', 'Withdrawn work'];
  for (const [index, title] of titles.entries()) {
    const lane = index === 8 ? 'docs' : 'web';
    const after = index === 1 ? ['--after', '1'] : [];
    box.run(alpha.repo, 'add', lane, title, '--specs', 'G1', '--criterion', 'Stage words stay consistent.', ...after);
  }
  build(box, alpha, 4, 'review.txt');
  build(box, alpha, 5, 'landing.txt');
  accept(box, alpha, 5);
  build(box, alpha, 6, 'merged.txt');
  accept(box, alpha, 6);
  const mergeBranch = alpha.itemBranches.get(`${alpha.baseBranch}:6`);
  box.git(alpha.repo, 'merge', '--no-ff', '-m', 'chore: merge stage fixture', mergeBranch);
  box.run(alpha.repo, 'merged', '6', box.git(alpha.repo, 'rev-parse', 'HEAD'));
  build(box, alpha, 7, 'verified.txt');
  accept(box, alpha, 7);
  box.run(alpha.repo, 'hold', '8', 'Waiting for a supplier answer.');
  box.run(alpha.repo, 'hold', 'docs', '--reason', 'The docs lane waits for copy.');
  build(box, alpha, 10, 'returned.txt');
  sendBack(box, alpha, 10, 'The first draft needs a clear label.');
  box.run(alpha.web, 'claim', '11');
  box.run(alpha.repo, 'withdraw', '11', 'The feature is no longer needed.');
  box.run(alpha.web, 'claim', '3');
  box.run(alpha.repo, 'milestone', 'add', 'Stage list', '--items', '1,2,3,4,5,6,7,8,9,10,11', '--reason', 'stage fixture');
  const reviewer = join(box.dir, 'stage-vocabulary-reviewer');
  box.git(alpha.repo, 'worktree', 'add', '-q', '-b', 'tests/stage-vocabulary-reviewer', reviewer, 'main');
  box.run(reviewer, 'join', 'tests', '--model', 'Stage reviewer');
  // @pullboard-board-file journey: the authenticated Chrome view reads this persisted fixture board over HTTP.
  const board = openBoard(join(alpha.repo, '.git/pullboard/board.sqlite'));
  try {
    store.reserveReview(board, 4, { agentId: 'tests-1', leaseMs: 24 * 60 * 60_000, policy: 'any' });
    const startedAt = '2026-10-30T07:30:00.000Z';
    store.logEvent(board, 'coordinator', 'landing_batch', null, { batch: {
      version: 1, id: 'stage-vocabulary-active-batch', state: 'gating', items: [{ id: 5 }], startedAt,
    } });
  } finally { store.closeBoard(board); }
  const view = await startView(box);
  const profile = mkdtempSync(join(box.dir, 'stage-vocabulary-chrome-'));
  let chrome;
  try {
    chrome = await openSnapshotChrome(executable, view.link.href, profile);
    await chrome.waitFor('!!data?.project');
    await pickProject(chrome, `document.querySelector('[data-root=${JSON.stringify(alpha.repo)}]')`);
    await chrome.waitFor(`data?.project?.root === ${JSON.stringify(alpha.repo)}`);
    await press(chrome, "document.querySelector('[data-tab=items]')");
    await chrome.waitFor("!document.querySelector('[data-pane=items]').hidden");
    await press(chrome, "document.querySelector('[data-filter-toggle]')");
    await press(chrome, "document.querySelector('[data-state=all]')");
    await chrome.waitFor("document.querySelector('#chain [data-item=\\\"10\\\"] .item-stage')");
    await chrome.stable(`(() => { const item = data.project.items.find(entry => entry.id === 7); item.verdictState = { code: 'STALE_VERDICT', file: 'web/verified.txt', commit: 'a'.repeat(40), main: 'b'.repeat(40) }; render(); return true; })()`);
    const list = JSON.parse(await chrome.stable(`JSON.stringify(Object.fromEntries([...document.querySelectorAll('#chain [data-item]')].map(row => [row.dataset.item,
      { key: row.querySelector('.item-stage')?.dataset.stage, stage: row.querySelector('.stage-word')?.textContent || row.querySelector('.item-seat')?.getAttribute('aria-label')?.split(': ')[0], seat: row.querySelector('.item-seat')?.textContent.trim(), seatHover: row.querySelector('.item-seat')?.title, seatAccessible: row.querySelector('.item-seat')?.getAttribute('aria-label'), detail: row.querySelector('.stage-detail')?.textContent,
        accessible: row.querySelector('.item-stage')?.getAttribute('aria-label'), hover: row.querySelector('.item-stage')?.title,
        marks: [...row.querySelectorAll('.stage-marks > *')].map(mark => mark.textContent.trim()),
        reasons: [...row.querySelectorAll('.stage-marks > *')].map(mark => mark.getAttribute('title') || mark.getAttribute('aria-label') || '') }])) )`));
    assert.deepEqual(list['1'].stage, 'Ready');
    for (const entry of Object.values(list)) { assert.ok(entry.accessible.includes(entry.stage) && entry.accessible.includes(entry.detail)); assert.equal(entry.hover, entry.detail, 'compact rows keep the full native detail available on hover'); }
    assert.match(list['1'].detail, /strong route/u);
    assert.deepEqual(list['2'].stage, 'Gated');
    assert.match(list['2'].detail, /#1/u);
    assert.deepEqual(list['3'].stage, 'Building');
    assert.equal(list['3'].seat, 'web-1', 'the held row keeps the approved visible seat name');
    assert.match(list['3'].seatAccessible, /^Building:/u);
    assert.match(list['3'].seatHover, /Building:/u);
    assert.match(list['4'].seatAccessible, /^In review:/u);
    assert.match(list['4'].seatHover, /In review:/u);
    assert.match(list['3'].detail, /by web-1/u);
    assert.deepEqual(list['4'].stage, 'In review');
    assert.equal(list['4'].key, 'in-review', 'the browser uses the same stage address as the Pipeline');
    assert.match(list['4'].detail, /verifying/u);
    assert.deepEqual(list['5'].stage, 'Landing');
    assert.match(list['5'].detail, /batch/u);
    assert.doesNotMatch(list['5'].detail, /\d{4}-\d{2}-\d{2}T/u, 'landing details are readable clock labels');
    assert.deepEqual(list['6'].stage, 'Merged');
    assert.equal(list['6'].detail, 'landed');
    assert.deepEqual(list['7'].stage, 'Verified');
    assert.equal(list['7'].detail, 'queued for the train');
    assert.ok(list['7'].marks.includes('stale'));
    assert.ok(list['7'].reasons.some(reason => /main changed/u.test(reason)), 'the Stale mark explains the changed main on hover');
    assert.deepEqual(list['8'].stage, 'Gated');
    assert.ok(list['8'].marks.includes('Held'));
    assert.ok(list['8'].reasons.some(reason => /supplier answer/u.test(reason)), 'the Held mark explains its reason on hover');
    assert.deepEqual(list['9'].stage, 'Gated');
    assert.ok(list['9'].marks.includes('Lane held'));
    assert.ok(list['9'].reasons.some(reason => /waits for copy/u.test(reason)), 'the Lane held mark explains its reason on hover');
    assert.deepEqual(list['10'].stage, 'Ready');
    assert.ok(list['10'].marks.includes('Sent back'));
    assert.ok(list['10'].reasons.some(reason => /clear label/u.test(reason)), 'the Sent back mark explains the reason on hover');
    await searchFor(chrome, 'Withdrawn work', 15_000);
    await chrome.waitFor("!!document.querySelector('#find-results [data-find=\\\"item:11\\\"]')");
    await press(chrome, "document.querySelector('#find-results [data-find=\\\"item:11\\\"]')");
    await chrome.waitFor("view.tab === 'items' && view.item === 11 && !document.querySelector('#detail [aria-busy]') && !!document.querySelector('#detail .item-stage')");
    const withdrawn = JSON.parse(await chrome.stable(`JSON.stringify({ stage: document.querySelector('#detail .item-stage')?.dataset.stage,
        word: document.querySelector('#detail .stage-word')?.textContent,
        marks: [...document.querySelectorAll('#detail .stage-marks > *')].map(mark => mark.textContent.trim()),
        reason: document.querySelector('#detail .stage-mark')?.title })`));
    assert.deepEqual(withdrawn.stage, 'building');
    assert.equal(withdrawn.word, 'Building');
    assert.ok(withdrawn.marks.includes('Withdrawn'));
    assert.match(withdrawn.reason, /feature is no longer needed/u);
    await chrome.stable("(() => { const q = document.querySelector('#q'); q.value = ''; q.dispatchEvent(new Event('input', { bubbles: true })); q.blur(); })()");
    await press(chrome, "document.querySelector('[data-items-view=pipeline]')");
    await chrome.waitFor("!document.querySelector('#pipeline').hidden && document.querySelector('#pipeline [data-stage=landing]')");
    const pipelineOrder = JSON.parse(await chrome.stable("JSON.stringify([...document.querySelectorAll('#pipeline [data-pipeline-stage]')].map(stage => stage.querySelector('h2').textContent))"));
    assert.deepEqual(pipelineOrder, ['Gated', 'Ready', 'Building', 'In review', 'Verified', 'Landing', 'Merged']);
    const pipelineStage = await chrome.stable("document.querySelector('#pipeline [data-item=\\\"5\\\"] .stage-word')?.textContent");
    assert.equal(pipelineStage, 'Landing');
    await press(chrome, "document.querySelector('[data-tab=roadmap]')");
    await chrome.waitFor("!document.querySelector('[data-pane=roadmap]').hidden && document.querySelector('#roadmap-list [data-roadmap-key=\\\"i:#5\\\"] .stage-word')");
    const roadmapStages = await chrome.stable(`JSON.stringify({ landing: document.querySelector('#roadmap-list [data-roadmap-key="i:#5"] .stage-word')?.textContent,
      hidden: !document.querySelector('#roadmap-list [data-roadmap-key="i:#11"]') })`);
    assert.deepEqual(JSON.parse(roadmapStages), { landing: 'Landing', hidden: true }, 'Roadmap uses the same stage and continues hiding withdrawn rows');
    await press(chrome, "document.querySelector('[data-tab=dashboard]')");
    await chrome.waitFor("!document.querySelector('[data-pane=dashboard]').hidden && document.querySelector('#dashboard [data-go=\\\"item:5\\\"] .stage-word')");
    const dashboardStages = JSON.parse(await chrome.stable(`JSON.stringify({ landing: document.querySelector('#dashboard [data-go="item:5"] .stage-word')?.textContent,
      landingDetail: document.querySelector('#dashboard [data-go="item:5"] .stage-detail')?.textContent,
      verified: document.querySelector('#dashboard [data-go="item:7"] .stage-word')?.textContent,
      reviewKey: document.querySelector('#dashboard [data-go="item:4"] .item-stage')?.dataset.stage })`));
    assert.deepEqual(dashboardStages, { landing: 'Landing', landingDetail: list['5'].detail, verified: 'Verified', reviewKey: 'in-review' }, 'Dashboard shares the readable landing-batch detail used by the Items screen');
    assert.doesNotMatch(dashboardStages.landingDetail, /\d{4}-\d{2}-\d{2}T/u, 'Dashboard never exposes a raw ISO batch timestamp');
    assert.deepEqual(chrome.exceptions, [], 'stage screens have no uncaught browser errors');
  } finally {
    if (chrome) await closeSnapshotChrome(chrome);
    await view.stop();
    rmSync(profile, { recursive: true, force: true });
  }
});
