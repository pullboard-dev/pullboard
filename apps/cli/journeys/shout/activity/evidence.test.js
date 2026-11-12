// pullboard: browser
/** @pullboard-test-input source-tree */
/** @pullboard-test-gui */
/** Cockpit activity checks, "evidence" group, using the shared real-board fixtures [N26]. */
import assert from 'node:assert/strict';
import {
  mkdtempSync,
  rmSync,
  readFileSync,
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
  styleOf,
  openPage,
  accept,
  chromeExecutable,
  openSnapshotChrome,
  closeSnapshotChrome,
  press,
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
    await chrome.waitFor("document.querySelector('#activity [data-activity-kind=main-moved]')");
    for (const width of [1440, 375]) {
      await chrome.send('Emulation.setDeviceMetricsOverride', { width, height: 900, deviceScaleFactor: 1, mobile: false });
      const result = JSON.parse(await chrome.stable(`JSON.stringify({ text: document.querySelector('#activity').innerText, html: document.querySelector('#activity').innerHTML, overflow: document.documentElement.scrollWidth > innerWidth })`));
      assert.match(result.text, /Builder note <safe>[\s\S]*Checks: test\/example\.test\.js[\s\S]*Focused evidence[\s\S]*Check passed/u);
      assert.match(result.text, /Reviewer note <safe>/u);
      assert.match(result.text, /Reason: rigor[\s\S]*Rejection note <safe>/u);
      assert.match(result.text, /Landed at a{12}/u);
      assert.match(result.text, /Items: #1[\s\S]*Main at b{12}/u);
      assert.doesNotMatch(result.html, /<safe>/u, 'event prose is escaped');
      assert.equal(result.overflow, false, `${width}px stays within the viewport`);
    }
    assert.deepEqual(chrome.exceptions, []);
  } finally { if (chrome) await closeSnapshotChrome(chrome); await view.stop(); rmSync(profile, { recursive: true, force: true }); }
});


/** Verify a verified stay ends at its next state move, while a quiet merge remains untimed. */

test('activity names the item each event moved [N26]', async () => {
  const box = machine();
  const alpha = project(box, 'alpha');
  await box.inProcess(alpha.repo, 'add', 'web', 'Greeting <b>bold</b>', '--specs', 'G1', '--criterion', 'greets');
  await box.inProcess(alpha.web, 'claim', '1');
  const view = await startView(box);
  try {
    const page = await openPage(view);
    await page.click({ tab: 'activity' });
    const rows = page.show('activity').split('<li class="activity-event"').slice(1);
    const about = rows.filter(row => row.includes('data-go="item:1"'));
    assert.equal(about.length, 2, 'the add and the claim');
    for (const row of about) assert.match(row, /data-go="item:1">#1<\/a>Greeting &lt;b&gt;bold&lt;\/b&gt;/, 'the escaped title follows its real item link');
    assert.ok(rows.every(row => !row.includes('>join<')), 'subjectless join bookkeeping is hidden');
    assert.match(await styleOf(view), /\.activity-item \{[^}]*text-overflow: ellipsis;[^}]*white-space: nowrap;/, 'the approved item title uses one line with ellipsis');
  } finally {
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

test('clause 2: item-number links on Activity are not underlined and read in mono, as in the mockup [N26]', () => {
  const project = { items: [{ id: 7, title: 'Seven' }], agents: [], shouts: [], events: [{ event_id: 1, event_kind: 'claim', event_by: 'web-1', item_id: 7, event_at: new Date(Date.UTC(2026, 10, 4, 12)).toISOString(), event_detail: '{}' }] };
  assert.match(activityHtml(activityModel(project), { controls: false }), /<ol class="activity-events">.*<span class="activity-item"[^>]*><a class="ref" href="[^"]*" data-go="item:7">#7<\/a>/su, 'the item number is an a.ref[data-go] inside the Activity list, which the rules below style');
  const css = readFileSync(new URL('../../../../view/src/io/main.css', import.meta.url), 'utf8');
  assert.match(css, /\.activity-events a\.ref\[data-go\] \{ text-decoration: none; \}/u, 'item-number links on Activity, in a row or a shout, are not underlined');
  assert.match(css, /\.activity-item a\.ref\[data-go\], \.activity-quote a\.ref\[data-go\] \{ font: 500 var\(--text-xs\) var\(--mono\); \}/u, 'an item number in a row or a shout reads as mono, as in the mockup');
});
