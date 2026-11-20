// pullboard: browser
/** @pullboard-test-input apps/view/src/io/main.css apps/view/src/io/item/rows.css apps/view/src/io/stage.css apps/view/src/io/dashboard.css apps/view/src/io/activity.css apps/view/src/io/project-menu.css apps/view/src/io/palette/palette.css apps/view/src/io/nav.css apps/view/src/io/shouts.css apps/view/src/io/notch.css */
/** @pullboard-test-gui */
/** The production sidebar groups the local view's boards and each relay board under its machine name in real Chrome [C7,N26,#9455]. */
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { test } from 'node:test';
import { startChrome } from '../../../../cli/tests/fixtures/chrome.js';
import { findChromeExecutable } from '../../../../cli/tests/fixtures/chrome.js';
import { stableChrome } from '../../../../cli/tests/fixtures/cockpit/stable.js';
import { cockpitPage } from '../../../index.js';
import { composeViewStyles } from '../../../index.js';

/** The real page over a view that lists no board of its own: the test seeds the boards the sidebar draws. */
async function startFixture() {
  const server = createServer((request, response) => {
    const url = new URL(request.url, 'http://127.0.0.1');
    const send = (type, body, status = 200) => response.writeHead(status, { 'content-type': type, 'cache-control': 'no-store' }).end(body);
    if (url.pathname === '/') return send('text/html; charset=utf-8', cockpitPage('', { readOnly: true, requests: true, apiHeaders: {}, stylesheet: '/view.css', commandPhrases: () => ['add'] }));
    if (url.pathname === '/view.css') return send('text/css', composeViewStyles());
    if (url.pathname === '/api/v1/boards') return send('application/json', JSON.stringify({ version: 1, boards: [], warnings: [] }));
    return send('application/json', JSON.stringify({ error: 'not in this fixture' }), 404);
  });
  const origin = await new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${server.address().port}`)));
  return { origin, close: () => new Promise((resolve) => server.close(resolve)) };
}

/** One listed board as the page holds it: a local row carries its machine, a relay row the machine that shared it. */
const row = (id, name, source, machine) => ({ ok: true, id: id.repeat(32), root: source === 'relay' ? id.repeat(32) : `/work/${name}`, name, source, machine, decisions: 0, pending: 0, drafts: 0, holds: 0, open: 1 });

test('view.x-page-boards.sidebar-groups-by-machine: clause 2: with a local view and a relay source, the sidebar shows both machine headings with their boards [C7,N26,#9455]', { timeout: 120_000 }, async (t) => {
  if (!findChromeExecutable()) return t.skip('Install Chrome or set PULLBOARD_CHROME for the sidebar grouping check.');
  const fixture = await startFixture();
  const chrome = await stableChrome(await startChrome());
  try {
    await chrome.navigate(`${fixture.origin}/`);
    await chrome.waitFor("typeof renderSide === 'function' && document.getElementById('proj-list') !== null");
    const draw = (rows) => chrome.stable(`(() => { data = store.set({ root: null, project: null, group: null, projects: ${JSON.stringify(rows)}, groups: [] }); renderSide();
      return [...document.querySelectorAll('#proj-list .side-machine')].map((group) => ({ machine: group.dataset.machine, heading: group.querySelector('h3').textContent, boards: [...group.querySelectorAll('.pname')].map((name) => name.textContent) })); })()`);
    const mixed = await draw([row('a', 'Atlas', 'local', 'desk-mac'), row('b', 'Harbor', 'local', 'desk-mac'), row('c', 'Remote board', 'relay', 'Tower')]);
    assert.deepEqual(mixed, [
      { machine: 'desk-mac', heading: 'this computer', boards: ['Atlas', 'Harbor'] },
      { machine: 'Tower', heading: 'Tower', boards: ['Remote board'] },
    ], 'this computer holds the local boards and the relay machine holds its own');
    const local = await draw([row('a', 'Atlas', 'local', 'desk-mac')]);
    assert.deepEqual(local, [], 'with no relay board the sidebar draws no machine heading');
  } finally {
    await chrome.close();
    await fixture.close();
  }
});
