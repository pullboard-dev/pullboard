// pullboard: browser
/** @pullboard-test-input source-tree */
/** @pullboard-test-gui */
/** Cockpit Rulings approval and sentinel-draft checks, split from needs.test.js to keep each file under its time budget [N26]. */
import assert from 'node:assert/strict';
import {
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import {
  SPEC,
  machine,
  project,
  startView,
  openPage,
  chromeExecutable,
  openSnapshotChrome,
  closeSnapshotChrome,
  boardId,
  boardOf,
  serveFolder,
  openItemsNeeds,
} from '../../../tests/fixtures/cockpit/harness.js';
import {
  approvalAgentApi,
  approvalReadGate,
} from '../../../tests/fixtures/cockpit/approval.js';
import { runCliInProcess } from '../../../tests/fixtures/process.js';

test('an agent-approved row shows in Rulings with its agent and commit and a confirm and decline move [S1,B26,P6,N26]', { timeout: 120_000 }, async () => { // budget: isolated real Git/API setup and two owned browser profiles, not a performance claim.
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
    page.run("openTab('items'); render();");
    for (const row of flagged) {
      assert.ok(page.show('needs').includes(`data-agent-approved="${row.id}"`), 'agent-approved calls have their own Rulings row');
      assert.equal(row.agent, 'Agent & \"unconfirmed\" seat');
      assert.ok(page.show('needs').includes('Agent &amp; &quot;unconfirmed&quot; seat'), 'author text is escaped rather than promoted into markup');
      assert.ok(page.show('needs').includes(row.commit));
      assert.ok(page.show('needs').includes('Approved in Git'), 'Git provenance is expressed plainly without inventing a person identity');
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
    await box.inProcess(alpha.repo, 'view', '--export', output);
    snapshotHost = await serveFolder(output, '/agent/');
    chrome = await openSnapshotChrome(executable, snapshotHost.base + '/agent/', join(box.dir, 'agent-approval-readonly-chrome'));
    await chrome.waitFor('data?.project');
    await chrome.click('document.querySelector("[data-tab=items]")');
    await chrome.waitFor('document.querySelectorAll("#needs [data-agent-approved]").length === 2');
    const agentRows = await chrome.stable('document.querySelector("#needs").innerHTML');
    assert.match(agentRows, /agent-approved/u);
    assert.doesNotMatch(agentRows, /data-row-decision/u, 'a read-only reader sees attribution without a person move');
    const copyButtons = await chrome.stable(`Array.from(document.querySelectorAll('#needs button'), button => ({ type: button.type, className: button.className, title: button.title, copy: button.dataset.copy, text: button.textContent }))`);
    assert.deepEqual(copyButtons, flagged.map(row => ({ type: 'button', className: 'hash-copy', title: row.commit, copy: row.commit, text: row.commit.slice(0, 12) })), 'the only read-only buttons copy the full attributed hashes and display twelve characters');
    await closeSnapshotChrome(chrome); chrome = null;
    box.env.CLAUDECODE = '1';
    const refused = await runCliInProcess(['spec', 'approve', 'G1', '--json'], { cwd: alpha.web, env: box.env });
    delete box.env.CLAUDECODE;
    assert.equal(refused.status, 1);
    assert.equal(JSON.parse(refused.stdout).error.code, 'B26_PERSON_CHANNEL');
    chrome = await openSnapshotChrome(executable, 'about:blank', join(box.dir, 'agent-approval-person-chrome'));
    reads = await approvalReadGate(chrome, view.base);
    await chrome.send('Page.navigate', { url: view.link.href });
    await chrome.waitFor('data?.project');
    await chrome.click('document.querySelector("[data-tab=items]")');
    await chrome.waitFor('document.querySelectorAll("#needs [data-agent-approved]").length === 2');
    await chrome.click('document.querySelector("[data-tab=items]")');
    await chrome.waitFor("view.tab === 'items' && !document.querySelector('[data-pane=items]').hidden");
    await openItemsNeeds(chrome);
    if (!await chrome.stable(`document.querySelector('#needs [data-agent-approved="G1"] details').open`)) {
      await chrome.click(`document.querySelector('#needs [data-agent-approved="G1"] summary')`);
    }
    await chrome.click(`document.querySelector('#needs [data-agent-approved="G1"] [data-row-decision="approve"]')`);
    await chrome.waitFor('document.querySelector(\'#needs [data-agent-approved="G1"]\') === null');
    const confirmed = await boardOf(view, alpha.repo);
    assert.equal(confirmed.spec.find(row => row.id === 'G1').agentApproval, null);
    assert.equal(confirmed.needs.some(row => row.kind === 'agent-approved' && row.id === 'G1'), false);
    if (!await chrome.stable(`document.querySelector('#needs [data-agent-approved="G2"] details').open`)) {
      await chrome.click(`document.querySelector('#needs [data-agent-approved="G2"] summary')`);
    }
    await chrome.click(`document.querySelector('#needs [data-agent-approved="G2"] [data-row-decision="decline"]')`);
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
      if (!await chrome.stable(`document.querySelector('#needs [data-agent-approved="G2"] details').open`)) {
        await chrome.click(`document.querySelector('#needs [data-agent-approved="G2"] summary')`);
      }
      await chrome.click(`document.querySelector('#needs [data-agent-approved="G2"] [data-row-decision="approve"]')`);
      await chrome.waitFor('document.querySelector(\'#needs [data-agent-approved="G2"] .spec-feedback.no\') !== null');
      const refusal = await chrome.stable('document.querySelector(\'#needs [data-agent-approved="G2"] .spec-feedback.no\').textContent');
      assert.match(refusal, /G2/u, 'the actual backend refusal is visible beside the initiating Rulings row');
      assert.ok(reads.heldCount() > 0, 'real state responses remain held until refusal is observed and SPEC is restored');
    } finally { writeFileSync(specFile, specText); await reads.release(); }
    await chrome.stable('refresh()');
    await chrome.waitFor('document.querySelector(\'#needs [data-agent-approved="G2"]\') !== null');
    if (!await chrome.stable(`document.querySelector('#needs [data-agent-approved="G2"] details').open`)) {
      await chrome.click(`document.querySelector('#needs [data-agent-approved="G2"] summary')`);
    }
    await chrome.click(`document.querySelector('#needs [data-agent-approved="G2"] [data-row-decision="decline"]')`);
    await chrome.click('document.querySelector("#spec-decline-reason")');
    await chrome.send('Input.insertText', { text: 'The person declines this unconfirmed requirement.' });
    await chrome.click('document.querySelector("#spec-decline-submit")');
    await chrome.waitFor('document.querySelector(\'#needs [data-agent-approved="G2"]\') === null');
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

test('a sentinel draft in Rulings is approved and declined from the view [N26,B26]', { timeout: 120_000 }, async () => { // budget: isolated real Git/API setup and one owned browser profile, not a performance claim.
  const executable = chromeExecutable();
  assert.ok(executable, 'Chrome is required to prove real person approval and decline controls');
  const box = machine();
  const alpha = project(box, 'sentinel decisions');
  const command = 'node packages/gate/src/io/file/size.js';
  const directory = 'checks';
  for (const name of ['approve-watch', 'decline-watch']) {
    await box.inProcess(alpha.repo, 'sentinel', 'propose', name, '--check', command, '--directory', directory, '--every', 'hourly', '--owner', 'coordinator');
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
    await chrome.waitFor('data?.project');
    await chrome.click('document.querySelector("[data-tab=items]")');
    await chrome.waitFor('document.querySelectorAll("#needs [data-sentinel-draft]").length === 2');
    await chrome.click('document.querySelector("[data-tab=items]")');
    await chrome.waitFor("view.tab === 'items' && !document.querySelector('[data-pane=items]').hidden");
    await openItemsNeeds(chrome);
    const rows = JSON.parse(await chrome.stable(`JSON.stringify([...document.querySelectorAll('#needs [data-sentinel-draft]')].map(row => ({
      name: row.dataset.sentinelDraft, text: row.textContent, directory: row.querySelector('[data-needs-field=directory]')?.textContent,
      actions: [...row.querySelectorAll('button')].map(button => [button.dataset.sentinelDecision, button.textContent.trim()]),
    })))`));
    for (const row of rows) {
      assert.deepEqual(row.actions, [['approve', 'Approve'], ['decline', 'Decline']], 'each pending proposal has explicit person controls');
      assert.ok(row.text.includes(command), 'the person sees the exact proposed command');
      assert.equal(row.directory, 'checks', 'the person sees the working folder');
      assert.match(row.text, /hourly/u, 'the person sees the schedule');
      assert.match(row.text, /coordinator/u, 'the person sees the owner');
    }

    if (!await chrome.stable(`document.querySelector('#needs [data-sentinel-draft="approve-watch"] details').open`)) {
      await chrome.click(`document.querySelector('#needs [data-sentinel-draft="approve-watch"] summary')`);
    }
    await chrome.click(`document.querySelector('#needs [data-sentinel-draft="approve-watch"] [data-sentinel-decision="approve"]')`);
    await chrome.waitFor('document.querySelector(\'#needs [data-sentinel-draft="approve-watch"]\') === null');
    let recorded = JSON.parse(await box.inProcess(alpha.repo, 'sentinels', '--json')).sentinels;
    assert.equal(recorded.find((row) => row.name === 'approve-watch').status, 'approved', 'the view approval is recorded on the board');

    if (!await chrome.stable(`document.querySelector('#needs [data-sentinel-draft="decline-watch"] details').open`)) {
      await chrome.click(`document.querySelector('#needs [data-sentinel-draft="decline-watch"] summary')`);
    }
    await chrome.click(`document.querySelector('#needs [data-sentinel-draft="decline-watch"] [data-sentinel-decision="decline"]')`);
    await chrome.waitFor('document.querySelector("#spec-decline-dialog").hidden === false');
    assert.equal(await chrome.stable('document.querySelector("#spec-decline-reason").required'), true, 'decline requires a reason');
    await chrome.click('document.querySelector("#spec-decline-submit")');
    assert.ok((await boardOf(view, alpha.repo)).sentinelDrafts.some((row) => row.ref === 'decline-watch'), 'an empty decline leaves the proposal pending');
    await chrome.click('document.querySelector("#spec-decline-reason")');
    await chrome.send('Input.insertText', { text: 'This watch should not run.' });
    await chrome.click('document.querySelector("#spec-decline-submit")');
    try {
      await chrome.waitFor('document.querySelector(\'#needs [data-sentinel-draft="decline-watch"]\') === null');
    } catch (error) {
      const diagnostic = {};
      try {
        diagnostic.ui = JSON.parse(await chrome.stable(`JSON.stringify({
          console: { text: document.querySelector('#console')?.textContent, className: document.querySelector('#console')?.className, hidden: document.querySelector('#console')?.hidden },
          reason: document.querySelector('#spec-decline-reason')?.value,
          request: view.request,
          decline: { id: view.declining, kind: view.declineKind, digest: view.declineDigest, root: view.declineRoot, anchorConnected: Boolean(view.declineAnchor?.isConnected) },
          active: { tag: document.activeElement?.tagName, id: document.activeElement?.id, decision: document.activeElement?.dataset?.sentinelDecision },
          row: document.querySelector('#needs [data-sentinel-draft="decline-watch"]')?.textContent,
        })`));
      } catch (diagnosticError) { diagnostic.uiError = String(diagnosticError.message || diagnosticError); }
      try {
        diagnostic.backend = JSON.parse(await box.inProcess(alpha.repo, 'sentinels', '--json')).sentinels.find((row) => row.name === 'decline-watch');
      } catch (diagnosticError) { diagnostic.backendError = String(diagnosticError.message || diagnosticError); }
      error.message += '; decline diagnostic ' + JSON.stringify(diagnostic);
      throw error;
    }
    recorded = JSON.parse(await box.inProcess(alpha.repo, 'sentinels', '--json')).sentinels;
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
