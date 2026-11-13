// pullboard: browser
/** @pullboard-test-input source-tree */
/** @pullboard-test-gui */
/** Cockpit needs checks, using the shared real-board fixtures [N26]. */
import assert from 'node:assert/strict';
import {
  mkdtempSync,
  readFileSync,
  rmSync,
} from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import {
  SPEC,
  machine,
  project,
  build,
  sendBack,
  startView,
  styleOf,
  element,
  openPage,
  projectRows,
  agentEntries,
  itemRow,
  shoutNameText,
  chromeExecutable,
  openSnapshotChrome,
  closeSnapshotChrome,
  chooseFilter,
  boardId,
  boardOf,
  fetchLive,
  serveFolder,
} from '../../tests/fixtures/cockpit/harness.js';
import { cliCockpitRenderer$cockpitPage as cockpitPage } from '../../index.js';
import { runCliInProcess } from '../../tests/fixtures/process.js';
import { personNeeds } from '../../../../packages/spec/index.js';

/** Read the actual shared-panel summaries and controls, without translating them to legacy markup. */
function needEntries(html) {
  return [...html.matchAll(/<li class="needs-call [^"]*"[^>]*>([\s\S]*?)<\/li>/gu)].map(([, row]) => {
    const title = row.match(/<span class="needs-copy"><b>([\s\S]*?)<\/b><small>([\s\S]*?)<\/small>/u);
    const ref = title?.[1].match(/^<span class="needs-id"(?: title="[^"]*")?>([\s\S]*?)<\/span>/u);
    const target = row.match(/data-go="([^"]*)"/u)?.[1] ?? null;
    const action = row.match(/<span class="needs-action[^"]*">([^<]*)<\/span>/u)?.[1];
    return [target, ref?.[1] ?? null, (title?.[1] ?? '').replace(/^<span class="needs-id"(?: title="[^"]*")?>[\s\S]*?<\/span>/u, ''), title?.[2] ?? '', action];
  });
}

/** Read one exact native message from the opened conversation without accepting an overview preview. */
function conversationMessage(page, id) {
  return page.show('feed').match(new RegExp('<article[^>]*data-shout-id="' + id + '"[^>]*>([^]*?)</article>'))?.[1] ?? '';
}

/** Confirm the fixture's baseline approvals through the real person-view channel. */
async function confirmBaseline(view, repo) {
  const id = await boardId(view, repo);
  const reply = await fetchLive(view.base + '/api/v1/boards/' + id + '/moves', {
    method: 'POST', headers: { 'content-type': 'application/json', 'x-pullboard-key': view.key },
    body: JSON.stringify({ verb: 'spec-approve', args: { ids: 'G1,G2' } }),
  });
  assert.equal(reply.status, 200, 'the real private view confirms the baseline G1/G2 approvals');
}

test('every Rulings surface follows the shared builder [N26,A9]', async () => {
  const box = machine();
  const alpha = project(box, 'builder substitution', `${SPEC}- G3 [pending] Raw board question. | gate: review\n- G4 [draft, aim] Raw board draft. | gate: review\n`);
  await box.inProcess(alpha.repo, 'shout', 'person', 'Raw board decision?', '--decision');
  await box.inProcess(alpha.repo, 'hold', 'web', '--reason', 'Raw board hold');
  const view = await startView(box);
  try {
    await confirmBaseline(view, alpha.repo);
    const page = await openPage(view);
    page.run("openTab('items'); render();");
    const calls = [
      { kind: 'decision', id: 701, ref: 'reviewer', text: 'Builder decision one?', what: 'decision' },
      { kind: 'decision', id: 702, ref: 'reviewer', text: 'Builder decision two?', what: 'decision' },
      { kind: 'pending', id: 'S701', ref: 'S701', text: 'Builder question one.', what: 'answer in SPEC.md' },
      { kind: 'pending', id: 'S702', ref: 'S702', text: 'Builder question two.', what: 'answer in SPEC.md' },
      { kind: 'hold', id: 'builder-lane', ref: 'builder-lane', text: 'Builder hold.', what: 'lane held by builder' },
      { kind: 'draft', id: 'drafts', count: 7, ref: '7', text: 'draft spec rows to approve or drop', what: 'review in SPEC.md', target: 'tab:spec' },
    ];
    assert.deepEqual(JSON.parse(page.run('JSON.stringify(personNeeds(data.project).map(row => row.kind))')),
      ['decision', 'pending', 'hold', 'draft'], 'the real raw board disagrees with the substituted list and counts');
    await page.run(`globalThis.builderCalls = ${JSON.stringify(calls)}; personNeeds = () => builderCalls; refresh();`);
    assert.deepEqual(JSON.parse(page.run('JSON.stringify(projectNeeds(data.project))')), calls,
      'the combined-project list follows exactly the substituted builder');
    assert.deepEqual(needEntries(page.show('needs')), [
      ['decide:701', '#701', 'Builder decision one?', 'Asked by reviewer', 'Your decision'],
      ['decide:702', '#702', 'Builder decision two?', 'Asked by reviewer', 'Your decision'],
      ['spec:S701', 'S701', 'Builder question one.', 'answer in SPEC.md', 'Review'],
      ['spec:S702', 'S702', 'Builder question two.', 'answer in SPEC.md', 'Review'],
      ['tab:shouts', 'builder-lane', 'Builder hold.', 'lane held by builder', 'Review'],
      ['tab:spec', null, '7 draft spec rows to approve or drop', 'In the Spec tab, one by one or a section at a time', 'Review'],
    ], 'the actual panel follows all returned calls, their order and draft multiplicity');
    assert.equal(page.element('needs').hidden, false);
    assert.deepEqual(JSON.parse(page.run('JSON.stringify((({decisions,pending,holds,drafts}) => ({decisions,pending,holds,drafts}))(boardSummary({},data.project)))')),
      { decisions: 2, pending: 2, holds: 1, drafts: 7 }, 'summary counts come from the substituted builder');
    assert.equal(projectRows(page.show('proj-list')).find(row => row.root === alpha.repo)?.needs, '12',
      'the refreshed sidebar counts the same calls, including all seven draft rows');
    assert.equal(page.run('document.title'), '(12) builder substitution · Pullboard');
    await page.run('builderCalls = []; refresh();');
    assert.deepEqual(JSON.parse(page.run('JSON.stringify(projectNeeds(data.project))')), []);
    assert.deepEqual(needEntries(page.show('needs')), [], 'the panel clears when the shared builder returns no calls');
    assert.match(page.show('needs'), /<li class="needs-quiet">[^]*<b>Nothing to rule on\.<\/b> <span class="needs-quiet-note">When a decision is yours, it shows up here and on your phone\.<\/span>/u, '#6608: the top of Items is one quiet line');
    assert.equal(page.element('needs').hidden, false);
    assert.deepEqual(JSON.parse(page.run('JSON.stringify((({decisions,pending,holds,drafts}) => ({decisions,pending,holds,drafts}))(boardSummary({},data.project)))')),
      { decisions: 0, pending: 0, holds: 0, drafts: 0 });
    assert.equal(projectRows(page.show('proj-list')).find(row => row.root === alpha.repo)?.needs, '');
    assert.equal(page.run('document.title'), 'builder substitution · Pullboard');
  } finally {
    await view.stop();
  }
});

test('a local relay-health Rulings entry is an inspection with no release or hold action [N26]', { timeout: 180_000 }, async (t) => { // budget: private board/API startup and one real Chrome rendering pass; no throughput claim.
  const executable = chromeExecutable();
  assert.ok(executable, 'Chrome is required for the relay-health Rulings inspection check.');
  const box = machine();
  project(box, 'relay health inspection');
  const view = await startView(box);
  const profile = mkdtempSync(join(tmpdir(), 'pullboard-relay-health-needs-'));
  let chrome;
  const text = 'relay degraded since 10:30; your moves are queued locally (2)';
  const nextStep = 'the last canary probe failed during pull (RELAY_READ); inspect pullboard relay canary';
  try {
    chrome = await openSnapshotChrome(executable, view.link.href, profile);
    await chrome.waitFor("typeof data === 'object' && data?.project && document.querySelector('#needs')");
    await chrome.stable("(() => { keep('pb.firstrun.' + view.root, 'hidden'); render(); return true; })()");
    // Inject the declared shared-builder output, independent of which API release supplies that field.
    const call = { kind: 'relay-health', id: 'relay-canary', ref: 'relay', text, what: nextStep,
      at: new Date().toISOString(), target: 'relay:relay-canary' };
    await chrome.stable(`(() => {
      globalThis.builderCalls = ${JSON.stringify([call])};
      personNeeds = () => builderCalls;
      render();
      return true;
    })()`);
    // The /live-style Dashboard draws no Rulings card (#6847); the Items list carries the row.
    await chrome.click('document.querySelector("[data-tab=items]")');
    await chrome.waitFor(`Array.from(document.querySelectorAll('#needs .needs-call')).some(row => row.textContent.includes(${JSON.stringify(text)}))`);
    const rendered = JSON.parse(await chrome.stable(`JSON.stringify((() => {
      const row = [...document.querySelectorAll('#needs .needs-call')].find(entry => entry.textContent.includes(${JSON.stringify(text)}));
      return row ? {
        target: row.querySelector('[data-go]')?.dataset.go ?? null,
        ref: row.querySelector('.needs-id')?.textContent ?? null,
        title: row.querySelector('.needs-copy b').textContent,
        need: row.querySelector('.needs-copy small').textContent,
        action: row.querySelector('.needs-action').textContent,
        hasAge: !!row.querySelector('.needs-age time'),
      } : null;
    })())`));
    assert.deepEqual(rendered, {
      target: null,
      ref: 'relay',
      title: `relay${text}`,
      need: 'Keep working; your moves wait here until the connection to your phone is back.',
      action: 'Inspect',
      hasAge: true,
    }, 'Items shows an age-stamped inspection step and does not turn the health alert into a shouts/hold link');
    assert.deepEqual(chrome.exceptions, [], 'the actual page renders the new Rulings kind without exceptions');
  } finally {
    if (chrome) await closeSnapshotChrome(chrome);
    rmSync(profile, { recursive: true, force: true });
    await view.stop();
  }
});

test("the page's Rulings comes from the shared builder [N26]", { timeout: 180_000 }, async (t) => { // budget: hang ceiling for private board/API setup and the two real browser modes, not a throughput claim.
  const box = machine();
  const alpha = project(box, 'shared needs', `${SPEC}- G3 [pending] Choose the greeting. | gate: review\n- G4 [draft, must] Keep the footer. | gate: review\n- G5 [draft, aim] Keep the header. | gate: review\n`);
  await box.inProcess(alpha.repo, 'shout', 'person', 'Ship the greeting?', '--decision');
  await box.inProcess(alpha.web, 'shout', 'coordinator', 'An agent-only question?', '--decision', '--kind', 'question');
  await box.inProcess(alpha.repo, 'hold', 'web', '--reason', 'Wait for the greeting decision');
  const view = await startView(box);
  let snapshotHost, relayServer, chrome;
  const profiles = [];
  try {
    await confirmBaseline(view, alpha.repo);
    const id = await boardId(view, alpha.repo);
    const approved = await fetchLive(view.base + '/api/v1/boards/' + id + '/moves', {
      method: 'POST', headers: { 'content-type': 'application/json', 'x-pullboard-key': view.key },
      body: JSON.stringify({ verb: 'spec-approve', args: { ids: 'G5' } }),
    });
    assert.equal(approved.status, 200, 'the real private view records the person approval');
    const state = await boardOf(view, alpha.repo);
    const expected = personNeeds(state);
    assert.deepEqual(state.needs, expected, 'the actual API carries the shared builder output after pending person decisions');
    assert.deepEqual(expected.map(row => [row.kind, row.id, row.count ?? null]), [
      ['decision', 1, null], ['pending', 'G3', null], ['hold', 'web', null], ['draft', 'drafts', 1],
    ], 'agent questions and already-approved rows are excluded; the remaining draft count is exact');
    const page = await openPage(view);
    page.run("openTab('items'); render();");
    assert.deepEqual(JSON.parse(page.run('JSON.stringify(projectNeeds(data.project))')), expected, 'the live page uses the same builder');
    assert.equal(needEntries(page.show('needs')).length, expected.length, 'the panel has one row per shared entry');
    assert.deepEqual(JSON.parse(page.run('JSON.stringify((({decisions,pending,holds,drafts}) => ({decisions,pending,holds,drafts}))(boardSummary({},data.project)))')),
      { decisions: 1, pending: 1, holds: 1, drafts: 1 }, 'summary counts describe those same entries');
    assert.equal(page.run('document.title'), '(4) shared needs · Pullboard');
    assert.ok(needEntries(page.show('needs')).some(row => row[3] === 'lane held by coordinator'), 'the hold retains its human-readable attribution');

    const output = join(box.dir, 'needs-export');
    await box.inProcess(alpha.repo, 'view', '--export', output);
    const listing = JSON.parse(readFileSync(join(output, 'api/v1/boards.json'), 'utf8'));
    const exported = JSON.parse(readFileSync(join(output, 'api/v1/boards', listing.boards[0].id, 'state.json'), 'utf8')).state;
    assert.deepEqual(exported.needs, expected, 'the real export carries the same calls');
    const executable = chromeExecutable();
    if (!executable) return t.skip('Install Chrome or set PULLBOARD_CHROME for exported and relay page parity.');
    snapshotHost = await serveFolder(output, '/snapshot/');
    // This transport reads the real isolated API; no board state or Rulings result is mocked.
    const transport = `export async function createTransport() { return { async request(path) { const reply = await fetch('/upstream' + path); if (!reply.ok) throw new Error('private board read failed'); return reply.json(); } }; }`;
    relayServer = createServer(async (request, response) => {
      const url = new URL(request.url, 'http://127.0.0.1');
      try {
        if (url.pathname === '/') return response.writeHead(200, { 'content-type': 'text/html' }).end(cockpitPage('', { readOnly: true, transportModule: '/transport.js', stylesheet: '/view.css' }));
        if (url.pathname === '/transport.js') return response.writeHead(200, { 'content-type': 'text/javascript' }).end(transport);
        if (url.pathname === '/view.css') return response.writeHead(200, { 'content-type': 'text/css' }).end(readFileSync(new URL("../../../view/src/io/main.css", import.meta.url)));
        if (url.pathname.startsWith('/upstream/')) {
          const reply = await fetchLive(view.base + url.pathname.slice('/upstream'.length) + url.search, { headers: { 'x-pullboard-key': view.key } });
          return response.writeHead(reply.status, { 'content-type': 'application/json' }).end(await reply.text());
        }
        response.writeHead(404).end();
      } catch { response.writeHead(500).end('private API unavailable'); }
    });
    await new Promise(resolve => relayServer.listen(0, '127.0.0.1', resolve));
    for (const [mode, address] of [['export', snapshotHost.base + '/snapshot/'], ['relay page', 'http://127.0.0.1:' + relayServer.address().port + '/']]) {
      const profile = mkdtempSync(join(tmpdir(), 'pullboard-shared-needs-')); profiles.push(profile);
      chrome = await openSnapshotChrome(executable, address, profile);
      await chrome.waitFor("data?.project?.needs?.length === 4");
      assert.equal(await chrome.stable('view.tab'), 'dashboard', mode + ' opens on Dashboard');
      await chrome.click('document.querySelector("[data-tab=items]")');
      await chrome.waitFor("data?.project?.needs?.length === 4 && document.querySelectorAll('#needs .needs-call').length === 4");
      assert.deepEqual(JSON.parse(await chrome.stable('JSON.stringify(projectNeeds(data.project))')), expected, mode + ' computes identical entries');
      assert.deepEqual(JSON.parse(await chrome.stable('JSON.stringify([...document.querySelectorAll("#needs .needs-copy b")].map(row => row.textContent))')),
        ['G3Choose the greeting.', '#1Ship the greeting?', 'webWait for the greeting decision', '1 draft spec rows to approve or drop'], mode + ' renders the same calls');
      await chrome.stable(`localStorage.setItem(${JSON.stringify(mode === 'export' ? 'snapshot.pb.tab' : 'pb.tab')}, 'home'); history.replaceState(history.state, '', location.pathname + location.search)`);
      await chrome.send('Page.reload');
      await chrome.waitFor("data?.project?.needs?.length === 4 && view.tab === 'dashboard'");
      assert.equal(await chrome.stable(`localStorage.getItem(${JSON.stringify(mode === 'export' ? 'snapshot.pb.tab' : 'pb.tab')})`), 'dashboard', mode + ' migrates saved Home state');
      await chrome.send('Page.navigate', { url: address + '#home' });
      await chrome.waitFor("view.tab === 'dashboard' && data?.project?.needs?.length === 4");
      assert.equal(await chrome.stable('location.hash'), '#dashboard', mode + ' normalizes legacy Home links');
      assert.deepEqual(chrome.exceptions, [], mode + ' has no uncaught exception');
      await closeSnapshotChrome(chrome); chrome = null;
    }
  } finally {
    if (chrome) await closeSnapshotChrome(chrome);
    if (relayServer) await new Promise(resolve => relayServer.close(resolve));
    if (snapshotHost) await snapshotHost.close();
    for (const profile of profiles) rmSync(profile, { recursive: true, force: true });
    await view.stop();
  }
});

test('a person-only block shows in Rulings with its one step [N26]', async () => {
  const box = machine();
  const alpha = project(box, 'person block');
  box.env.CLAUDECODE = '1';
  const refused = await runCliInProcess(['answer', '1', 'yes', '--as', 'person'], { cwd: alpha.repo, env: box.env });
  delete box.env.CLAUDECODE;
  assert.equal(refused.status, 1, refused.stderr);
  assert.match(refused.stderr, /only the person can clear this/u);

  const view = await startView(box);
  try {
    const page = await openPage(view);
    page.run("openTab('items'); render();");
    const state = await boardOf(view, alpha.repo);
    assert.equal(state.blocks.length, 1, 'the live API supplies the person-only block list');
    assert.equal(state.blocks[0].audience, 'person');
    const entries = needEntries(page.show('needs'));
    assert.deepEqual(entries, [[null, 'blocked', 'Pullboard stopped a request that only you can clear: this terminal belongs to an agent',
      'Ask your coordinator to take the next step.', 'Next step']], 'the view shows the plain reason and the exact API step without a bogus release action');
    assert.doesNotMatch(page.show('needs'), /B26_PERSON_CHANNEL|--as|pullboard answer/u,
      'the view does not expose the rule code or refused command');

    // Model #1077's API result after a successful matching move: the view follows the returned list instead of
    // maintaining its own clear rule or editing the ledger.
    page.run(`globalThis.realFetch = fetch;
globalThis.hidePersonBlocks = false;
globalThis.fetch = async function controlledStateFetch(path, init) {
  const reply = await globalThis.realFetch(path, init);
  if (!globalThis.hidePersonBlocks || !String(path).includes('/state')) return reply;
  const body = await reply.json();
  if (!body.state) throw new Error('the test expected a fresh board-state response');
  body.state.blocks = [];
  return { ok: reply.ok, status: reply.status, headers: reply.headers, json: async () => body };
};`);
    page.run('globalThis.hidePersonBlocks = true; sentStates.clear();');
    await page.run('refresh()');
    assert.equal(needEntries(page.show('needs')).some(entry => entry[2].includes('Pullboard stopped a request')), false,
      'the row disappears when the next API state no longer lists the block');
  } finally {
    await view.stop();
  }
});


test('a decision waits in needs-you until the view answers it [B21, B26, N27]', async () => {
  const box = machine();
  const alpha = project(box, 'alpha');
  await box.inProcess(alpha.web, 'shout', 'coordinator', 'Greet in <b>French</b> first?', '--decision', '--kind', 'question');
  // Forty shouts after it: the ask is older than every shout the feed loads, and still waits.
  for (let n = 0; n < 40; n += 1) await box.inProcess(alpha.web, 'shout', 'all', `note ${n}`);
  // Another project's board numbers its shouts from 1 too.
  const beta = project(box, 'beta');
  await box.inProcess(beta.web, 'shout', 'coordinator', 'Beta asks too?', '--decision', '--kind', 'question');
  const view = await startView(box);
  try {
    const page = await openPage(view);
    page.run("openTab('items'); render();");
    // Deliberately age the ask past a minute; gate load must not decide its label.
    const askedAt = page.run('Date.parse(data.project.asked.find(shout => shout.shout_id === 1).shout_at)');
    page.run(`Date.now = () => ${askedAt + 61_000}; render();`);
    // The question as the page escapes it, written as a pattern.
    const question = 'Greet in &lt;b&gt;French&lt;/b&gt; first\\?';
    // An agent asks its coordinator (B25): the ask waits on the board with who holds it, never in Rulings.
    assert.doesNotMatch(page.show('needs'), /decide:/, "an agent's ask is its coordinator's to answer");
    page.run("openTab('shouts'); render();");
    assert.equal(page.element('decisions').hidden, true, 'an ask waiting on others stays folded');
    assert.match(page.show('page-controls'), /data-value="questions"[^>]*>Questions<b>1<\/b>/,
      'the shared Questions segment retains the one native pending ask');
    page.run("view.shoutFilter = 'questions'; view.shoutThread = 'none'; render();");
    const waitingMessage = conversationMessage(page, 1);
    assert.match(waitingMessage, /<b class="who"[^>]* title="Test Model">web-1<\/b><span class="to">→ <span[^>]*>coordinator<\/span><\/span>/,
      'the opened native question retains its exact author, model hover and recipient');
    assert.match(waitingMessage, new RegExp('<div class="text">' + question + '</div>'), 'its entire escaped question remains visible');
    assert.match(waitingMessage, /<div class="band">Decision needed<\/div>/, 'the native pending status is retained');
    assert.doesNotMatch(waitingMessage, /data-go="decide:/, 'an agent question has no person Answer control');


    // The coordinator passes it up with its note (B27): now it is the person's call.
    await box.inProcess(alpha.repo, 'pass', '1', 'over to you');
    await page.run('refresh()');
    const passedAt = page.run('Date.parse(data.project.decisions.find(shout => shout.shout_id === 42).shout_at)');
    page.run(`Date.now = () => ${passedAt + 61_000}; render();`);
    page.run("openTab('items'); render();");
    const passed = `Passed up from web-1: ${question}\nCoordinator note: over to you`;
    assert.deepEqual(needEntries(page.show('needs')), [['decide:42', '#42', 'Passed up from web-1: Greet in &lt;b&gt;French&lt;/b&gt; first?', 'Asked by coordinator', 'Your decision']], "the person's call identifies its source, question and action");
    assert.ok(page.show('needs').includes('Passed up from web-1: Greet in &lt;b&gt;French&lt;/b&gt; first?<br>Coordinator note: over to you'), 'expanded details preserve the entire passed question and coordinator note');
    assert.match(page.show('needs'), /<span class="needs-age"><time data-ago="[^"]+">1m<\/time><\/span>/u, 'the call retains its actual one-minute age');
    page.run("openTab('shouts'); render();");
    page.run("view.shoutThread = 'none'; render();");
    const passedMessage = conversationMessage(page, 42);
    assert.match(passedMessage, /<b class="who"[^>]* title="[^"]*">coordinator<\/b><span class="to">→ you<\/span>/,
      'the passed native call retains its coordinator author and person recipient');
    assert.match(passedMessage, new RegExp('<div class="text">' + passed.replace('\n', '<br>') + '</div>'),
      'the conversation keeps the complete passed question and coordinator note');
    assert.match(passedMessage, /data-go="decide:42"/, 'the real passed call retains its Answer action');
    assert.equal(page.element('decisions').hidden, true, 'the superseded decisions wall stays hidden');


    const form = () => ({
      answering: !page.element('answering').hidden,
      who: page.element('answering-who').textContent,
      question: page.element('answering-q').textContent,
      to: page.element('shout-to').value,
      locked: Boolean(page.element('shout-to').disabled),
      button: page.element('shout-send').getAttribute('aria-label'),
    });
    page.element('shout-to').value = 'web';
    await page.click({ go: 'decide:42' });
    assert.equal(page.run('view.tab'), 'shouts');
    assert.deepEqual(form(), { answering: true, who: 'coordinator', question: 'Passed up from web-1: Greet in <b>French</b> first?\nCoordinator note: over to you', to: 'coordinator', locked: true, button: 'Answer' }, 'Answer turns the form to answering the one who asked');
    await page.fire('answer-cancel', 'click');
    assert.deepEqual(form(), { answering: false, who: '', question: '', to: 'web', locked: false, button: 'Shout' }, 'Cancel gives back the plain shout');

    await page.click({ go: 'decide:42' });
    page.element('shout-text').value = 'French, then English';
    await page.fire('shout-form', 'submit');
    assert.equal(page.element('console').textContent.split('\n')[0], '$ pullboard answer 42 French, then English --as person', 'the view answers as the person');
    assert.equal(page.element('console').className, 'console ok');
    const replies = JSON.parse(await box.inProcess(alpha.web, 'inbox', '--json')).shouts.filter((shout) => shout.shout_answers === 1);
    assert.deepEqual(replies.map((shout) => [shout.shout_from, shout.shout_to, shout.shout_answers, shout.shout_text]),
      [['person', 'web-1', 1, 'Person answered #42: French, then English']], 'the answer reaches the agent that asked');
    assert.deepEqual(form(), { answering: false, who: '', question: '', to: 'web', locked: false, button: 'Shout' }, 'the form is a plain shout again');
    assert.equal(page.element('shout-text').value, '');
    page.run("openTab('items'); render();");
    assert.doesNotMatch(page.show('needs'), /decide:/, 'an answered decision leaves Rulings');
    page.run("openTab('shouts'); render();");
    assert.equal(page.element('decisions').hidden, true, 'and the banner');

    await box.inProcess(alpha.web, 'shout', 'coordinator', 'Ship today?', '--decision', '--kind', 'question');
    await box.inProcess(alpha.repo, 'pass', '45', 'yours');
    await page.run('refresh()');
    page.run("openTab('shouts'); view.shoutThread = 'none'; render();");
    const feed = shoutNameText(page.show('feed'));
    assert.match(feed, /<b class="who"[^>]* title="Test Model">web-1<\/b><span class="to">→ <span[^>]*>coordinator<\/span><\/span><span class="mark ask" role="group" title="decision" aria-label="decision">decision<\/span> <time [^>]*>[^<]*<\/time><\/header><div class="text">Ship today\?<\/div>/, 'the feed marks an ask');
    assert.match(feed, /<b class="who"[^>]* title="unknown">you<\/b><span class="to">→ <span[^>]*>coordinator<\/span><\/span><span class="mark" role="group" title="answer" aria-label="answer">answer<\/span> <time [^>]*>[^<]*<\/time><\/header><div class="text">French, then English<\/div>/, 'and an answer');
    page.run("openTab('items'); render();");
    assert.match(page.show('needs'), /data-go="decide:46"/);

    // An answer belongs to the project whose question it shows.
    await box.inProcess(beta.repo, 'pass', '1', 'yours too');
    const plain = { answering: false, who: '', question: '', to: 'web', locked: false, button: 'Shout' };
    await page.click({ go: 'decide:46' });
    // The new project's board is held back, so this is the form the moment the switch is made.
    page.run('globalThis.plain = fetch; globalThis.fetch = (path, init) => new Promise((done) => { globalThis.resume = done; }).then(() => plain(path, init));');
    await page.click({ root: beta.repo });
    assert.deepEqual(form(), plain, 'leaving the project leaves answer mode at once');
    page.run('globalThis.fetch = plain; resume();');
    // A first read of a board takes the state the server keeps, from before its latest writes [A2,C7]; the live page's
    // stream then catches up by a delta. This page has no stream, so let the switch's read land, then catch up as it does.
    await page.release();
    await page.run('refresh()');
    await page.click({ go: 'decide:2' });
    assert.equal(form().question, 'Passed up from web-1: Beta asks too?\nCoordinator note: yours too');
    await page.run(`view.root = ${JSON.stringify(alpha.repo)}; seen = ''; refresh()`);
    assert.deepEqual(form(), plain, 'and so does a board drawn for another project');
    await page.run(`view.root = ${JSON.stringify(beta.repo)}; seen = ''; refresh()`);
    await page.click({ go: 'decide:2' });
    page.run(`view.root = ${JSON.stringify(alpha.repo)}`);
    page.element('shout-text').value = 'yes';
    await page.fire('shout-form', 'submit');
    assert.deepEqual(form(), plain, 'an answer is never sent to another project');
    assert.equal(page.element('console').textContent.split('\n')[0], '$ pullboard answer 42 French, then English --as person', 'nothing ran');
    /** Read the still-open decision by stable identity, independently of display-name formatting. */
    const decisionsOf = async (repo, id) => JSON.parse(await box.inProcess(repo, 'decisions', '--as', 'person', '--json')).decisions
      .filter((shout) => shout.shout_id === id).map((shout) => [shout.shout_from, shout.shout_to, shout.shout_text]);
    const betaDecisions = await decisionsOf(beta.repo, 2);
    assert.deepEqual(betaDecisions, [['coordinator', 'person', 'Passed up from web-1: Beta asks too?\nCoordinator note: yours too']], "beta's ask still waits");
    const alphaDecisions = await decisionsOf(alpha.repo, 46);
    assert.deepEqual(alphaDecisions, [['coordinator', 'person', 'Passed up from web-1: Ship today?\nCoordinator note: yours']], "and so does alpha's");
  } finally {
    await view.stop();
  }
});
test("needs-you holds only the person's calls; the rest show on the board with who holds them [B26, N26]", async () => {
  const box = machine();
  const alpha = project(box, 'alpha', `${SPEC}- G3 [pending] Greet in French? | gate: review\n- G4 [draft, aim] A footer on every page. | gate: review\n`);
  await box.inProcess(alpha.repo, 'add', 'web', 'Greeting', '--specs', 'G1', '--criterion', 'greets');
  await box.inProcess(alpha.repo, 'add', 'web', 'Farewell', '--specs', 'G2', '--criterion', 'says goodbye');
  build(box, alpha, 1, 'greeting.html');
  build(box, alpha, 2, 'farewell.html');
  sendBack(box, alpha, 2, 'no farewell yet');
  await box.inProcess(alpha.web, 'shout', 'coordinator', 'Which colour for the button?', '--decision', '--kind', 'question');
  await box.inProcess(alpha.repo, 'shout', 'person', 'Launch on Friday?', '--decision');
  await box.inProcess(alpha.repo, 'hold', 'web', '--reason', 'G3 is open');
  const view = await startView(box);
  try {
    await confirmBaseline(view, alpha.repo);
    const page = await openPage(view);
    page.run("openTab('items'); render();");
    const needs = page.show('needs');
    assert.deepEqual(needEntries(needs).map(([go, ref, words]) => [go.split(':')[0], ref, words]), [
      ['spec', 'G3', 'Greet in French?'],
      ['decide', '#2', 'Launch on Friday?'],
      ['tab', 'web', 'G3 is open'],
      ['tab', null, '1 draft spec rows to approve or drop'],
    ], "the person's calls, and only those: the decision asked of them, the spec's question, the held lane, the draft row");
    assert.equal(needEntries(needs).find(entry => entry[0]?.startsWith('decide:'))[3], 'Asked by coordinator', 'a decision says below who asked it');
    assert.doesNotMatch(needs, /Which colour|Greeting|Farewell/, "an agent's ask, work waiting for a verdict and work sent back are not the person's");
    assert.match(needs, /<span class="needs-id"(?: title="[^"]*")?>web<\/span>G3 is open<\/b><small>lane held by coordinator<\/small>[\s\S]*?<span class="needs-age"><time data-ago="[^"]+">(?:now|\d+[mhd])<\/time>/u, 'a held lane says who set it and shows the API-provided hold age');

    // Each of the rest is on the board, with who holds it.
    page.run("openTab('shouts'); view.shoutFilter = 'questions'; view.shoutThread = 'none'; render();");
    assert.match(page.show('feed'), /<b class="who"[^>]* title="Test Model">web-1<\/b><span class="to">→ <span[^>]*>coordinator<\/span><\/span>/,
      "the native agent question waits on its coordinator in the Questions conversation");
    page.run("openTab('items'); render();");
    assert.match(itemRow(page.show('chain'), 1), /<b class="stage-word">In review<\/b>/, 'work waiting for a verdict keeps its approved stage');
    assert.match(itemRow(page.show('chain'), 1), /<small class="stage-detail" title="awaiting a verdict">awaiting a verdict<\/small>/, 'unassigned submitted work retains its truthful detail below the stage');
    assert.ok(itemRow(page.show('chain'), 2).includes('<b class="item-reason"><span title="BEHAVIOR_MISMATCH">Behavior did not match</span></b> <span class="why">no farewell yet'), 'and work sent back, with why');
    page.run("openTab('shouts'); view.agent = 'web-1'; render();");
    assert.deepEqual(agentEntries(page.show('agents')).find((agent) => agent.id === 'web-1').holds, ['#2 Farewell: Gated · Lane held · Sent back', '#1 Greeting: In review'], 'the agent retains both built items, with the shared stages and every applicable mark');
    page.run('view.agent = null; render();');
    assert.match(page.show('lanes'), /<b>web<\/b> <span class="chip no" title="held by coordinator">held by coordinator<\/span> <span class="muted">G3 is open<\/span>/, 'a held lane names who holds it');

    // The sidebar counts exactly the person's calls; its line still says what the agents are doing.
    assert.deepEqual(projectRows(page.show('proj-list')).map((row) => [row.needs, row.line]), [['4', '1 decision · 1 question · 1 draft row · 1 lane held · 1 sent back · 1 to verify']]);
    assert.equal(page.run('document.title'), '(4) alpha · Pullboard');
  } finally {
    await view.stop();
  }
});

test('needs-you lines keep their titles on a phone [N26]', async () => {
  const box = machine();
  const alpha = project(box, 'alpha', `${SPEC}- G3 [pending] Should a greeting with a title long enough to need the room wrap? | gate: review\n`);
  const view = await startView(box);
  try {
    await confirmBaseline(view, alpha.repo);
    const page = await openPage(view, { width: 375 });
    page.run("openTab('items'); render();");
    const style = await styleOf(view);
    // The shared summary keeps its reference and one-line title, with context below and action at the right.
    assert.match(style, /\.needs-copy b, \.needs-copy small \{[^}]*overflow: hidden; text-overflow: ellipsis; white-space: nowrap;/u, 'both summary lines truncate within the phone width');
    assert.deepEqual(needEntries(page.show('needs')), [['spec:G3', 'G3', 'Should a greeting with a title long enough to need the room wrap?', 'Answer it in the Spec tab.', 'Review']]);
  } finally {
    await view.stop();
  }
});

test('rulings and the asks sit in their lists [N26]', { timeout: 180_000 }, async (t) => {
  const executable = chromeExecutable();
  if (!executable) return t.skip('Install Chrome or set PULLBOARD_CHROME for Rulings and Shouts checks.');
  const box = machine();
  const spec = `${SPEC}- G3 [pending] Should the greeting name the visitor? | gate: review\n- G4 [draft, must] The footer links home. | gate: web test\n- G5 [draft, aim] The header stays put. | gate: web test\n`;
  const alpha = project(box, 'asks', spec);
  await box.inProcess(alpha.repo, 'add', 'web', 'Greeting', '--specs', 'G1', '--criterion', 'greets');
  await box.inProcess(alpha.repo, 'add', 'web', 'Farewell', '--specs', 'G2', '--criterion', 'says goodbye');
  await box.inProcess(alpha.web, 'claim', '1');
  const second = join(box.dir, 'asks-web-2');
  box.git(alpha.repo, 'worktree', 'add', '-q', second, '-b', 'web/asks2');
  await box.inProcess(second, 'join', 'web');
  // The person's calls: a decision passed up to them, the spec's open question, a held lane and two draft rows. And an
  // agent's ask that waits on its coordinator, not on the person.
  await box.inProcess(alpha.web, 'shout', 'coordinator', 'Which colour for the button?', '--decision', '--kind', 'question');
  await box.inProcess(alpha.repo, 'pass', '1', 'over to you');
  await box.inProcess(second, 'shout', 'coordinator', 'Ship the footer first?', '--decision', '--kind', 'question');
  await box.inProcess(alpha.repo, 'hold', 'web', '--reason', 'Freeze for the demo');
  const view = await startView(box);
  const profile = mkdtempSync(join(tmpdir(), 'pullboard-asks-chrome-'));
  let chrome;
  /** Items' head and Shouts' card as they read. */
  const read = async () => JSON.parse(await chrome.stable(`JSON.stringify((() => {
    const box = (e) => { if (!e) return null; const r = e.getBoundingClientRect(); return { left: r.left, right: r.right, top: r.top, bottom: r.bottom, width: r.width, height: r.height }; };
    const shown = (e) => !!e && !e.closest('[hidden]') && e.getBoundingClientRect().height > 0;
    const probe = document.createElement('i'); probe.style.color = 'var(--warn)'; document.body.append(probe); const warn = getComputedStyle(probe).color; probe.remove();
    const needs = document.querySelector('#needs');
    const card = document.querySelector('.shouts-card');
    return {
      page: { width: document.documentElement.clientWidth, scroll: document.documentElement.scrollWidth, body: document.body.scrollWidth },
      needsShown: shown(needs), inList: needs.parentElement === document.querySelector('#chain').parentElement, separateCard: !!document.querySelector('section.rulings-box#needs'),
      needs: [...needs.querySelectorAll('.needs-call')].map((row) => ({ go: row.querySelector('[data-go]')?.dataset.go ?? null, words: row.querySelector('.needs-copy b').textContent, title: [...row.querySelector('.needs-copy b').childNodes].filter(node => node.nodeType === Node.TEXT_NODE).map(node => node.textContent).join(''), ref: row.querySelector('.needs-id')?.textContent ?? null,
        kind: row.querySelector('.needs-copy small').textContent, label: row.classList.contains('needs-drafts') ? !!row.querySelector('.needs-kind-draft') && row.querySelector('.needs-action').textContent === 'Review' : getComputedStyle(row.querySelector('.needs-kind')).color === warn && getComputedStyle(row.querySelector('.needs-action')).color === warn, chip: row.querySelector('.needs-action').textContent, age: !!row.querySelector('.needs-age time') })),
      card: card ? [...card.children].map((e) => e.id || e.className) : null,
      wallsHidden: ['#coordinator-decisions', '#decisions'].every(selector => document.querySelector(selector).hidden && !document.querySelector(selector).textContent),
      composer: box(document.querySelector('.shout-form .composer')), asks: box(document.querySelector('[aria-label="Shouts filter"]')),
      questions: document.querySelector('[data-page-ctl=shouts][data-value=questions]')?.textContent.trim(), selected: document.querySelector('[data-page-ctl=shouts][data-value=questions]')?.getAttribute('aria-pressed'),
      showAgents: box(document.querySelector('.asks-slot [data-agents-toggle]')),
      messages: [...document.querySelectorAll('#feed .shout .text')].map(text => text.textContent),
      feedBar: !!document.querySelector('#feed .feed-bar'), panelShown: shown(document.querySelector('#agents')), hide: !!document.querySelector('.panel-head [data-agents-toggle]'),
      agents: [...document.querySelectorAll('#agents .agent-card')].filter(shown).map((row) => ({ who: row.querySelector('.agent-who b').textContent, model: row.querySelector('.agent-model').textContent, state: row.querySelector('.agent-state').textContent, what: row.querySelector('.agent-doing').textContent.trim(), chipInDoing: !!row.querySelector('.agent-doing .chip'), whatWidth: box(row.querySelector('.agent-what')).width, doingWidth: box(row.querySelector('.agent-doing')).width })),
      okNote: (() => { const c = document.querySelector('#console'); return !!c && !c.hidden && getComputedStyle(c).display !== 'none' && c.classList.contains('ok'); })(),
    };
  })())`));
  const click = (selector) => chrome.click(`document.querySelector(${JSON.stringify(selector)})`);
  try {
    await confirmBaseline(view, alpha.repo);
    chrome = await openSnapshotChrome(executable, view.link.href, profile);
    await chrome.waitFor("typeof data === 'object' && data?.project?.decisions?.length === 1 && data.project.asked.length === 1 && data.project.holds.length === 1");
    for (const scheme of ['light', 'dark']) {
      for (const width of [1280, 375]) {
        await chrome.send('Emulation.setDeviceMetricsOverride', { width, height: 900, deviceScaleFactor: 1, mobile: false });
        await chrome.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: scheme }] });
        await chrome.waitFor(`innerWidth === ${width} && matchMedia('(prefers-color-scheme: ${scheme})').matches`);
        const at = `${width}px ${scheme}`;
        await click('[data-tab=items]');
        await click('[data-tab=items]');
        await chooseFilter(chrome, 'state:active');
        let r = await read();
        assert.ok(r.page.scroll <= r.page.width && r.page.body <= r.page.width, `${at}: no sideways scroll on Items`);
        // The full Needs panel keeps every call, oldest first, in its shared two-line summary.
        assert.deepEqual([r.needsShown, r.inList, r.separateCard], [true, true, false], `${at}: Rulings is the head of the Items list, not a card of its own`);
        assert.deepEqual(r.needs.map(({ go, ref, words, kind, chip }) => [go.split(':')[0], ref, words.includes('Which colour for the button?') ? 'Which colour…' : words, kind, chip]), [
          ['spec', 'G3', 'G3Should the greeting name the visitor?', 'Answer it in the Spec tab.', 'Review'],
          ['decide', '#2', 'Which colour…', 'Asked by coordinator', 'Your decision'],
          ['tab', 'web', 'webFreeze for the demo', 'lane held by coordinator', 'Review'],
          ['tab', null, '2 draft spec rows to approve or drop', 'In the Spec tab, one by one or a section at a time', 'Review'],
        ], `${at}: the person's calls, each a row, the drafts one row with their count`);
        assert.ok(r.needs.every((need) => need.label), `${at}: question icons and action chips use the warning colour, while the draft retains its Review control`);
        assert.deepEqual(r.needs.map((need) => need.age), [false, true, true, false], `${at}: a call that has an age shows it at the right`);

        await click('[data-tab=shouts]');
        await chrome.waitFor("!document.querySelector('[data-pane=shouts]').hidden && !!document.querySelector('#feed .conversation-row')");
        await click('[data-page-ctl=shouts][data-value=questions]');
        await click('#feed [data-shout-thread=\"none\"]');
        await chrome.waitFor("document.querySelectorAll('#feed .shout').length === data.project.shouts.length");
        r = await read();
        assert.ok(r.page.scroll <= r.page.width && r.page.body <= r.page.width, `${at}: no sideways scroll on Shouts`);
        // The original native questions now share the Questions segment and an actual conversation.
        assert.deepEqual(r.card, ['shout-form', 'coordinator-decisions', 'decisions', 'feed'], `${at}: Shouts stays one card`);
        assert.ok(r.wallsHidden, `${at}: the replaced decisions walls carry no content`);
        assert.deepEqual([r.questions, r.selected], ['Questions2', 'true'], `${at}: both native questions are counted in the shared segment`);
        assert.deepEqual(r.messages, ['Which colour for the button?', 'Passed up from web-1: Which colour for the button?Coordinator note: over to you', 'Ship the footer first?'], `${at}: the original question, native person-forward and second question retain their exact bodies and chronological order`);
        assert.equal(r.feedBar, false, `${at}: no bar above the feed while it shows every shout`);
        assert.ok(r.hide && r.panelShown, `${at}: the agents panel carries its own hide`);
        // An agent's row: its name and state in words, then what it holds at the full width.
        const holder = r.agents.find((agent) => agent.who.startsWith('web-1'));
        assert.ok(holder && holder.who === 'web-1' && holder.model === 'Test Model' && /^(?:now|\d+[mhd])Building$/.test(holder.state) && holder.what === '#1 Greeting' && !holder.chipInDoing, `${at}: web-1 keeps its separate model and age beside the shared stage, which does not repeat the agent the row names: ${JSON.stringify(holder)}`);
      }
    }

    // All keeps both original native messages; Questions is a filter, never a duplicate wall.
    await chrome.send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });
    await chrome.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: 'light' }] });
    await chrome.waitFor('innerWidth === 1280');
    await click('[data-page-ctl=shouts][data-value=all]');
    await click('#feed [data-shout-thread="none"]');
    let r = await read();
    assert.deepEqual(r.messages, ['Which colour for the button?', 'Passed up from web-1: Which colour for the button?Coordinator note: over to you', 'Ship the footer first?'], 'All retains both questions and the native person-forward in one conversation');
    // Hidden, the agents come back from the composer's line, after the asks.
    await click('.panel-head [data-agents-toggle]');
    r = await read();
    assert.ok(!r.panelShown && r.showAgents && r.showAgents.left >= r.composer.right, `hidden, Show agents sits on the composer's line: ${JSON.stringify([r.composer, r.showAgents])}`);
    await click('.asks-slot [data-agents-toggle]');
    assert.ok((await read()).panelShown, 'and brings the panel back');
    // A sent shout shows in the feed, as a row or as a card in the open thread; no note pushes into the composer's line.
    await chrome.stable("document.querySelector('#shout-text').focus()");
    await chrome.send('Input.insertText', { text: 'Footer after the greeting.' });
    await click('#shout-send');
    await chrome.waitFor("[...document.querySelectorAll('#feed .conversation-row, #feed .shout')].some((row) => row.textContent.includes('Footer after the greeting.'))", 15_000); // budget: hang ceiling for the sent shout to appear as a conversation row; no throughput claim.
    r = await read();
    assert.equal(r.okNote, false, 'a sent shout is its row, with no note beside the composer');
    // However many calls there are, each is a row: six more decisions make ten rows, none folded into a count.
    for (const n of [1, 2, 3, 4, 5, 6]) await box.inProcess(alpha.repo, 'shout', 'person', `Ship part ${n} today?`, '--decision');
    await click('[data-tab=items]');
    await chrome.waitFor("document.querySelectorAll('#needs .needs-call').length >= 10", 15_000); // budget: hang ceiling for ten native decision rows to appear; no throughput claim.
    r = await read();
    assert.deepEqual([r.needs.length, r.needs.filter((need) => /^Ship part [1-6] today\?$/.test(need.title)).length, r.needs.every((need) => need.label)], [10, 6, true],
      `ten calls, ten rows, each with its kind in the warning colour: ${JSON.stringify(r.needs)}`);
    assert.equal(await chrome.stable("document.querySelector('#needs').textContent.includes('more need you')"), false, 'no call is folded into a count');
    // Narrowed to the unread shouts from the status bar, the feed carries its bar with show all; show all clears it.
    await box.inProcess(alpha.web, 'shout', 'all', 'Greeting is half done.');
    await chrome.waitFor("!document.querySelector('#status-unread')?.hidden", 15_000); // budget: hang ceiling for the unread badge after a new shout; no throughput claim.
    await click('#status-unread');
    await chrome.waitFor("view.tab === 'shouts' && !!document.querySelector('#feed .feed-bar')");
    assert.match(await chrome.stable("document.querySelector('#feed .feed-bar').textContent"), /^\d+ unread\s*show all$/, 'narrowed to the unread shouts, the feed carries its bar with show all');
    await click('#feed [data-unread]');
    assert.equal((await read()).feedBar, false, 'show all brings back every shout and clears the bar');
    // Under In review, or a lane, the list is narrowed and Rulings steps aside.
    await click('[data-tab=items]');
    await chooseFilter(chrome, 'state:verify');
    assert.equal((await read()).needsShown, false, 'under In review, Rulings steps aside');
    await click('[data-tab=items]');
    await chooseFilter(chrome, 'state:active');
    assert.deepEqual(chrome.exceptions, [], 'the page raises no uncaught exception');
  } finally {
    if (chrome) await closeSnapshotChrome(chrome);
    rmSync(profile, { recursive: true, force: true });
    await view.stop();
  }
});
