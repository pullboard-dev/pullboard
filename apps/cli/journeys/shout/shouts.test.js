// pullboard: browser
/** @pullboard-test-gui */
/** Cockpit shouts: counts, evidence and authorship [N26], using the shared real-board fixtures. */
import assert from 'node:assert/strict';
import {
  spawn,
} from 'node:child_process';
import {
  after,
  test,
} from 'node:test';
import {
  BIN,
  fetchLive,
  boardOf,
  machine,
  project,
  startView,
  styleOf,
  storage,
  openPage,
  boardId,
} from '../../tests/fixtures/cockpit/harness.js';
import {
  MACHINE_MODEL,
} from '../../tests/fixtures/cockpit/machine.js';
const { relaySenderProblem } = nativeBoardPorts().enginePorts;

test('the shouts tab counts shouts you have not seen [N26]', async () => {
  const box = machine();
  const alpha = project(box, 'alpha');
  box.run(alpha.repo, 'shout', 'web', 'first');
  box.run(alpha.repo, 'shout', 'web', 'second');
  const beta = project(box, 'beta');
  box.run(beta.repo, 'shout', 'web', 'beta has its own');
  const view = await startView(box);
  try {
    const store = storage();
    const count = (page) => { const unread = page.element('status-unread'); return unread.hidden ? '' : /<b>(\d+)<\/b> unread/.exec(unread.innerHTML)?.[1] ?? unread.innerHTML; };
    const page = await openPage(view, { store });
    assert.equal(count(page), '', 'the shouts there before the first look count as seen, not as 2');

    box.run(alpha.web, 'shout', 'all', 'web-1 is on it');
    await page.run('refresh()');
    assert.equal(count(page), '1', 'a shout since then counts');
    await page.click({ tab: 'shouts' });
    assert.equal(count(page), '', 'opening Shouts sees it');
    box.run(alpha.web, 'shout', 'all', 'and done');
    await page.run('refresh()');
    assert.equal(count(page), '', 'a shout that arrives while Shouts is open is seen');
    await page.click({ tab: 'items' });

    // A shout lands while the page is closed: the reload counts it, and only it.
    box.run(alpha.web, 'shout', 'all', 'while you were away');
    const reloaded = await openPage(view, { store });
    assert.equal(count(reloaded), '1', 'what was seen is remembered across a reload');
    await reloaded.click({ tab: 'shouts' });
    assert.equal(count(reloaded), '');

    // A burst larger than the forty shouts the page loads still counts in full, after a reload too.
    await reloaded.click({ tab: 'items' });
    for (let n = 1; n <= 41; n += 1) box.run(alpha.web, 'shout', 'all', `burst ${n}`);
    await reloaded.run('refresh()');
    assert.equal(count(reloaded), '41', 'every arrival counts, not just the forty loaded');
    const again = await openPage(view, { store });
    assert.equal(count(again), '41');

    // Each project keeps its own mark: a first look at beta sees its shouts, and alpha still counts.
    await again.click({ root: beta.repo, classes: 'proj side' });
    assert.equal(count(again), '');
    await again.click({ root: alpha.repo, classes: 'proj side' });
    assert.equal(count(again), '41');

    // A switch to beta that is slow to arrive: tabs clicked meanwhile must not mark alpha's shouts as
    // beta's, or beta's next shout would never count.
    const racing = await openPage(view, { store });
    const betaId = await boardId(view, beta.repo);
    racing.run(`const plain = fetch; globalThis.fetch = (path, init) => path.includes(${JSON.stringify('/api/v1/boards/' + betaId + '/state')}) ? new Promise((done) => setTimeout(done, 300)).then(() => plain(path, init)) : plain(path, init);`);
    racing.run(`switchTo(${JSON.stringify(beta.repo)})`);
    await racing.click({ tab: 'shouts' });
    await racing.click({ tab: 'items' });
    await new Promise((done) => setTimeout(done, 600));
    await racing.run('refresh()');
    assert.equal(racing.element('proj-name').textContent, 'beta');
    box.run(beta.repo, 'shout', 'web', 'beta moves on');
    await racing.run('refresh()');
    assert.equal(count(racing), '1', 'the shout that came after counts');
  } finally {
    await view.stop();
  }
});

test('an empty feed says so on one line [N26]', async () => {
  const box = machine();
  project(box, 'alpha');
  const view = await startView(box);
  try {
    const page = await openPage(view);
    page.run("openTab('shouts'); render();");
    assert.equal(page.show('feed'), '<div class="empty">No shouts yet.</div>', 'one line, with no bar while the feed shows everything');
    assert.match(page.html, /<div class="card-panel shouts-card">[^]*<div class="feed" id="feed"><\/div><\/div>/, 'the shouts feed, in the Shouts card');
    assert.match(page.html, /<div class="card-panel feed" id="activity"><\/div>/, 'and the activity feed are both feeds');
    const style = await styleOf(view);
    assert.match(style, /\n\.feed > div \{ display: grid; grid-template-columns: 4\.6em minmax\(0, 1fr\);[^\n]*\n\.feed > \.empty \{ display: block; \}\n/, 'a feed row has a time column; its empty note takes the whole width');
  } finally {
    await view.stop();
  }
});
test('a shout shows the evidence it carries [B22]', async () => {
  const box = machine();
  const alpha = project(box, 'alpha');
  box.run(alpha.repo, 'add', 'web', 'Greeting', '--specs', 'G1', '--criterion', 'greets');
  box.run(alpha.web, 'claim', '1'); // Evidence needs a bound item and commit, not a restated submit.
  const head = box.git(alpha.web, 'rev-parse', 'HEAD');
  box.run(alpha.web, 'shout', 'all', 'the page loads in 80ms', '--evidence', 'receipt', '--outcome', 'measured <fast>', '--item', '1', '--commit', head.slice(0, 7));
  box.run(alpha.web, 'shout', 'all', 'tried a cache', '--evidence', 'attempt', '--outcome', 'failed', '--item', '1', '--commit', 'HEAD');
  box.run(alpha.web, 'shout', 'all', 'nothing to show');
  const view = await startView(box);
  try {
    const page = await openPage(view);
    page.run("openTab('shouts'); view.shoutThread = 'item:1'; render();");
    const feed = page.show('feed');
    const card = (kind, outcome) => `<div class="receipt"><div><span class="badge">${kind}</span> <span class="outcome">${outcome}</span></div><div class="receipt-foot"><a class="ref" href="/items/1" data-go="item:1" title="Greeting">#1</a> · web-1 (${MACHINE_MODEL}) · <button class="hash-copy" type="button" title="${head}" aria-label="Copy full hash ${head}" data-copy="${head}"><code class="inline sha" title="${head}">${head.slice(0, 12)}</code></button></div></div>`;
    const after = (text) => feed.slice(feed.indexOf(text + '</div>') + text.length + 6).replace(/^<button class="more" data-more type="button" aria-expanded="false">Show all<\/button>/, '');
    assert.ok(after('the page loads in 80ms').startsWith(card('receipt', 'measured &lt;fast&gt;')), `what was measured, for which item, by whom, at which commit: ${after('the page loads in 80ms').slice(0, 400)}`);
    assert.ok(after('tried a cache').startsWith(card('attempt', 'failed')), 'and what was tried');
    assert.match(feed, /<b>#1 Greeting<\/b>/, 'the opened conversation names the real item above its messages');
    page.run("view.shoutThread = 'none'; render();");
    const plain = page.show('feed');
    assert.ok(plain.includes('nothing to show</div>'), 'the No item conversation retains its native words');
    assert.doesNotMatch(plain, /class="receipt"/, 'a shout with no evidence has no receipt');
  } finally {
    await view.stop();
  }
});

/** The person's own words carry the person's name, and only the view's secret can give it [N26,A9,B26]. */
test('a shout from the view shows the person as its author [N26,A9]', { timeout: 60_000 }, async (t) => {
  const box = machine();
  const alpha = project(box, 'alpha');
  box.run(alpha.web, 'shout', 'all', 'web-1 is on the greeting');
  const view = await startView(box);
  // The standalone API an agent can start with pullboard serve: a board key, never the person.
  const serve = spawn(process.execPath, [BIN, 'serve', '--port', '0', '--json'], { cwd: alpha.repo, env: box.env, stdio: ['ignore', 'pipe', 'pipe'] });
  t.after(() => { if (serve.exitCode === null) serve.kill('SIGTERM'); });
  try {
    const page = await openPage(view);
    await page.click({ tab: 'shouts' });
    // The composer as it opens: addressed to the coordinator.
    page.element('shout-to').value = 'coordinator';
    page.element('shout-text').value = 'Hello from the person';
    await page.fire('shout-form', 'submit');
    page.element('shout-to').value = 'web';
    page.element('shout-text').value = 'Web, keep it short';
    await page.fire('shout-form', 'submit');
    await page.run('refresh()');
    page.run("view.shoutThread = 'none'; render();");
    const cards = () => [...page.show('feed').matchAll(/<b class="who"[^>]* title="([^"]*)">([^<]*)<\/b><span class="to">→ (?:<span[^>]*>)?([^<]*)(?:<\/span>)?<\/span>[^]*?<div class="text">([^<]*)<\/div>/g)].map((m) => m.slice(1));
    assert.deepEqual(cards(), [
      [MACHINE_MODEL, 'web-1', 'coordinator and you', 'web-1 is on the greeting'],
      ['unknown', 'you', 'coordinator', 'Hello from the person'],
      ['unknown', 'you', 'web', 'Web, keep it short'],
    ], 'the conversation keeps native author and recipient order, naming the model only on hover');

    const said = (events) => events.filter((event) => event.event_kind === 'shout').map((event) => event.event_by);
    assert.deepEqual(said(JSON.parse(box.run(alpha.repo, 'log', '--json')).events), ['web-1', 'person', 'person'], 'pullboard log --json records the person as the author');
    const lines = box.run(alpha.repo, 'log').split('\n').filter((line) => / shout /.test(line));
    assert.deepEqual(lines.map((line) => line.slice(21, 45).trim()), [`web-1 (${MACHINE_MODEL})`, 'person', 'person'], `pullboard log names the person: ${lines.join('\n')}`);
    assert.ok(lines.every((line) => !line.includes('coordinator (unknown)')), 'never as coordinator (unknown)');

    // An agent never shouts as the person: through the view's API under its own name, through the
    // standalone API with a board key, or through the relay.
    const id = await boardId(view, alpha.repo);
    const viewMove = await fetchLive(`${view.base}/api/v1/boards/${id}/moves`, { method: 'POST', headers: { 'x-pullboard-key': view.key, 'content-type': 'application/json' },
      body: JSON.stringify({ verb: 'shout', agent: 'web-1', args: { to: 'coordinator', text: 'an agent under its own name', kind: 'question' } }) });
    assert.equal(viewMove.status, 200, 'an agent named in a move speaks as itself');
    const forged = await fetchLive(`${view.base}/api/v1/boards/${id}/moves`, { method: 'POST', headers: { 'x-pullboard-key': view.key, 'content-type': 'application/json' },
      body: JSON.stringify({ verb: 'shout', from: 'person', args: { to: 'web', text: 'forged' } }) });
    assert.equal((await forged.json()).error.code, 'BAD_REQUEST', 'a move cannot name its own author');
    const url = new URL(await new Promise((found, fail) => {
      let out = '';
      serve.stdout.on('data', (chunk) => { out += chunk; const match = /"url": "([^"]+)"/.exec(out); if (match) found(match[1]); });
      serve.once('exit', (code) => fail(new Error(`pullboard serve exited ${code}`)));
    }));
    const api = (path, body) => fetchLive(`${url.origin}/api/v1/boards/${id}/${path}?k=${url.searchParams.get('k')}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    assert.equal((await api('moves', { verb: 'shout', args: { to: 'web', text: 'through the serve key' } })).status, 200);
    assert.equal((await (await api('requests', { text: 'as the person?' })).json()).error.code, 'B26_PERSON_CHANNEL', 'a serve key cannot send the person\'s request');
    const state = await boardOf(view, alpha.repo);
    const by = (text) => state.shouts.find((shout) => shout.shout_text === text)?.shout_from;
    assert.deepEqual([by('an agent under its own name'), by('through the serve key'), by('forged'), by('as the person?')], ['web-1', 'coordinator', undefined, undefined], 'only the view\'s own person channel names the person');
    const relayed = relaySenderProblem({ operation: 'shout', engine: 20, args: [{ from: 'person', to: 'web', text: 'relayed', lanes: ['web'] }] }, { kind: 'agent', userId: 'u1', agent: 'web-1' }, 'move');
    assert.equal(relayed?.code, 'RELAY_PERSON_ONLY', 'the relay refuses an agent\'s shout as the person');
  } finally {
    if (serve.exitCode === null) serve.kill('SIGTERM');
    await view.stop();
  }
});


