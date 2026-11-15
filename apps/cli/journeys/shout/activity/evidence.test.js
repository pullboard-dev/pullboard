// pullboard: browser
/** @pullboard-test-input source-tree */
/** @pullboard-test-gui */
/** Cockpit activity checks, "evidence" group, using the shared real-board fixtures [N26]. */
import assert from 'node:assert/strict';
import {
  mkdtempSync,
  rmSync,
} from 'node:fs';
import {
  tmpdir,
} from 'node:os';
import {
  join,
} from 'node:path';
import {
  test,
} from 'node:test';
import {
  activityModel,
  activityHtml,
} from '../../../../view/index.js';
import {
  openBoard,
} from '../../../../lib/index.js';
import {
  closeBoard,
  logEvent,
} from '../../../../../packages/store/index.js';
import {
  machine,
  project,
  startView,
  chromeExecutable,
  openSnapshotChrome,
  closeSnapshotChrome,
  press,
  styleOf,
} from '../../../tests/fixtures/cockpit/harness.js';

test('activity shows each submit note and verdict with landing evidence [N26]', { timeout: 120_000 }, async () => {
  const box = machine(), alpha = project(box, 'activity-evidence');
  await box.inProcess(alpha.repo, 'add', 'web', 'Readable evidence', '--specs', 'G1', '--criterion', 'Evidence is readable.');
  // @pullboard-board-file journey: native event records are served to the real Activity browser view.
  const board = openBoard(join(alpha.repo, '.git', 'pullboard', 'board.sqlite'));
  try {
    logEvent(board, 'web-1', 'submit', 1, { note: 'Builder note <safe>', gateGreen: true, submissionProof: { files: ['test/example.test.js'], reason: 'Focused evidence' } });
    logEvent(board, 'reviewer', 'reject', 1, { reason: 'RIGOR', note: 'Rejection note <safe>' });
    logEvent(board, 'reviewer', 'accept', 1, { note: 'Reviewer note <safe>' });
    logEvent(board, 'coordinator', 'merged', 1, { commit: 'a'.repeat(40) });
    logEvent(board, 'coordinator', 'main-moved', null, { sha: 'b'.repeat(40), items: [1] });
  } finally { closeBoard(board); }
  const view = await startView(box), profile = mkdtempSync(join(tmpdir(), 'pullboard-activity-evidence-'));
  let chrome;
  try {
    const executable = chromeExecutable();
    assert.ok(executable, 'real Chrome is required');
    chrome = await openSnapshotChrome(executable, view.link.href, profile);
    await chrome.waitFor('!!data?.project');
    await press(chrome, "document.querySelector('[data-tab=activity]')");
    // The redesigned Activity (#6916) draws a row per lifecycle event (chip, item and title, one fact line) and not the submit
    // note, the Checks and reason lines, the reviewer's note, or the commit and main-tip hover: those have no equivalent there.
    await chrome.waitFor("[...document.querySelectorAll('#activity .act-row .act-chip')].some(chip => chip.textContent === 'Landed')");
    for (const width of [1440, 375]) {
      await chrome.send('Emulation.setDeviceMetricsOverride', { width, height: 900, deviceScaleFactor: 1, mobile: false });
      const result = JSON.parse(await chrome.stable(`JSON.stringify({ rows: [...document.querySelectorAll('#activity .act-row')].map(row => ({ chip: row.querySelector('.act-chip').textContent, said: row.querySelector('.ph').textContent, fact: row.querySelector('.fa').textContent })), html: document.querySelector('#activity').innerHTML, overflow: document.documentElement.scrollWidth > innerWidth })`));
      const by = chip => result.rows.find(row => row.chip === chip);
      assert.match(by('Gate').fact, /^submitted by web-1/u, 'the submit is a Gate row');
      assert.match(by('Sent back').fact, /^review: Rejection note <safe>/u, 'the verdict row carries the reviewer words');
      assert.match(by('Landing').fact, /^accepted by reviewer/u, 'the accept is a Landing row');
      assert.match(by('Landed').said, /^#1Readable evidence$/u, 'a landing is one row: the item chip, then its title');
      assert.match(by('Landed').fact, /^in flight \d+m · a{7}$/u, 'the landing keeps its short commit');
      assert.doesNotMatch(JSON.stringify(result.rows), /moved main|Items: #1|Main at/u, 'its main move folds in, with no bare item, commit or main lines');
      assert.doesNotMatch(result.html, /<safe>/u, 'event prose is escaped');
      assert.equal(result.overflow, false, `${width}px stays within the viewport`);
    }
    assert.deepEqual(chrome.exceptions, []);
  } finally { if (chrome) await closeSnapshotChrome(chrome); await view.stop(); rmSync(profile, { recursive: true, force: true }); }
});


/** Verify a verified stay ends at its next state move, while a quiet merge remains untimed. */

test('activity names the item each event moved [N26]', { timeout: 120_000 }, async () => {
  const box = machine();
  const alpha = project(box, 'alpha');
  await box.inProcess(alpha.repo, 'add', 'web', 'Greeting <b>bold</b>', '--specs', 'G1', '--criterion', 'greets');
  await box.inProcess(alpha.web, 'claim', '1');
  const view = await startView(box);
  let chrome;
  try {
    const executable = chromeExecutable();
    assert.ok(executable, 'real Chrome is required');
    chrome = await openSnapshotChrome(executable, view.link.href, join(box.dir, 'activity-names-chrome'));
    await chrome.waitFor('!!data?.project');
    await press(chrome, "document.querySelector('[data-tab=activity]')");
    await chrome.waitFor("document.querySelectorAll('#activity .act-row[data-row=\"1\"]').length >= 2");
    const rows = JSON.parse(await chrome.stable(`JSON.stringify([...document.querySelectorAll('#activity .act-row')].map(row => ({ item: row.dataset.row ?? null, said: row.querySelector('.ph').textContent, markup: row.querySelectorAll('.ph *:not(.id)').length, fact: row.querySelector('.fa').textContent })))`));
    const about = rows.filter(row => row.item === '1');
    assert.equal(about.length, 2, 'the add and the claim');
    for (const row of about) assert.deepEqual([row.said, row.markup], ['#1Greeting <b>bold</b>', 0], 'the title follows its item number, as text');
    assert.ok(rows.every(row => row.item === '1'), 'subjectless join bookkeeping is hidden');
    assert.equal(await chrome.stable('getComputedStyle(document.querySelector("#activity .act-row .ph")).textOverflow'), 'ellipsis', 'a row title uses one line with ellipsis');
  } finally {
    if (chrome) await closeSnapshotChrome(chrome);
    await view.stop();
  }
});

/** Verify a phone board whose older history still streams says so on each list, pages on demand, then reads as complete. */

test('clause 1: Activity collapses consecutive continued-building rows by one seat for one item [N26]', () => {
  const at = minute => new Date(Date.UTC(2026, 10, 4, 12, minute)).toISOString();
  const event = (id, kind, by, item, minute) => ({ event_id: id, event_kind: kind, event_by: by, item_id: item, event_at: at(minute), event_detail: '{}' });
  const project = { items: [{ id: 7, title: 'Seven' }, { id: 8, title: 'Eight' }], agents: [], shouts: [], events: [
    event(1, 'claim', 'web-1', 7, 0), event(2, 'renew', 'web-1', 7, 10), event(3, 'renew', 'web-1', 7, 20), event(4, 'renew', 'web-1', 7, 30),
    event(5, 'renew', 'web-2', 8, 31), event(6, 'renew', 'web-1', 7, 40)] };
  const rows = activityModel(project).rows;
  const renewals = rows.filter(row => row.kind === 'renew');
  assert.deepEqual(renewals.map(row => [row.by, row.item.id, row.verb, row.at]), [
    ['web-1', 7, 'continued building', at(40)],
    ['web-2', 8, 'continued building', at(31)],
    ['web-1', 7, 'continued building · 3 updates', at(30)],
  ], 'three adjacent updates by web-1 on #7 become one row with the latest time; another seat or item breaks the run');
  const html = activityHtml(activityModel(project), { controls: false });
  assert.match(html, /continued building · 3 updates/u);
  assert.equal([...html.matchAll(/continued building · \d+ updates/gu)].length, 1, 'only the collapsed run carries a count');
});

test('clause 2: item numbers on Activity rows are not underlined and read in mono, as in the mockup [N26]', async () => {
  const view = await startView(machine());
  try {
    // The redesigned rows (#6916) draw the item number as a span.id, not a link, inside the row's first line.
    const css = await styleOf(view);
    assert.match(css, /\.act-row \.ph \.id \{[^}]*font-family: var\(--code\);/u, 'an item number in a row reads as mono, as in the mockup');
    assert.doesNotMatch(css, /\.act-row[^{]*\{[^}]*text-decoration: underline/u, 'no row text is underlined');
  } finally { await view.stop(); }
});
