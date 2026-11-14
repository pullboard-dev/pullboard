// pullboard: browser
/** @pullboard-test-input apps/view/src/io/serve.js apps/view/src/io/main.css apps/view/src/io/item/panel.css apps/view/src/io/page/render.js apps/view/src/io/page/connect.js apps/view/src/io/page/actions.js apps/view/src/logic/timeline/render.js */
/** @pullboard-test-gui */
/** Approved item-panel presentation over native item, verdict, baseline and history records [N26,B23]. */
import assert from 'node:assert/strict';
import { appendFileSync } from 'node:fs';
import { mkdirSync } from 'node:fs';
import { mkdtempSync } from 'node:fs';
import { rmSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { addItem } from '../../../../../packages/store/index.js';
import { closeBoard } from '../../../../../packages/store/index.js';
import { openBoard } from '../../../../lib/index.js';
import { machine } from '../../../tests/fixtures/cockpit/harness.js';
import { project } from '../../../tests/fixtures/cockpit/harness.js';
import { build } from '../../../tests/fixtures/cockpit/harness.js';
import { startView } from '../../../tests/fixtures/cockpit/harness.js';
import { boardOf } from '../../../tests/fixtures/cockpit/harness.js';
import { chromeExecutable } from '../../../tests/fixtures/cockpit/harness.js';
import { openSnapshotChrome } from '../../../tests/fixtures/cockpit/harness.js';
import { closeSnapshotChrome } from '../../../tests/fixtures/cockpit/harness.js';
import { press } from '../../../tests/fixtures/cockpit/harness.js';

/** Add two private items with recorded, distinct check commands and native baseline observations. */
function seedPanelItems(box, demo) {
  // @pullboard-board-file journey: native item and baseline records feed the persisted board served to Chrome over HTTP.
  const board = openBoard(join(demo.repo, '.git', 'pullboard', 'board.sqlite'));
  try {
    const main = box.git(demo.repo, 'rev-parse', 'HEAD');
    /** Build explicit test-name observations for the seeded standard-check baseline. */
    const evidence = (failed, passed) => ({ failed, passed, noTestsMatched: false });
    const sharedBrief = 'Files:\n- web/item-panel.js\n- apps/cli/journeys/verify/item/panel.test.js\nTest:\n- apps/cli/journeys/verify/item/panel.test.js checks the item panel.';
    const standardCheck = 'node packages/gate/src/io/run/tests.js apps/cli/journeys/verify/item/panel.test.js';
    const namedCase = 'the item panel presents native verdicts, checks, files and newest-first history at desktop and phone widths [N26,B23]';
    const id = addItem(board, { by: 'coordinator', lane: 'web', title: 'Long item panel fixture', route: 'strong',
      specIds: ['G1'], criterion: Array.from({ length: 8 }, (_, index) => `When the panel renders, the complete approved condition ${index + 1} remains readable and available.`).join(' '),
      brief: sharedBrief, check: standardCheck,
      checkBaseline: { command: standardCheck, main, result: 'red', seconds: 3, testEvidence: evidence([namedCase], []) } });
    const secondCheck = 'node --check web/other.js';
    addItem(board, { by: 'coordinator', lane: 'web', title: 'Non-standard check fixture', route: 'strong', specIds: ['G1'],
      criterion: 'The recorded non-standard command remains visible.',
      brief: 'Files:\n- web/other.js\n- apps/cli/journeys/verify/item/panel.test.js\nTest:\n- apps/cli/journeys/verify/item/panel.test.js inspects this command.',
      check: secondCheck,
      checkBaseline: { command: secondCheck, main, result: 'green', seconds: 1, testEvidence: evidence([], ['node --check web/other.js']) } });
    return id;
  } finally {
    closeBoard(board);
  }
}

test('the item panel presents native verdicts, checks, files and newest-first history at desktop and phone widths [N26,B23]', { timeout: 300_000 }, async () => {
  const executable = chromeExecutable();
  assert.ok(executable, 'The frozen item-panel journey requires real Chrome.');
  // The seeded check names two files outside web/, so the lane owns them for claim to accept the bar [C7].
  const owned = ['web/', 'packages/gate/src/io/run/tests.js', 'apps/cli/journeys/verify/item/panel.test.js'];
  const box = machine(), demo = project(box, 'item-panel', undefined, { lanes: { web: { owns: owned, specs: ['G'] } } });
  // The seeded check is also executed by the native submission, so its fixture needs a real runner and test.
  mkdirSync(join(demo.repo, 'packages', 'gate', 'src', 'io', 'run'), { recursive: true });
  mkdirSync(join(demo.repo, 'apps', 'cli', 'journeys', 'verify', 'item'), { recursive: true });
  writeFileSync(join(demo.repo, 'packages', 'gate', 'src', 'io', 'run', 'tests.js'), "const { spawnSync } = require('node:child_process'); const result = spawnSync(process.execPath, ['--test', ...process.argv.slice(2)], { stdio: 'inherit' }); process.exit(result.status ?? 1);\n");
  writeFileSync(join(demo.repo, 'apps', 'cli', 'journeys', 'verify', 'item', 'panel.test.js'), "const { test } = require('node:test'); test('fixture check', () => {});\n");
  box.git(demo.repo, 'add', 'packages/gate/src/io/run/tests.js', 'apps/cli/journeys/verify/item/panel.test.js');
  box.git(demo.repo, 'commit', '-q', '-m', 'test: add fixture check runner [G1]');
  box.git(demo.web, 'merge', '--ff-only', 'main');
  const id = seedPanelItems(box, demo);
  assert.equal(id, 1, 'the private native fixture creates its identified primary item');
  await box.inProcess(demo.repo, 'milestone', 'add', 'Panel release', '--reason', 'Arrange fixture release', '--items', String(id));
  build(box, demo, id, 'item-panel.js');
  const reviewer = JSON.parse(await box.inProcess(demo.repo, 'worktree', 'web', '--model', 'Item panel reviewer fixture', '--json'));
  let head = box.git(demo.web, 'rev-parse', 'HEAD');
  box.git(reviewer.path, 'switch', '--detach', head);
  await box.inProcess(reviewer.path, 'next', '--verify', String(id));
  const frozen = JSON.parse(await box.inProcess(reviewer.path, 'show', String(id), '--json'));
  await box.inProcess(reviewer.path, 'verify', String(id), 'reject', '--reason', 'BEHAVIOR_MISMATCH', '--clause', JSON.parse(frozen.item_frozen).criterion,
    '--note', Array.from({ length: 8 }, (_, index) => `The sent-back note retains its actual native detail on line ${index + 1}.`).join('\n'), '--no-next');
  await box.inProcess(demo.web, 'claim', String(id));
  appendFileSync(join(demo.web, 'web', 'item-panel.js'), 'export const panelRepair = true;\n');
  box.git(demo.web, 'add', 'web/item-panel.js');
  box.git(demo.web, 'commit', '-q', '-m', 'test(web): update native panel fixture [G1]');
  await box.inProcess(demo.web, 'submit', String(id), '--no-next');
  head = box.git(demo.web, 'rev-parse', 'HEAD');
  box.git(reviewer.path, 'switch', '--detach', head);
  await box.inProcess(reviewer.path, 'next', '--verify', String(id));
  await box.inProcess(reviewer.path, 'verify', String(id), 'accept', '--note', Array.from({ length: 8 }, (_, index) => `The accepted fixture note keeps the complete review on line ${index + 1}.`).join('\n'), '--no-next');

  const view = await startView(box), profile = mkdtempSync(join(tmpdir(), 'pullboard-item-panel-chrome-'));
  let chrome;
  try {
    const state = await boardOf(view, demo.repo);
    const item = state.items.find(row => row.id === id);
    const other = state.items.find(row => row.id === 2);
    assert.deepEqual(item.verdicts.map(verdict => verdict.decision), ['REJECT', 'ACCEPT']);
    assert.equal(item.checkBaseline.result, 'red');
    assert.equal(other.checkBaseline.result, 'green');
    const href = new URL(view.link.href);
    href.pathname = '/items/' + id;
    chrome = await openSnapshotChrome(executable, href.href, profile);
    await chrome.send('Emulation.setTimezoneOverride', { timezoneId: 'America/Chicago' });
    await chrome.waitFor(`view.item === ${id} && !!document.querySelector('#detail .item-panel')`);
    const fullCommit = item.verdict.commit;
    for (const [width, mobile] of [[1440, false], [375, true]]) {
      await chrome.send('Emulation.setDeviceMetricsOverride', { width, height: 1000, deviceScaleFactor: 1, mobile });
      const shown = JSON.parse(await chrome.stable(`JSON.stringify((() => {
        const panel = document.querySelector('#detail .item-panel'), latest = panel.querySelector('.item-panel-latest'), note = latest.querySelector('.note');
        const title = panel.querySelector('.item-panel-head h2'), files = panel.querySelector('.item-panel-files'), clause = panel.querySelector('.ip-cl');
        const style = getComputedStyle(note), rect = note.getBoundingClientRect(), lineHeight = parseFloat(style.lineHeight);
        const brief = panel.querySelector('.item-panel-brief');
        return { title: title.textContent, titleSize: getComputedStyle(title).fontSize, id: panel.querySelector('.item-panel-head .id').textContent, chip: panel.querySelector('.item-panel-head .ip-chip').textContent,
          who: panel.querySelector('.item-panel-head .ip-who').innerText, meta: panel.querySelector('.ip-meta').innerText, tabs: panel.querySelectorAll('[role=tab]').length, chipRows: panel.querySelectorAll('.item-panel-where, .item-panel-status').length,
          labels: [...panel.querySelectorAll('.ip-lbl')].map(label => label.textContent), latest: latest.textContent, latestChip: latest.querySelector('.ip-chip').textContent, latestCaption: latest.closest('section').querySelector('.ip-cap').textContent,
          noteLines: Math.round(rect.height / lineHeight), noteClamp: style.webkitLineClamp, briefClamp: getComputedStyle(brief).webkitLineClamp,
          clauses: [...panel.querySelectorAll('.ip-cl')].map(row => [row.querySelector('.n').textContent, row.querySelector('.k').textContent, row.querySelector('.pv').textContent.trim(), row.querySelector('.pv').className]),
          clauseCaption: clause.closest('section').querySelector('.ip-cap').textContent,
          sha: [...panel.querySelectorAll('.hash-copy')].map(button => [button.textContent, button.dataset.copy, button.title, button.getAttribute('aria-label')]),
          files: [...files.querySelectorAll('.item-file')].map(file => ({ path: file.dataset.file, icon: file.querySelector('svg path').getAttribute('d') })),
          check: [...panel.querySelectorAll('.ip-fr')].filter(row => row.closest('section').querySelector('.ip-lbl').textContent === 'Check').map(row => [row.title, row.textContent.trim()]),
          checkCaption: [...panel.querySelectorAll('.ip-lbl')].find(label => label.textContent === 'Check').parentElement.querySelector('.ip-cap').textContent,
          brief: brief?.innerText, summaryRows: panel.querySelectorAll('.ip-hrs .ip-hr').length, historyCaption: panel.querySelector('.item-panel-history .ip-cap').textContent,
          overflow: document.documentElement.scrollWidth > innerWidth, viewport: innerWidth, exceptions: window.__unused }; })())`));
      assert.equal(shown.title, 'Long item panel fixture', `${width}px title is readable`);
      assert.equal(shown.titleSize, '17px');
      assert.equal(shown.id, '#1');
      assert.match(shown.chip, /^(?:Verified|Landed)$/u);
      assert.match(shown.meta, /^web · strong · Panel release$/u, 'one quiet meta line: lane, route, milestone');
      assert.equal(shown.tabs, 0, 'no tabs');
      assert.equal(shown.chipRows, 0, 'no chip rows');
      assert.deepEqual(shown.labels, ['Passed', 'Journey', 'Done when', 'Check', 'Brief', 'Files', 'History'], 'one scroll of sections in the approved order, each with content');
      assert.match(shown.latestChip, /criterion met/iu);
      assert.match(shown.latestCaption, /\S+ · \S+/u, 'the verdict keeps its local time and seat together');
      assert.equal(shown.noteClamp, '3');
      assert.ok(shown.noteLines <= 3, `${width}px latest verdict note is clamped to three measured lines`);
      assert.equal(shown.briefClamp, '3');
      assert.deepEqual(shown.clauses, [['1', '', 'Proven', 'pv ok']], 'a passed item proves its clause');
      assert.equal(shown.clauseCaption, '1 of 1 proven');
      assert.ok(shown.sha.some(([text, full, title, label]) => text === fullCommit.slice(0, 7) && full === fullCommit
        && title === fullCommit && label === `Copy full hash ${fullCommit}`), 'the short SHA retains its full hover and copy value');
      assert.deepEqual(shown.check, [[standardCheck, 'apps/cli/journeys/verify/item/panel.test.js']], 'the check is its test file, with the whole command on hover');
      assert.equal(shown.checkCaption, 'passes with no failures · red on main');
      assert.equal(shown.brief.includes('Files:'), false, 'the paths are shown once as rows');
      assert.deepEqual(shown.files.map(file => file.path), ['web/item-panel.js', 'apps/cli/journeys/verify/item/panel.test.js']);
      assert.ok(shown.summaryRows <= 6 && shown.summaryRows >= 1, 'the history shows its newest rows');
      assert.match(shown.historyCaption, /^\d+ events$/u);
      assert.equal(shown.overflow, false, `${width}px remains within the viewport`);

      await press(chrome, "document.querySelector('#detail .item-panel-latest [data-item-panel-more]')");
      assert.equal(await chrome.stable("document.querySelector('#detail .item-panel-latest').classList.contains('expanded')"), true);
      await press(chrome, "document.querySelector('#detail .item-panel-latest [data-item-panel-more]')");
      assert.equal(await chrome.stable("document.querySelector('#detail .item-panel-latest').classList.contains('expanded')"), false);
      await press(chrome, "document.querySelector('#detail .item-panel-expand [data-item-panel-more]')");
      assert.equal(await chrome.stable("document.querySelector('#detail .item-panel-expand').classList.contains('expanded')"), true);
      await press(chrome, "document.querySelector('#detail .item-panel-expand [data-item-panel-more]')");
      assert.equal(await chrome.stable("document.querySelector('#detail .item-panel-expand').classList.contains('expanded')"), false);
      await press(chrome, "document.querySelector('#detail [data-item-clause]')");
      assert.equal(await chrome.stable("document.querySelector('#detail [data-item-clause]').classList.contains('open')"), true, 'a click opens the clause evidence in place');
      await press(chrome, "document.querySelector('#detail [data-item-clause]')");
      assert.equal(await chrome.stable("document.querySelector('#detail [data-item-clause]').classList.contains('open')"), false);
      const eventIds = JSON.parse(await chrome.stable("JSON.stringify([...document.querySelectorAll('#detail .item-panel-history-list .tl > li')].map(row => Number(row.dataset.eventId)))"));
      assert.ok(eventIds[0] > eventIds.at(-1), 'the full history reads newest first while retaining native event ids');
      // An expanded history is remembered across renders [B23], so the phone pass finds the desktop pass's expansion still open.
      const remembered = width !== 1440;
      assert.match(await chrome.stable("document.querySelector('#detail [data-item-panel-history]').textContent"), remembered ? /^Less$/u : /^All ›$/u);
      if (!remembered) await press(chrome, "document.querySelector('#detail [data-item-panel-history]')");
      assert.equal(await chrome.stable("document.querySelector('#detail .item-panel-history-list').classList.contains('expanded')"), true);
      assert.equal(await chrome.stable("document.querySelector('#detail [data-item-panel-history]').getAttribute('aria-expanded')"), 'true');
    }
    await press(chrome, "document.querySelector('#chain [data-item=\"2\"]')");
    await chrome.waitFor("view.item === 2 && [...document.querySelectorAll('#detail .ip-lbl')].some(label => label.textContent === 'Check')");
    assert.equal(await chrome.stable("document.querySelector('#detail .ip-fr .p').textContent"), 'node --check web/other.js', 'a command that is no test file is shown as the command');
    assert.equal(await chrome.stable("[...document.querySelectorAll('#detail .ip-lbl')].find(label => label.textContent === 'Check').parentElement.querySelector('.ip-cap').textContent"), 'runs one command · green on main');
    assert.deepEqual(chrome.exceptions, []);
  } finally {
    if (chrome) await closeSnapshotChrome(chrome);
    await view.stop();
    rmSync(profile, { recursive: true, force: true });
  }
});
