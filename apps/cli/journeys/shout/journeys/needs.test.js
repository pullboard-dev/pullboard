// pullboard: browser
/** @pullboard-test-input source-tree */
/** @pullboard-test-gui */
/** Cockpit needs-you calls: a decision answered from the view, who holds the rest, and titles on a phone [N26]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  SPEC,
  machine,
  project,
  build,
  sendBack,
  startView,
  styleOf,
  openPage,
  projectRows,
  itemRow,
  shoutNameText,
  boardId,
  fetchLive,
} from '../../../tests/fixtures/cockpit/harness.js';

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
  return page.show('feed').match(new RegExp('<div class="sx-msg[^"]*" id="shout-' + id + '" data-shout-id="' + id + '">([^]*?)</time></div>'))?.[1] ?? '';
}

/**
 * Read the board again until the page holds what a write made. The view serves a write once its state worker has
 * rebuilt the board, and a live page's stream catches up by itself [A2,C7]; this page has no stream, so it reads again.
 */
async function readUntil(page, check) {
  const end = Date.now() + 20_000; // budget: hang ceiling for the state worker to serve one write; no throughput claim.
  // Each read is a real request to the view, so the loop paces itself on the server's answers.
  while (!page.run(check) && Date.now() < end) await page.run('refresh()');
  return page.run(check);
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
    // Forty notes follow the ask, so its thread folds the oldest messages; open them, as a person does.
    page.run("view.shoutFilter = 'questions'; view.shoutThread = 'none'; view.open['msgs:none'] = true; render();");
    const waitingMessage = conversationMessage(page, 1);
    assert.match(waitingMessage, /<span class="sx-snd seat" title="web-1 \(Test Model\) to coordinator">/,
      'the opened native question retains its exact author, model hover and recipient');
    assert.match(waitingMessage, new RegExp('<span class="sx-tx"><span class="sx-mk ruling">Ruling</span>' + question + '</span>'), 'its entire escaped question remains visible, marked as a ruling');
    assert.match(page.show('feed'), /data-shout-thread="none"/, 'the native pending question keeps its thread in the Questions list');
    assert.doesNotMatch(waitingMessage, /data-go="decide:/, 'an agent question has no person Answer control');


    // The coordinator passes it up with its note (B27): now it is the person's call.
    // machine().inProcess returns stdout and refuses a non-zero status itself.
    const handed = await box.inProcess(alpha.repo, 'pass', '1', 'over to you');
    assert.match(handed, /passed #1 upward as #\d+/u, 'pass hands the ask up: ' + handed);
    assert.ok(await readUntil(page, 'data.project.decisions.some(shout => shout.shout_id === 42)'), 'the passed ask is decision 42; the page holds ' + page.run('JSON.stringify(data.project.decisions.map(shout => shout.shout_id))'));
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
    assert.match(passedMessage, /<span class="sx-snd coord" title="coordinator[^"]* to you">/,
      'the passed native call retains its coordinator author and person recipient');
    assert.match(passedMessage, new RegExp('<span class="sx-tx"><span class="sx-mk ruling">Ruling</span>' + passed.replace('\n', '<br>') + '</span>'),
      'the conversation keeps the complete passed question and coordinator note');
    assert.match(page.show('feed'), /<form class="sx-reply" data-reply="none" data-ask="42">/, 'the real passed call is answered from its thread');
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
    await readUntil(page, '!data.project.decisions.some(shout => shout.shout_id === 42)');
    page.run("openTab('items'); render();");
    assert.doesNotMatch(page.show('needs'), /decide:/, 'an answered decision leaves Rulings');
    page.run("openTab('shouts'); render();");
    assert.equal(page.element('decisions').hidden, true, 'and the banner');

    await box.inProcess(alpha.web, 'shout', 'coordinator', 'Ship today?', '--decision', '--kind', 'question');
    await box.inProcess(alpha.repo, 'pass', '45', 'yours');
    await readUntil(page, 'data.project.decisions.some(shout => shout.shout_id === 46)');
    page.run("openTab('shouts'); view.shoutThread = 'none'; render();");
    const feed = shoutNameText(page.show('feed'));
    assert.match(feed, /<span class="sx-snd seat" title="web-1 \(Test Model\) to coordinator"><i class="sx-si seat"><\/i><span class="sx-sn">web-1<\/span><\/span><span class="sx-tx"><span class="sx-mk ruling">Ruling<\/span>Ship today\?<\/span>/, 'the feed marks an ask');
    assert.match(feed, /<span class="sx-snd you" title="you to coordinator"><i class="sx-si you"><\/i><span class="sx-sn">you<\/span><\/span><span class="sx-tx">French, then English<\/span>/, 'and shows an answer from you');
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
    await readUntil(page, 'data.project.decisions.some(shout => shout.shout_id === 2)');
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
    assert.match(page.show('feed'), /<span class="sx-snd seat" title="web-1 \(Test Model\) to coordinator">/,
      "the native agent question waits on its coordinator in the Questions conversation");
    page.run("openTab('items'); render();");
    assert.match(itemRow(page.show('chain'), 1), /<b class="stage-word">In review<\/b>/, 'work waiting for a verdict keeps its approved stage');
    assert.match(itemRow(page.show('chain'), 1), /<small class="stage-detail" title="awaiting a verdict">awaiting a verdict<\/small>/, 'unassigned submitted work retains its truthful detail below the stage');
    assert.ok(itemRow(page.show('chain'), 2).includes('<b class="item-reason"><span title="BEHAVIOR_MISMATCH">Behavior did not match</span></b> <span class="why">no farewell yet'), 'and work sent back, with why');
    page.run("openTab('shouts'); view.agent = 'web-1'; render();");
    assert.match(page.show('agents'), /<button class="sx-ag back on" type="button" data-agent="web-1" title="web-1 holds #2 and 1 more · Test Model">/, 'the agent retains both built items: its row leads with the one sent back, and its hover names the other');
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
