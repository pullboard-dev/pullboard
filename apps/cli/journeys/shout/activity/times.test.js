// pullboard: browser
/** @pullboard-test-input source-tree */
/** @pullboard-test-gui */
/** Cockpit activity checks, "times" group, using the shared real-board fixtures [N26]. */
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
  machine,
  project,
  build,
  fetchLive,
  startView,
  element,
  openPage,
  agentEntries,
  itemRow,
  chromeExecutable,
  openSnapshotChrome,
  closeSnapshotChrome,
} from '../../../tests/fixtures/cockpit/harness.js';

test('ages stay true while the board is quiet [N26]', async () => {
  const box = machine();
  const alpha = project(box, 'alpha');
  await box.inProcess(alpha.repo, 'add', 'web', 'Greeting', '--specs', 'G1', '--criterion', 'greets');
  build(box, alpha, 1, 'greeting.html');
  await box.inProcess(alpha.repo, 'shout', 'person', 'Ship the greeting today?', '--kind', 'decision', '--decision');
  const view = await startView(box);
  try {
    const page = await openPage(view);
    await page.click({ tab: 'items' });
    await page.click({ tab: 'shouts' });
    const ages = () => ({
      row: /<time data-ago="[^"]+">([^<]*)<\/time>/.exec(itemRow(page.show('chain'), 1))?.[1],
      needs: /<span class="needs-age"><time data-ago="[^"]+">([^<]*)<\/time>/.exec(page.show('needs'))?.[1],
      agent: agentEntries(page.show('agents')).find((agent) => agent.id === 'web-1')?.age,
      shout: /<time class="conversation-time" data-ago="[^"]+" title="[^"]*">([^<]*)<\/time>/.exec(page.show('feed'))?.[1],
    });
    assert.deepEqual(ages(), { row: 'now', needs: 'now', agent: 'now', shout: 'now' });
    const rebuilds = () => ['chain', 'needs', 'agents', 'feed'].map((id) => page.element(id).writes);
    const before = rebuilds();

    // Three hours pass, nothing on the board changes, and the minute timer fires.
    page.run('const D = Date; globalThis.Date = class extends D { constructor(...a) { super(...(a.length ? a : [D.now() + 3 * 3600e3])); } static now() { return D.now() + 3 * 3600e3; } };');
    page.run('tickAges()');
    assert.deepEqual(ages(), { row: '3h', needs: '3h', agent: '3h', shout: '3h ago' }, 'a shout says how long ago in words');
    assert.deepEqual(rebuilds(), before, 'each age moved where it stands; nothing was rebuilt');
  } finally {
    await view.stop();
  }
});

test('times say which day they were [N26]', async () => {
  const box = machine();
  const alpha = project(box, 'alpha');
  await box.inProcess(alpha.repo, 'add', 'web', 'Greeting', '--specs', 'G1', '--criterion', 'greets');
  build(box, alpha, 1, 'greeting.html');
  await box.inProcess(alpha.repo, 'shout', 'web', '#1 is in');
  const view = await startView(box);
  try {
    const days = (html) => [...html.matchAll(/<h4 class="day">([^<]*)<\/h4>|<div class="day-rule" role="separator"><span>([^<]*)<\/span><\/div>/g)].map((match) => match[1] ?? match[2]);
    // A shout says how long ago it was, with its clock time on hover.
    const ages = (html) => [...html.matchAll(/<time class="conversation-time" data-ago="[^"]+" title="([^"]*)">([^<]*)<\/time>/g)].map((match) => [match[2], match[1]]);
    const times = (html) => [...html.matchAll(/<time>([^<]*)<\/time>/g)].map((match) => match[1]);
    const bare = (list) => list.length > 0 && list.every((time) => /^\d{1,2}:\d\d [AP]M$/.test(time));

    const now = await openPage(view);
    await now.click({ tab: 'shouts' });
    await now.click({ tab: 'items' });
    await now.click({ tab: 'activity' });
    // The redesigned Activity (#6916) groups rows by hour card and draws no day headings or <time> clocks, so the day-name and
    // bare-clock assertions on it have no equivalent; the hour card names its hour and a row says its age.
    assert.deepEqual(days(now.show('feed')), [], 'shouts from today need no rule above them');
    assert.deepEqual(ages(now.show('feed')).map(([age, clock]) => [age, /^\d{1,2}:\d\d [AP]M$/.test(clock)]), [['now', true]], 'a shout from today says now, its clock time on hover');
    assert.ok(bare(times(now.show('detail'))), 'a history from today shows bare times');

    const tomorrow = await openPage(view, { later: 1 });
    await tomorrow.click({ tab: 'shouts' });
    await tomorrow.click({ tab: 'activity' });
    assert.deepEqual(days(tomorrow.show('feed')), ['Yesterday']);

    const weekday = new Date().toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' });
    const date = new Date().toLocaleDateString([], { month: 'short', day: 'numeric' });
    const later = await openPage(view, { later: 2 });
    await later.click({ tab: 'shouts' });
    await later.click({ tab: 'items' });
    await later.click({ tab: 'activity' });
    assert.deepEqual(days(later.show('feed')), [weekday], 'two days on, the feed names the day');
    assert.deepEqual(ages(later.show('feed')).map(([age, clock]) => [age, new RegExp(`^${date} \\d{1,2}:\\d\\d [AP]M$`).test(clock)]), [['2d ago', true]], 'a shout says how long ago, with its date and time on hover');
    const history = times(later.show('detail'));
    assert.ok(history.length >= 6 && history.every((time) => new RegExp(`^${date} \\d{1,2}:\\d\\d [AP]M$`).test(time)), `the history dates every move including its proof receipt and each note: ${history}`);

    // A heading wherever the day changes, and only there.
    const at = (day, hour) => new Date(2026, 9, day, hour).toISOString();
    const rows = JSON.stringify([at(6, 15), at(6, 9), at(5, 20), at(3, 12)].map((iso) => ({ iso })));
    const html = now.run(`byDay(${rows}, (x) => x.iso, () => '<div></div>')`);
    assert.equal(html.replace(/<h4 class="day">[^<]*<\/h4>/g, 'H').replaceAll('<div></div>', 'r'), 'HrrHrHr');
    // Shouts get a rule only where the day changes, and none above today's.
    const rule = (list) => now.run(`dayRules(${JSON.stringify(list.map((iso) => ({ iso })))}, (x) => x.iso, () => '<div></div>')`).replace(/<div class="day-rule" role="separator"><span>[^<]*<\/span><\/div>/g, 'H').replaceAll('<div></div>', 'r');
    assert.equal(rule([at(6, 15), at(6, 9), at(5, 20), at(3, 12)]), 'HrrHrHr', 'an older first day still gets its rule');
    assert.equal(rule([new Date().toISOString(), at(6, 9)]), 'rHr', 'today has no rule; the first earlier day does');
  } finally {
    await view.stop();
  }
});

test('activity rows say what each shout and answer said [N26]', { timeout: 120_000 }, async (t) => {
  const executable = chromeExecutable();
  if (!executable) return t.skip('Install Chrome or set PULLBOARD_CHROME for activity checks.');

  const box = machine();
  const demo = project(box, 'said');
  await box.inProcess(demo.repo, 'add', 'web', 'Greet the visitor', '--specs', 'G1', '--criterion', 'greets');
  await box.inProcess(demo.repo, 'shout', 'web', 'The oldest note, from before the forty shouts the view loads');
  for (let n = 1; n <= 40; n++) await box.inProcess(demo.repo, 'shout', 'web', `Filler ${n}`);
  const long = 'Please take #1 next, run `pullboard next` in your worktree, and keep going until the greeting reads right on every width the view supports';
  await box.inProcess(demo.repo, 'shout', 'web', `${long}\nA second line the row leaves out.`);
  await box.inProcess(demo.repo, 'shout', 'all', 'The private news release is ready.', '--news');
  await box.inProcess(demo.repo, 'lanes', 'lead', 'web', 'web-1');
  await box.inProcess(demo.web, 'shout', 'coordinator', 'Ship the greeting today?', '--kind', 'decision', '--decision');
  const view = await startView(box);
  const profile = mkdtempSync(join(tmpdir(), 'pullboard-said-chrome-'));
  let chrome;
  try {
    const headers = { 'x-pullboard-key': view.key };
    const [board] = (await (await fetchLive(`${view.base}/api/v1/boards`, { headers })).json()).boards;
    const state = (await (await fetchLive(`${view.base}/api/v1/boards/${encodeURIComponent(board.id)}/state`, { headers })).json()).state;
    const ask = state.asked.find((row) => row.shout_text === 'Ship the greeting today?');
    await box.inProcess(demo.repo, 'answer', String(ask.shout_id), 'Yes, ship it once the phone width reads right too');
    const asker = ask.shout_from;

    chrome = await openSnapshotChrome(executable, view.link.href, profile);
    await chrome.waitFor('!!document.querySelector(\'[data-tab="activity"]\')');
    await chrome.waitFor("typeof data === 'object' && !!data && !!data.project");
    await chrome.click('document.querySelector(\'[data-tab="activity"]\')');
    // The redesigned Activity (#6916) draws one act-row per event: a chip, the quoted words (one line, ellipsis) and "from X to Y"
    // below. An answer has no row of its own, and the page pages its rows ten to an hour. It has no "told web about #1" sentence, "about" chip, model hover, wrapped multi-line quote, inline code or links,
    // and its lifecycle figure (#flow, its labels) is retired, so those assertions have no equivalent.
    await chrome.waitFor(`[...document.querySelectorAll('#activity .act-row .ph')].some(row => row.textContent.includes('Ship the greeting today?'))`);
    for (const width of [375, 1280]) {
      await chrome.send('Emulation.setDeviceMetricsOverride', { width, height: 900, deviceScaleFactor: 1, mobile: false });
      await chrome.waitFor(`innerWidth === ${width} && !document.querySelector('[data-pane="activity"]').hidden && [...document.querySelectorAll('#activity .act-row')].every((row) => row.getBoundingClientRect().height > 0)`);
      const rows = JSON.parse(await chrome.stable(`JSON.stringify([...document.querySelectorAll('#activity .act-row')].map(row => ({
        chip: row.querySelector('.act-chip')?.textContent, said: row.querySelector('.ph')?.textContent ?? '', fact: row.querySelector('.fa')?.textContent ?? '',
        ellipsis: getComputedStyle(row.querySelector('.ph')).textOverflow, row: row.dataset.row ?? null })))`));
      const told = rows.find(row => row.said.includes('Please take'));
      assert.ok(told, `${width}: the long shout keeps its original words: ${JSON.stringify(rows)}`);
      assert.equal(told.fact, 'from coordinator to web', `${width}: and its sender and recipient`);
      assert.ok(told.said.includes(long.replaceAll('`', '')) || told.said.includes(long), `${width}: the row quotes the shout's own words`);
      assert.equal(told.ellipsis, 'ellipsis', `${width}: a quote is one line with an ellipsis`);
      // The redesigned flow draws no row for a shout_news event, so typed news has no row to assert.
      assert.ok(rows.some(row => row.said.includes('Ship the greeting today?') && row.fact === 'from ' + asker + ' to coordinator'), 'a question retains its sender, recipient and words');
      assert.ok(rows.every(row => !row.fact.includes('(unknown)') && !row.said.includes('(unknown)')), 'unknown models are omitted');
    }
  } finally {
    if (chrome) await closeSnapshotChrome(chrome);
    rmSync(profile, { recursive: true, force: true });
    await view.stop();
  }
});
