/** @pullboard-test-input source-tree */
/** @pullboard-test-gui */
/** Cockpit needs checks, using the shared real-board fixtures [N26]. */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { BIN, SPEC, machine, project, build, sendBack, startView, styleOf, element, openPage, projectRows, agentEntries, needEntries, itemRow, shoutNameText, chromeExecutable, openSnapshotChrome, closeSnapshotChrome, chooseFilter, boardId, boardOf, fetchLive, serveFolder } from './fixture.js';
import { cockpitPage } from '../../src/cockpit.js';
import { runFixtureChild } from '../fixture-child.js';
import { approvalAgentApi, approvalReadGate } from './agent-approval-fixture.js';
import { personNeeds } from '../../src/needs.js';

/** Confirm the fixture's baseline approvals through the real person-view channel. */
async function confirmBaseline(view, repo) {
  const id = await boardId(view, repo);
  const reply = await fetchLive(view.base + '/api/v1/boards/' + id + '/moves', {
    method: 'POST', headers: { 'content-type': 'application/json', 'x-pullboard-key': view.key },
    body: JSON.stringify({ verb: 'spec-approve', args: { ids: 'G1,G2' } }),
  });
  assert.equal(reply.status, 200, 'the real private view confirms the baseline G1/G2 approvals');
}

test('every Needs-you surface follows the shared builder [N26,A9]', async () => {
  const box = machine();
  const alpha = project(box, 'builder substitution', `${SPEC}- G3 [pending] Raw board question. | gate: review\n- G4 [draft, aim] Raw board draft. | gate: review\n`);
  box.run(alpha.repo, 'shout', 'person', 'Raw board decision?', '--decision');
  box.run(alpha.repo, 'hold', 'web', '--reason', 'Raw board hold');
  const view = await startView(box);
  try {
    await confirmBaseline(view, alpha.repo);
    const page = await openPage(view);
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
      ['decide:701', null, 'Builder decision one?', 'a decision, asked by reviewer', 'decide'],
      ['decide:702', null, 'Builder decision two?', 'a decision, asked by reviewer', 'decide'],
      ['spec:S701', 'S701', 'Builder question one.', 'an open question in SPEC.md', 'answer'],
      ['spec:S702', 'S702', 'Builder question two.', 'an open question in SPEC.md', 'answer'],
      ['tab:shouts', 'builder-lane', 'Builder hold.', 'lane held by builder', 'release'],
      ['tab:spec', '7', 'draft spec rows to approve or drop', 'Spec rows waiting on you', 'review'],
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
    assert.equal(page.element('needs').hidden, true);
    assert.deepEqual(JSON.parse(page.run('JSON.stringify((({decisions,pending,holds,drafts}) => ({decisions,pending,holds,drafts}))(boardSummary({},data.project)))')),
      { decisions: 0, pending: 0, holds: 0, drafts: 0 });
    assert.equal(projectRows(page.show('proj-list')).find(row => row.root === alpha.repo)?.needs, '');
    assert.equal(page.run('document.title'), 'builder substitution · Pullboard');
  } finally {
    await view.stop();
  }
});

test('a local relay-health Needs-you entry is an inspection with no release or hold action [N26]', { timeout: 180_000 }, async (t) => { // budget: private board/API startup and one real Chrome rendering pass; no throughput claim.
  const executable = chromeExecutable();
  assert.ok(executable, 'Chrome is required for the relay-health Needs-you inspection check.');
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
    // Inject the declared shared-builder output, independent of which API release supplies that field.
    const call = { kind: 'relay-health', id: 'relay-canary', ref: 'relay', text, what: nextStep,
      at: new Date().toISOString(), target: 'relay:relay-canary' };
    await chrome.stable(`(() => {
      globalThis.builderCalls = ${JSON.stringify([call])};
      personNeeds = () => builderCalls;
      render();
      return true;
    })()`);
    await chrome.waitFor(`Array.from(document.querySelectorAll('#needs > .row')).some(row => row.textContent.includes(${JSON.stringify(text)}))`);
    const rendered = JSON.parse(await chrome.stable(`JSON.stringify((() => {
      const row = [...document.querySelectorAll('#needs > .row')].find(entry => entry.textContent.includes(${JSON.stringify(text)}));
      const homeRow = [...document.querySelectorAll('#home-needs > .row')].find(entry => entry.textContent.includes(${JSON.stringify(text)}));
      return row && homeRow ? {
        target: row.dataset.go ?? null,
        ref: row.querySelector('.t > span')?.textContent ?? null,
        title: row.querySelector('.t').textContent,
        need: row.querySelector('.meta .why').textContent,
        action: row.querySelector(':scope > .chip').textContent,
        hasAge: !!row.querySelector('.row-age'),
        homeTarget: homeRow.dataset.go ?? null,
        homeAction: homeRow.querySelector(':scope > .chip').textContent,
      } : null;
    })())`));
    assert.deepEqual(rendered, {
      target: null,
      ref: 'relay',
      title: `relay${text}`,
      need: `NEEDS YOU ${nextStep}`,
      action: 'inspect',
      hasAge: true,
      homeTarget: null,
      homeAction: 'inspect',
    }, 'both real Chrome surfaces show an age-stamped inspection step and do not turn the health alert into a shouts/hold link');
    assert.deepEqual(chrome.exceptions, [], 'the actual page renders the new Needs-you kind without exceptions');
  } finally {
    if (chrome) await closeSnapshotChrome(chrome);
    rmSync(profile, { recursive: true, force: true });
    await view.stop();
  }
});

test("the page's Needs-you comes from the shared builder [N26]", { timeout: 180_000 }, async (t) => { // budget: hang ceiling for private board/API setup and the two real browser modes, not a throughput claim.
  const box = machine();
  const alpha = project(box, 'shared needs', `${SPEC}- G3 [pending] Choose the greeting. | gate: review\n- G4 [draft, must] Keep the footer. | gate: review\n- G5 [draft, aim] Keep the header. | gate: review\n`);
  box.run(alpha.repo, 'shout', 'person', 'Ship the greeting?', '--decision');
  box.run(alpha.web, 'shout', 'coordinator', 'An agent-only question?', '--decision');
  box.run(alpha.repo, 'hold', 'web', '--reason', 'Wait for the greeting decision');
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
    assert.deepEqual(JSON.parse(page.run('JSON.stringify(projectNeeds(data.project))')), expected, 'the live page uses the same builder');
    assert.equal(needEntries(page.show('needs')).length, expected.length, 'the panel has one row per shared entry');
    assert.deepEqual(JSON.parse(page.run('JSON.stringify((({decisions,pending,holds,drafts}) => ({decisions,pending,holds,drafts}))(boardSummary({},data.project)))')),
      { decisions: 1, pending: 1, holds: 1, drafts: 1 }, 'summary counts describe those same entries');
    assert.equal(page.run('document.title'), '(4) shared needs · Pullboard');
    assert.ok(needEntries(page.show('needs')).some(row => row[3] === 'lane held by coordinator (unknown)'), 'the hold retains its human-readable attribution');

    const output = join(box.dir, 'needs-export');
    box.run(alpha.repo, 'view', '--export', output);
    const listing = JSON.parse(readFileSync(join(output, 'api/v1/boards.json'), 'utf8'));
    const exported = JSON.parse(readFileSync(join(output, 'api/v1/boards', listing.boards[0].id, 'state.json'), 'utf8')).state;
    assert.deepEqual(exported.needs, expected, 'the real export carries the same calls');
    const executable = chromeExecutable();
    if (!executable) return t.skip('Install Chrome or set PULLBOARD_CHROME for exported and relay page parity.');
    snapshotHost = await serveFolder(output, '/snapshot/');
    // This transport reads the real isolated API; no board state or Needs-you result is mocked.
    const transport = `export async function createTransport() { return { async request(path) { const reply = await fetch('/upstream' + path); if (!reply.ok) throw new Error('private board read failed'); return reply.json(); } }; }`;
    relayServer = createServer(async (request, response) => {
      const url = new URL(request.url, 'http://127.0.0.1');
      try {
        if (url.pathname === '/') return response.writeHead(200, { 'content-type': 'text/html' }).end(cockpitPage('', { readOnly: true, transportModule: '/transport.js', stylesheet: '/view.css' }));
        if (url.pathname === '/transport.js') return response.writeHead(200, { 'content-type': 'text/javascript' }).end(transport);
        if (url.pathname === '/view.css') return response.writeHead(200, { 'content-type': 'text/css' }).end(readFileSync(new URL('../../src/view.css', import.meta.url)));
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
      await chrome.waitFor("data?.project?.needs?.length === 4 && document.querySelectorAll('#needs > .row').length === 4");
      assert.deepEqual(JSON.parse(await chrome.stable('JSON.stringify(projectNeeds(data.project))')), expected, mode + ' computes identical entries');
      assert.deepEqual(JSON.parse(await chrome.stable('JSON.stringify([...document.querySelectorAll("#needs > .row .t")].map(row => row.textContent))')),
        ['Ship the greeting?', 'G3Choose the greeting.', 'webWait for the greeting decision', '1draft spec rows to approve or drop'], mode + ' renders the same calls');
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

test('a person-only block shows in Needs you with its one step [N26]', async () => {
  const box = machine();
  const alpha = project(box, 'person block');
  box.env.CLAUDECODE = '1';
  const refused = spawnSync(process.execPath, [BIN, 'answer', '1', 'yes', '--as', 'person'], {
    cwd: alpha.repo, env: box.env, encoding: 'utf8',
  });
  delete box.env.CLAUDECODE;
  assert.equal(refused.status, 1, refused.stderr);
  assert.match(refused.stderr, /only the person can clear this/u);

  const view = await startView(box);
  try {
    const page = await openPage(view);
    const state = await boardOf(view, alpha.repo);
    assert.equal(state.blocks.length, 1, 'the live API supplies the person-only block list');
    assert.equal(state.blocks[0].audience, 'person');
    const entries = needEntries(page.show('needs'));
    assert.deepEqual(entries, [[null, 'blocked', 'Pullboard stopped a request that only you can clear: this terminal belongs to an agent',
      state.blocks[0].step, 'next step']], 'the view shows the plain reason and the exact API step without a bogus release action');
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
  box.run(alpha.web, 'shout', 'coordinator', 'Greet in <b>French</b> first?', '--decision');
  // Forty shouts after it: the ask is older than every shout the feed loads, and still waits.
  for (let n = 0; n < 40; n += 1) box.run(alpha.web, 'shout', 'all', `note ${n}`);
  // Another project's board numbers its shouts from 1 too.
  const beta = project(box, 'beta');
  box.run(beta.web, 'shout', 'coordinator', 'Beta asks too?', '--decision');
  const view = await startView(box);
  try {
    const page = await openPage(view);
    // Deliberately age the ask past a minute; gate load must not decide its label.
    const askedAt = page.run('Date.parse(data.project.asked.find(shout => shout.shout_id === 1).shout_at)');
    page.run(`Date.now = () => ${askedAt + 61_000}; render();`);
    // The question as the page escapes it, written as a pattern.
    const question = 'Greet in &lt;b&gt;French&lt;/b&gt; first\\?';
    // An agent asks its coordinator (B25): the ask waits on the board with who holds it, never in Needs-you.
    assert.doesNotMatch(page.show('needs'), /decide:/, "an agent's ask is its coordinator's to answer");
    assert.equal(page.element('decisions').hidden, true, 'an ask waiting on others stays folded');
    assert.match(page.show('asks-slot'), /^<button class="asks-toggle" data-fold="waiting" type="button" aria-expanded="false" title="Asks between agents, waiting on others: web-1 \(Test Model\) asks coordinator \(unknown\)">1 ask waiting <span aria-hidden="true">▾<\/span><\/button>$/, 'its toggle sits at the end of the composer line');
    page.run('view.open.waiting = true; render();');
    assert.match(shoutNameText(page.show('decisions')), new RegExp(`^<article class="shout h\\d" data-shout-id="1"><span class="avatar" aria-hidden="true">W1</span><div class="shout-main"><header><b class="who">web-1 \\(Test Model\\)</b><span class="to">→ coordinator \\(unknown\\)</span><span class="mark ask" role="group" title="decision" aria-label="decision">decision</span> <time class="long" data-ago="[^"]+" title="[^"]+">1m ago</time></header><div class="text">${question}</div><button class="more" data-more type="button">more</button></div></article>$`), 'above the shouts as a card, saying who asked whom, with no Answer button');
    assert.doesNotMatch(page.show('feed'), /Greet in/, 'though the feed no longer reaches it');

    // The coordinator passes it up with its note (B27): now it is the person's call.
    box.run(alpha.repo, 'pass', '1', 'over to you');
    await page.run('refresh()');
    const passedAt = page.run('Date.parse(data.project.decisions.find(shout => shout.shout_id === 42).shout_at)');
    page.run(`Date.now = () => ${passedAt + 61_000}; render();`);
    const passed = `Passed up from web-1: ${question}\nCoordinator note: over to you`;
    assert.match(page.show('needs'), new RegExp(`^<li class="row ask" data-go="decide:42"><span class="dot ask"></span><div><div class="t">${passed.replace('\n', '<br>')}</div><span class="row-age"><time data-ago="[^"]+">1m</time></span><div class="meta"><span class="why"><b>NEEDS YOU</b> a decision, asked by coordinator \\(unknown\\)</span></div></div><span class="chip warn">decide</span></li>`), "first in Needs-you: who passed it, what, and since when");
    assert.match(shoutNameText(page.show('decisions')), new RegExp(`^<div class="head"><i></i>Decision needed</div><article class="shout h\\d lead" data-shout-id="42"><span class="avatar"><svg [\\s\\S]*?</svg></span><div class="shout-main"><header><b class="who">coordinator \\(unknown\\)</b><span class="to">→ person</span><span class="mark ask" role="group" title="decision" aria-label="decision">decision</span> <time class="long" data-ago="[^"]+" title="[^"]+">1m ago</time></header><div class="text">${passed.replace('\n', '<br>')}</div><button class="more" data-more type="button">more</button><button class="ghost answer" data-go="decide:42" type="button">Answer</button></div></article>$`), 'and above the shouts as the coordinator\'s card, with an Answer button');

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
    assert.deepEqual(form(), { answering: true, who: 'coordinator (unknown)', question: 'Passed up from web-1: Greet in <b>French</b> first?\nCoordinator note: over to you', to: 'coordinator', locked: true, button: 'Answer' }, 'Answer turns the form to answering the one who asked');
    await page.fire('answer-cancel', 'click');
    assert.deepEqual(form(), { answering: false, who: '', question: '', to: 'web', locked: false, button: 'Shout' }, 'Cancel gives back the plain shout');

    await page.click({ go: 'decide:42' });
    page.element('shout-text').value = 'French, then English';
    await page.fire('shout-form', 'submit');
    assert.equal(page.element('console').textContent.split('\n')[0], '$ pullboard answer 42 French, then English --as person', 'the view answers as the person');
    assert.equal(page.element('console').className, 'console ok');
    const replies = JSON.parse(box.run(alpha.web, 'inbox', '--json')).shouts.filter((shout) => shout.shout_answers === 1);
    assert.deepEqual(replies.map((shout) => [shout.shout_from, shout.shout_to, shout.shout_answers, shout.shout_text]),
      [['person', 'web-1', 1, 'Person answered #42: French, then English']], 'the answer reaches the agent that asked');
    assert.deepEqual(form(), { answering: false, who: '', question: '', to: 'web', locked: false, button: 'Shout' }, 'the form is a plain shout again');
    assert.equal(page.element('shout-text').value, '');
    assert.doesNotMatch(page.show('needs'), /decide:/, 'an answered decision leaves Needs-you');
    assert.equal(page.element('decisions').hidden, true, 'and the banner');

    box.run(alpha.web, 'shout', 'coordinator', 'Ship today?', '--decision');
    box.run(alpha.repo, 'pass', '45', 'yours');
    await page.run('refresh()');
    const feed = shoutNameText(page.show('feed'));
    assert.match(feed, /<b class="who">web-1 \(Test Model\)<\/b><span class="to">→ coordinator \(unknown\)<\/span><span class="mark ask" role="group" title="decision" aria-label="decision">decision<\/span> <time [^>]*>[^<]*<\/time><\/header><div class="text">Ship today\?<\/div>/, 'the feed marks an ask');
    assert.match(feed, /<b class="who">you<\/b><span class="to">→ coordinator \(unknown\)<\/span><span class="mark" role="group" title="answer" aria-label="answer">answer<\/span> <time [^>]*>[^<]*<\/time><\/header><div class="text">French, then English<\/div>/, 'and an answer');
    assert.match(page.show('needs'), /data-go="decide:46"/);

    // An answer belongs to the project whose question it shows.
    box.run(beta.repo, 'pass', '1', 'yours too');
    const plain = { answering: false, who: '', question: '', to: 'web', locked: false, button: 'Shout' };
    await page.click({ go: 'decide:46' });
    // The new project's board is held back, so this is the form the moment the switch is made.
    page.run('globalThis.plain = fetch; globalThis.fetch = (path, init) => new Promise((done) => { globalThis.resume = done; }).then(() => plain(path, init));');
    await page.click({ root: beta.repo });
    assert.deepEqual(form(), plain, 'leaving the project leaves answer mode at once');
    page.run('globalThis.fetch = plain; resume();');
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
    const waiting = (repo, id) => JSON.parse(box.run(repo, 'decisions', '--as', 'person', '--json')).decisions
      .filter((shout) => shout.shout_id === id).map((shout) => [shout.shout_from, shout.shout_to, shout.shout_text]);
    assert.deepEqual(waiting(beta.repo, 2), [['coordinator', 'person', 'Passed up from web-1: Beta asks too?\nCoordinator note: yours too']], "beta's ask still waits");
    assert.deepEqual(waiting(alpha.repo, 46), [['coordinator', 'person', 'Passed up from web-1: Ship today?\nCoordinator note: yours']], "and so does alpha's");
  } finally {
    await view.stop();
  }
});
test("needs-you holds only the person's calls; the rest show on the board with who holds them [B26, N26]", async () => {
  const box = machine();
  const alpha = project(box, 'alpha', `${SPEC}- G3 [pending] Greet in French? | gate: review\n- G4 [draft, aim] A footer on every page. | gate: review\n`);
  box.run(alpha.repo, 'add', 'web', 'Greeting', '--specs', 'G1', '--criterion', 'greets');
  box.run(alpha.repo, 'add', 'web', 'Farewell', '--specs', 'G2', '--criterion', 'says goodbye');
  build(box, alpha, 1, 'greeting.html');
  build(box, alpha, 2, 'farewell.html');
  sendBack(box, alpha, 2, 'no farewell yet');
  box.run(alpha.web, 'shout', 'coordinator', 'Which colour for the button?', '--decision');
  box.run(alpha.repo, 'shout', 'person', 'Launch on Friday?', '--decision');
  box.run(alpha.repo, 'hold', 'web', '--reason', 'G3 is open');
  const view = await startView(box);
  try {
    await confirmBaseline(view, alpha.repo);
    const page = await openPage(view);
    const needs = page.show('needs');
    assert.deepEqual(needEntries(needs).map(([go, ref, words]) => [go.split(':')[0], ref, words]), [
      ['decide', null, 'Launch on Friday?'],
      ['spec', 'G3', 'Greet in French?'],
      ['tab', 'web', 'G3 is open'],
      ['tab', '1', 'draft spec rows to approve or drop'],
    ], "the person's calls, and only those: the decision asked of them, the spec's question, the held lane, the draft row");
    assert.equal(needEntries(needs)[0][3], 'a decision, asked by coordinator (unknown)', 'a decision says below who asked it');
    assert.doesNotMatch(needs, /Which colour|Greeting|Farewell/, "an agent's ask, work waiting for a verdict and work sent back are not the person's");
    assert.match(needs, /<li class="row ask" data-go="tab:shouts"><span class="dot ask"><\/span><div><div class="t"><span>web<\/span>G3 is open<\/div><span class="row-age"><time data-ago="[^"]+">(?:now|\d+[mhd])<\/time><\/span><div class="meta"><span class="why"><b>NEEDS YOU<\/b> lane held by coordinator \(unknown\)<\/span><\/div><\/div><span class="chip warn">release<\/span><\/li>/, 'a held lane says who set it and shows the API-provided hold age');

    // Each of the rest is on the board, with who holds it.
    page.run('view.open.waiting = true; render();');
    assert.match(shoutNameText(page.show('decisions')), /<article class="shout h\d" data-shout-id="\d+"><span class="avatar" aria-hidden="true">W1<\/span><div class="shout-main"><header><b class="who">web-1 \(Test Model\)<\/b><span class="to">→ coordinator \(unknown\)<\/span>/, "the agent's ask waits on its coordinator");
    assert.match(itemRow(page.show('chain'), 1), /<span class="chip [^"]*">to verify<\/span><\/li>$/, 'work waiting for a verdict');
    assert.ok(itemRow(page.show('chain'), 2).includes('<b>BEHAVIOR_MISMATCH</b> no farewell yet'), 'and work sent back, with why');
    page.run("view.agent = 'web-1'; render();");
    assert.deepEqual(agentEntries(page.show('agents')).find((agent) => agent.id === 'web-1').holds, ['#2 Farewell: sent back', '#1 Greeting: to verify'], 'the agent that built them holds both');
    page.run('view.agent = null; render();');
    assert.match(page.show('lanes'), /<b>web<\/b> <span class="chip no" title="held by coordinator \(unknown\)">held by coordinator \(unknown\)<\/span> <span class="muted">G3 is open<\/span>/, 'a held lane names who holds it');

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
    const style = await styleOf(view);
    // A need is an item's row: its reference and words on the title line, NEEDS YOU and its kind below, its action at the right.
    assert.match(style, /\n\.row \.t \{ grid-area: t; min-width: 0; font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; \}/, 'the title line ends in an ellipsis rather than wrap');
    assert.deepEqual(needEntries(page.show('needs')), [['spec:G3', 'G3', 'Should a greeting with a title long enough to need the room wrap?', 'an open question in SPEC.md', 'answer']]);
  } finally {
    await view.stop();
  }
});

test('needs you and the asks sit in their lists [N26]', { timeout: 180_000 }, async (t) => {
  const executable = chromeExecutable();
  if (!executable) return t.skip('Install Chrome or set PULLBOARD_CHROME for Needs you and Shouts checks.');
  const box = machine();
  const spec = `${SPEC}- G3 [pending] Should the greeting name the visitor? | gate: review\n- G4 [draft, must] The footer links home. | gate: web test\n- G5 [draft, aim] The header stays put. | gate: web test\n`;
  const alpha = project(box, 'asks', spec);
  box.run(alpha.repo, 'add', 'web', 'Greeting', '--specs', 'G1', '--criterion', 'greets');
  box.run(alpha.repo, 'add', 'web', 'Farewell', '--specs', 'G2', '--criterion', 'says goodbye');
  box.run(alpha.web, 'claim', '1');
  const second = join(box.dir, 'asks-web-2');
  box.git(alpha.repo, 'worktree', 'add', '-q', second, '-b', 'web/asks2');
  box.run(second, 'join', 'web');
  // The person's calls: a decision passed up to them, the spec's open question, a held lane and two draft rows. And an
  // agent's ask that waits on its coordinator, not on the person.
  box.run(alpha.web, 'shout', 'coordinator', 'Which colour for the button?', '--decision');
  box.run(alpha.repo, 'pass', '1', 'over to you');
  box.run(second, 'shout', 'coordinator', 'Ship the footer first?', '--decision');
  box.run(alpha.repo, 'hold', 'web', '--reason', 'Freeze for the demo');
  const view = await startView(box);
  const profile = mkdtempSync(join(tmpdir(), 'pullboard-asks-chrome-'));
  let chrome;
  /** Items' head and Shouts' card as they read. */
  const read = async () => JSON.parse(await chrome.stable(`JSON.stringify((() => {
    const box = (e) => { if (!e) return null; const r = e.getBoundingClientRect(); return { left: r.left, right: r.right, top: r.top, bottom: r.bottom, width: r.width, height: r.height }; };
    const shown = (e) => !!e && !e.closest('[hidden]') && e.getBoundingClientRect().height > 0;
    const probe = document.createElement('i'); probe.style.color = 'var(--warn)'; document.body.append(probe); const warn = getComputedStyle(probe).color; probe.remove();
    const needs = document.querySelector('#needs');
    const card = document.querySelector('.shouts-card'), decisions = document.querySelector('#decisions');
    return {
      page: { width: document.documentElement.clientWidth, scroll: document.documentElement.scrollWidth, body: document.body.scrollWidth },
      needsShown: shown(needs), inList: needs.parentElement === document.querySelector('#chain').parentElement, separateCard: !!document.querySelector('section.needs-you#needs'),
      needs: [...needs.querySelectorAll(':scope > .row')].map((row) => ({ go: row.dataset.go ?? null, words: row.querySelector('.t').textContent, ref: row.querySelector('.t > span')?.textContent ?? null,
        kind: row.querySelector('.meta .why').textContent, label: getComputedStyle(row.querySelector('.meta .why b')).color === warn && getComputedStyle(row.querySelector('.meta .why')).color === warn, chip: row.querySelector(':scope > .chip').textContent, age: !!row.querySelector('.row-age') })),
      card: card ? [...card.children].map((e) => e.id || e.className) : null,
      coordinatorDecisionsHidden: document.querySelector('#coordinator-decisions').hidden,
      coordinatorDecisions: [...document.querySelectorAll('#coordinator-decisions .shout .text')].map((text) => text.textContent),
      composer: box(document.querySelector('.shout-form .composer')), asks: box(document.querySelector('.asks-toggle[data-fold="waiting"]')),
      asksOpen: document.querySelector('.asks-toggle[data-fold="waiting"]')?.getAttribute('aria-expanded') ?? null, showAgents: box(document.querySelector('.asks-slot [data-agents-toggle]')),
      decisions: shown(decisions) ? [...decisions.querySelectorAll('.shout .text')].map((text) => text.textContent) : [], groupTint: getComputedStyle(decisions).backgroundColor, cardTint: card ? getComputedStyle(card).backgroundColor : null,
      firstRule: decisions.querySelector('.shout') ? getComputedStyle(decisions.querySelector('.shout')).borderTopWidth : null,
      feedBar: !!document.querySelector('#feed .feed-bar'), panelShown: shown(document.querySelector('#agents')), hide: !!document.querySelector('.panel-head [data-agents-toggle]'),
      agents: [...document.querySelectorAll('#agents .agent-card')].filter(shown).map((row) => ({ who: [...row.querySelector('.agent-who').children].map((part) => part.textContent.trim()).join(' '), what: row.querySelector('.agent-doing').textContent.trim(), chipInDoing: !!row.querySelector('.agent-doing .chip'), whatWidth: box(row.querySelector('.agent-what')).width, doingWidth: box(row.querySelector('.agent-doing')).width })),
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
        // Needs you heads the list: each call a row shaped like an item, NEEDS YOU and its kind (for a decision, who
        // asked) in the warning colour below.
        assert.deepEqual([r.needsShown, r.inList, r.separateCard], [true, true, false], `${at}: Needs you is the head of the Items list, not a card of its own`);
        assert.deepEqual(r.needs.map(({ go, ref, words, kind, chip }) => [go.split(':')[0], ref, words.includes('Which colour for the button?') ? 'Which colour…' : words, kind, chip]), [
          ['decide', null, 'Which colour…', 'NEEDS YOU a decision, asked by coordinator (unknown)', 'decide'],
          ['spec', 'G3', 'G3Should the greeting name the visitor?', 'NEEDS YOU an open question in SPEC.md', 'answer'],
          ['tab', 'web', 'webFreeze for the demo', 'NEEDS YOU lane held by coordinator (unknown)', 'release'],
          ['tab', '2', '2draft spec rows to approve or drop', 'NEEDS YOU Spec rows waiting on you', 'review'],
        ], `${at}: the person's calls, each a row, the drafts one row with their count`);
        assert.ok(r.needs.every((need) => need.label), `${at}: NEEDS YOU and its kind in the warning colour`);
        assert.deepEqual(r.needs.map((need) => need.age), [true, false, true, false], `${at}: a call that has an age shows it at the right`);

        await click('[data-tab=shouts]');
        await chrome.waitFor("!document.querySelector('[data-pane=shouts]').hidden && !!document.querySelector('#feed .shout')");
        r = await read();
        assert.ok(r.page.scroll <= r.page.width && r.page.body <= r.page.width, `${at}: no sideways scroll on Shouts`);
        // One card: the composer's line, the coordinator's own queue, the asks, the feed.
        assert.deepEqual(r.card, ['shout-form', 'coordinator-decisions', 'decisions', 'feed'], `${at}: Shouts is one card`);
        assert.equal(r.coordinatorDecisionsHidden, false, `${at}: the coordinator's own unanswered ask is visible`);
        assert.ok(r.coordinatorDecisions.some((text) => text.includes('Ship the footer first?')), `${at}: the coordinator queue shows the second agent's ask`);
        if (width === 1280) assert.ok(Math.abs((r.composer.top + r.composer.height / 2) - (r.asks.top + r.asks.height / 2)) <= 4 && r.asks.left >= r.composer.right, `${at}: the asks waiting sit at the end of the composer's line: ${JSON.stringify([r.composer, r.asks])}`);
        assert.deepEqual([r.asksOpen, r.decisions.length, /Which colour for the button\?/.test(r.decisions[0] ?? '')], ['false', 1, true], `${at}: the asks waiting on others stay folded; the person's own decision shows`);
        assert.equal(r.feedBar, false, `${at}: no bar above the feed while it shows every shout`);
        assert.ok(r.hide && r.panelShown, `${at}: the agents panel carries its own hide`);
        // An agent's row: its name and state in words, then what it holds at the full width.
        const holder = r.agents.find((agent) => agent.who.startsWith('web-1'));
        assert.ok(holder && /^web-1 \(Test Model\) building (?:now|\d+[mhd])$/.test(holder.who) && holder.what === '#1 Greeting' && !holder.chipInDoing, `${at}: web-1's row reads as an item's: ${JSON.stringify(holder)}`);
      }
    }

    // Opened, the asks waiting on others are a group set apart from the feed, with no rule above the first.
    await chrome.send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });
    await chrome.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: 'light' }] });
    await chrome.waitFor('innerWidth === 1280');
    await click('.asks-toggle[data-fold="waiting"]');
    let r = await read();
    assert.deepEqual([r.asksOpen, r.decisions.length, r.decisions[1]], ['true', 2, 'Ship the footer first?'], 'the toggle opens the ask waiting on others');
    assert.ok(r.groupTint !== r.cardTint && r.firstRule === '0px', `a tinted group with no rule above its first card: ${JSON.stringify([r.groupTint, r.cardTint, r.firstRule])}`);
    // Hidden, the agents come back from the composer's line, after the asks.
    await click('.panel-head [data-agents-toggle]');
    r = await read();
    assert.ok(!r.panelShown && r.showAgents && r.showAgents.left >= r.asks.right, `hidden, Show agents sits on the composer's line after the asks: ${JSON.stringify([r.asks, r.showAgents])}`);
    await click('.asks-slot [data-agents-toggle]');
    assert.ok((await read()).panelShown, 'and brings the panel back');
    // A sent shout shows as its card; no note pushes into the composer's line.
    await chrome.stable("document.querySelector('#shout-text').focus()");
    await chrome.send('Input.insertText', { text: 'Footer after the greeting.' });
    await click('#shout-send');
    await chrome.waitFor("[...document.querySelectorAll('#feed .shout .text')].some((text) => text.textContent === 'Footer after the greeting.')", 15_000); // budget: hang ceiling for the sent shout to appear in the feed; no throughput claim.
    r = await read();
    assert.equal(r.okNote, false, 'a sent shout is its card, with no note beside the composer');
    // However many calls there are, each is a row: six more decisions make ten rows, none folded into a count.
    for (const n of [1, 2, 3, 4, 5, 6]) box.run(alpha.repo, 'shout', 'person', `Ship part ${n} today?`, '--decision');
    await click('[data-tab=items]');
    await chrome.waitFor("document.querySelectorAll('#needs > .row').length >= 10", 15_000); // budget: hang ceiling for ten native decision rows to appear; no throughput claim.
    r = await read();
    assert.deepEqual([r.needs.length, r.needs.filter((need) => /^Ship part [1-6] today\?$/.test(need.words)).length, r.needs.every((need) => need.label)], [10, 6, true],
      `ten calls, ten rows, each with its kind in the warning colour: ${JSON.stringify(r.needs)}`);
    assert.equal(await chrome.stable("document.querySelector('#needs').textContent.includes('more need you')"), false, 'no call is folded into a count');
    // Narrowed to the unread shouts from the status bar, the feed carries its bar with show all; show all clears it.
    box.run(alpha.web, 'shout', 'coordinator', 'Greeting is half done.');
    await chrome.waitFor("!document.querySelector('#status-unread')?.hidden", 15_000); // budget: hang ceiling for the unread badge after a new shout; no throughput claim.
    await click('#status-unread');
    await chrome.waitFor("view.tab === 'shouts' && !!document.querySelector('#feed .feed-bar')");
    assert.match(await chrome.stable("document.querySelector('#feed .feed-bar').textContent"), /^\d+ unread\s*show all$/, 'narrowed to the unread shouts, the feed carries its bar with show all');
    await click('#feed [data-unread]');
    assert.equal((await read()).feedBar, false, 'show all brings back every shout and clears the bar');
    // Under Verified, or a lane, the list is narrowed and Needs you steps aside.
    await click('[data-tab=items]');
    await chooseFilter(chrome, 'state:verified');
    assert.equal((await read()).needsShown, false, 'under Verified, Needs you steps aside');
    await click('[data-tab=items]');
    await chooseFilter(chrome, 'state:active');
    assert.deepEqual(chrome.exceptions, [], 'the page raises no uncaught exception');
  } finally {
    if (chrome) await closeSnapshotChrome(chrome);
    rmSync(profile, { recursive: true, force: true });
    await view.stop();
  }
});


test('an agent-approved row shows in Needs you with its agent and commit and a confirm and decline move [S1,B26,P6,N26]', { timeout: 120_000 }, async () => { // budget: isolated real Git/API setup and two owned browser profiles, not a performance claim.
  const box = machine();
  box.env.GIT_AUTHOR_NAME = 'Agent & \"unconfirmed\" seat';
  const alpha = project(box, 'agent approval', undefined, {}, { agentApproved: true });
  const view = await startView(box);
  let chrome, snapshotHost, agentApi, reads;
  try {
    const initial = await boardOf(view, alpha.repo);
    const flagged = initial.needs.filter(row => row.kind === 'agent-approved');
    assert.deepEqual(flagged.map(row => row.id), ['G1', 'G2']);
    const page = await openPage(view);
    for (const row of flagged) {
      assert.ok(page.show('needs').includes(`data-agent-approved="${row.id}"`), 'agent-approved calls have their own Needs-you row');
      assert.equal(row.agent, 'Agent & \"unconfirmed\" seat');
      assert.ok(page.show('needs').includes('Agent &amp; &quot;unconfirmed&quot; seat'), 'author text is escaped rather than promoted into markup');
      assert.ok(page.show('needs').includes(row.commit));
      assert.ok(page.show('needs').includes('Approved in Git by'), 'Git provenance is expressed plainly without inventing a person identity');
    }
    assert.match(page.show('needs'), />Confirm</u);
    assert.match(page.show('needs'), />Decline</u);
    const executable = chromeExecutable();
    assert.ok(executable, 'Chrome is required to prove real person clicks and read-only agent viewing');
    agentApi = await approvalAgentApi(box, alpha.repo);
    const id = await boardId(view, alpha.repo);
    const agentState = await agentApi.call('/api/v1/boards/' + id + '/state');
    assert.equal(agentState.status, 200, 'an API-key reader can see the flagged rows');
    for (const verb of ['spec-approve', 'spec-decline']) {
      const attempt = await agentApi.call('/api/v1/boards/' + id + '/moves', { verb, args: { ids: 'G1', ...(verb === 'spec-decline' ? { reason: 'An agent must not decide this.' } : {}) } });
      assert.equal(attempt.status, 409);
      assert.equal(attempt.document.error.code, 'B26_PERSON_CHANNEL');
    }
    assert.ok((await boardOf(view, alpha.repo)).needs.some(row => row.kind === 'agent-approved' && row.id === 'G1'), 'refused agent writes leave the call unchanged');
    const output = join(box.dir, 'agent-read-only');
    box.run(alpha.repo, 'view', '--export', output);
    snapshotHost = await serveFolder(output, '/agent/');
    chrome = await openSnapshotChrome(executable, snapshotHost.base + '/agent/', join(box.dir, 'agent-approval-readonly-chrome'));
    await chrome.waitFor('document.querySelectorAll("#needs [data-agent-approved]").length === 2');
    const agentRows = await chrome.stable('document.querySelector("#needs").innerHTML');
    assert.match(agentRows, /agent-approved/u);
    assert.doesNotMatch(agentRows, /data-row-decision|<button/u, 'a read-only reader sees attribution without a person move');
    await closeSnapshotChrome(chrome); chrome = null;
    const refused = runFixtureChild(process.execPath, [join(import.meta.dirname, '../../bin/pullboard.js'), 'spec', 'approve', 'G1', '--json'], {
      cwd: alpha.web, env: { ...box.env, CLAUDECODE: '1' }, encoding: 'utf8',
    });
    assert.equal(refused.status, 1);
    assert.equal(JSON.parse(refused.stdout).error.code, 'B26_PERSON_CHANNEL');
    chrome = await openSnapshotChrome(executable, 'about:blank', join(box.dir, 'agent-approval-person-chrome'));
    reads = await approvalReadGate(chrome, view.base);
    await chrome.send('Page.navigate', { url: view.link.href });
    await chrome.waitFor('document.querySelectorAll("#needs [data-agent-approved]").length === 2');
    await chrome.click(`document.querySelector('[data-agent-approved="G1"] [data-row-decision="approve"]')`);
    await chrome.waitFor('document.querySelector(\'[data-agent-approved="G1"]\') === null');
    const confirmed = await boardOf(view, alpha.repo);
    assert.equal(confirmed.spec.find(row => row.id === 'G1').agentApproval, null);
    assert.equal(confirmed.needs.some(row => row.kind === 'agent-approved' && row.id === 'G1'), false);
    await chrome.click(`document.querySelector('[data-agent-approved="G2"] [data-row-decision="decline"]')`);
    await chrome.waitFor('document.querySelector("#spec-decline-dialog").hidden === false');
    await chrome.click('document.querySelector("#spec-decline-cancel")');
    assert.ok((await boardOf(view, alpha.repo)).needs.some(row => row.kind === 'agent-approved' && row.id === 'G2'), 'cancelling records no decision');
    const specFile = join(alpha.repo, 'SPEC.md');
    const specText = readFileSync(specFile, 'utf8');
    reads.hold();
    try {
      await chrome.stable('void refresh(); true');
      await reads.waitForHeld();
      assert.ok(reads.heldCount() > 0, 'an actual state HTTP response is withheld during the stale-row refusal');
      writeFileSync(specFile, specText.split('\n').filter(line => !line.startsWith('- G2 ')).join('\n'));
      await chrome.click(`document.querySelector('[data-agent-approved="G2"] [data-row-decision="approve"]')`);
      await chrome.waitFor('document.querySelector(\'[data-agent-approved="G2"] .spec-feedback.no\') !== null');
      const refusal = await chrome.stable('document.querySelector(\'[data-agent-approved="G2"] .spec-feedback.no\').textContent');
      assert.match(refusal, /G2/u, 'the actual backend refusal is visible beside the initiating Needs-you row');
      assert.ok(reads.heldCount() > 0, 'real state responses remain held until refusal is observed and SPEC is restored');
    } finally { writeFileSync(specFile, specText); await reads.release(); }
    await chrome.stable('refresh()');
    await chrome.waitFor('document.querySelector(\'[data-agent-approved="G2"]\') !== null');
    await chrome.click(`document.querySelector('[data-agent-approved="G2"] [data-row-decision="decline"]')`);
    await chrome.click('document.querySelector("#spec-decline-reason")');
    await chrome.send('Input.insertText', { text: 'The person declines this unconfirmed requirement.' });
    await chrome.click('document.querySelector("#spec-decline-submit")');
    await chrome.waitFor('document.querySelector(\'[data-agent-approved="G2"]\') === null');
    const declined = await boardOf(view, alpha.repo);
    const row = declined.spec.find(entry => entry.id === 'G2');
    assert.equal(row.decision.decision, 'decline');
    assert.match(row.decision.reason, /person declines/u);
    assert.equal(declined.needs.some(entry => entry.kind === 'agent-approved' && entry.id === 'G2'), false);
  } finally {
    const cleanupErrors = [];
    for (const cleanup of [() => reads?.close(), () => chrome && closeSnapshotChrome(chrome), () => snapshotHost?.close(), () => agentApi?.stop(), () => view.stop()]) {
      try { await cleanup(); } catch (error) { cleanupErrors.push(error); }
    }
    if (cleanupErrors.length) throw new AggregateError(cleanupErrors, 'owned approval fixtures failed cleanup');
  }
});

test('a sentinel draft in Needs you is approved and declined from the view [N26,B26]', { timeout: 120_000 }, async () => { // budget: isolated real Git/API setup and one owned browser profile, not a performance claim.
  const executable = chromeExecutable();
  assert.ok(executable, 'Chrome is required to prove real person approval and decline controls');
  const box = machine();
  const alpha = project(box, 'sentinel decisions');
  const command = 'node bin/checks/file-size.js';
  const directory = 'checks';
  for (const name of ['approve-watch', 'decline-watch']) {
    box.run(alpha.repo, 'sentinel', 'propose', name, '--check', command, '--directory', directory, '--every', 'hourly', '--owner', 'coordinator');
  }
  const view = await startView(box);
  let chrome, agentApi;
  try {
    const initial = await boardOf(view, alpha.repo);
    const drafts = new Map(initial.sentinelDrafts.map((row) => [row.ref, row]));
    assert.deepEqual([...drafts.keys()].sort(), ['approve-watch', 'decline-watch'], 'both proposals are pending person decisions');
    agentApi = await approvalAgentApi(box, alpha.repo);
    const board = await boardId(view, alpha.repo);
    const refused = await agentApi.call('/api/v1/boards/' + board + '/moves', {
      verb: 'sentinel-approve', args: { name: 'approve-watch', digest: drafts.get('approve-watch').digest },
    });
    assert.equal(refused.status, 409, 'an API-key caller cannot approve a sentinel as the person');
    assert.equal(refused.document.error.code, 'B26_PERSON_CHANNEL');
    assert.ok((await boardOf(view, alpha.repo)).sentinelDrafts.some((row) => row.ref === 'approve-watch'), 'the refused agent move leaves the proposal pending');

    chrome = await openSnapshotChrome(executable, 'about:blank', join(box.dir, 'sentinel-person-chrome'));
    await chrome.send('Page.navigate', { url: view.link.href });
    await chrome.waitFor('document.querySelectorAll("#needs [data-sentinel-draft]").length === 2');
    const rows = JSON.parse(await chrome.stable(`JSON.stringify([...document.querySelectorAll('#needs [data-sentinel-draft]')].map(row => ({
      name: row.dataset.sentinelDraft, text: row.textContent,
      actions: [...row.querySelectorAll('button')].map(button => [button.dataset.sentinelDecision, button.textContent.trim()]),
    })))`));
    for (const row of rows) {
      assert.deepEqual(row.actions, [['approve', 'Approve'], ['decline', 'Decline']], 'each pending proposal has explicit person controls');
      assert.match(row.text, /node bin\/checks\/file-size\.js/u, 'the person sees the proposed command');
      assert.match(row.text, /Directory:\s*checks/u, 'the person sees the working folder');
      assert.match(row.text, /hourly/u, 'the person sees the schedule');
      assert.match(row.text, /coordinator/u, 'the person sees the owner');
    }

    await chrome.click(`document.querySelector('[data-sentinel-draft="approve-watch"] [data-sentinel-decision="approve"]')`);
    await chrome.waitFor('document.querySelector(\'[data-sentinel-draft="approve-watch"]\') === null');
    let recorded = JSON.parse(box.run(alpha.repo, 'sentinels', '--json')).sentinels;
    assert.equal(recorded.find((row) => row.name === 'approve-watch').status, 'approved', 'the view approval is recorded on the board');

    await chrome.click(`document.querySelector('[data-sentinel-draft="decline-watch"] [data-sentinel-decision="decline"]')`);
    await chrome.waitFor('document.querySelector("#spec-decline-dialog").hidden === false');
    assert.equal(await chrome.stable('document.querySelector("#spec-decline-reason").required'), true, 'decline requires a reason');
    await chrome.click('document.querySelector("#spec-decline-submit")');
    assert.ok((await boardOf(view, alpha.repo)).sentinelDrafts.some((row) => row.ref === 'decline-watch'), 'an empty decline leaves the proposal pending');
    await chrome.click('document.querySelector("#spec-decline-reason")');
    await chrome.send('Input.insertText', { text: 'This watch should not run.' });
    await chrome.click('document.querySelector("#spec-decline-submit")');
    try {
      await chrome.waitFor('document.querySelector(\'[data-sentinel-draft="decline-watch"]\') === null');
    } catch (error) {
      const diagnostic = {};
      try {
        diagnostic.ui = JSON.parse(await chrome.stable(`JSON.stringify({
          console: { text: document.querySelector('#console')?.textContent, className: document.querySelector('#console')?.className, hidden: document.querySelector('#console')?.hidden },
          reason: document.querySelector('#spec-decline-reason')?.value,
          request: view.request,
          decline: { id: view.declining, kind: view.declineKind, digest: view.declineDigest, root: view.declineRoot, anchorConnected: Boolean(view.declineAnchor?.isConnected) },
          active: { tag: document.activeElement?.tagName, id: document.activeElement?.id, decision: document.activeElement?.dataset?.sentinelDecision },
          row: document.querySelector('[data-sentinel-draft="decline-watch"]')?.textContent,
        })`));
      } catch (diagnosticError) { diagnostic.uiError = String(diagnosticError.message || diagnosticError); }
      try {
        diagnostic.backend = JSON.parse(box.run(alpha.repo, 'sentinels', '--json')).sentinels.find((row) => row.name === 'decline-watch');
      } catch (diagnosticError) { diagnostic.backendError = String(diagnosticError.message || diagnosticError); }
      error.message += '; decline diagnostic ' + JSON.stringify(diagnostic);
      throw error;
    }
    recorded = JSON.parse(box.run(alpha.repo, 'sentinels', '--json')).sentinels;
    const declined = recorded.find((row) => row.name === 'decline-watch');
    assert.equal(declined.status, 'declined', 'the view decline is recorded on the board');
    assert.equal(declined.reason, 'This watch should not run.');
  } finally {
    const cleanupErrors = [];
    for (const cleanup of [() => chrome && closeSnapshotChrome(chrome), () => agentApi?.stop(), () => view.stop()]) {
      try { await cleanup(); } catch (error) { cleanupErrors.push(error); }
    }
    if (cleanupErrors.length) throw new AggregateError(cleanupErrors, 'owned sentinel approval fixture failed cleanup');
  }
});
