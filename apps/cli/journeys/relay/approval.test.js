// pullboard: browser
/** @pullboard-test-gui */
/** The CLI's printed and JSON output when a phone approval is refused or approved: init and relay off partial failures, and linked with the board name [H15,H12,H17,E16]. */
import assert from 'node:assert/strict';
import {
  spawn,
  spawnSync,
} from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  readFileSync,
} from 'node:fs';
import {
  dirname,
  resolve,
  join,
} from 'node:path';
import { test } from 'node:test';
import { relayClientFixture } from '../../tests/fixtures/relay/client.js';
import {
  findChromeExecutable,
  startChrome,
} from '../../tests/fixtures/relay/browser.js';
import { stableChrome } from '../../tests/fixtures/cockpit/stable.js';

const CLI = resolve(import.meta.dirname, '../../pullboard.js');
const APPROVAL_TIMEOUT_MS = 90_000;

/** Poll an actual fixture state transition without retrying the operation under test. */
async function waitFor(read, message, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = read();
    if (value) return value;
    await new Promise(resolveWait => setTimeout(resolveWait, 25));
  }
  assert.fail(message);
}

/** Run the production CLI in the isolated project, preserving JSON for precise refusal checks. */
function cliCommand(root, env, args, timeoutMs = APPROVAL_TIMEOUT_MS, { json = true } = {}) {
  const child = spawn(process.execPath, [CLI, ...args, ...(json ? ['--json'] : [])], { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '';
  let stderr = '';
  child.stdout.setEncoding('utf8').on('data', chunk => { stdout += chunk; });
  child.stderr.setEncoding('utf8').on('data', chunk => { stderr += chunk; });
  const done = new Promise((resolveResult, reject) => {
    const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs);
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.once('close', (code, signal) => {
      clearTimeout(timer);
      if (signal) return reject(new Error('A private native approval command exceeded its finite fixture bound.'));
      try { resolveResult({ code, document: json ? JSON.parse(stdout) : null, stdout, stderr }); }
      catch { reject(new Error('The private approval command did not return JSON.')); }
    });
  });
  return { child, done };
}

/** Start foreground machine setup and pair one real Chrome device through the real relay. */
async function pairPhone(box, t) {
  const setup = cliCommand(box.root, box.env, ['relay', 'on', '--all', '--url', box.origin], 120_000);
  let chrome;
  const native = [setup];
  t.after(async () => {
    for (const command of native) if (command.child.exitCode === null) command.child.kill('SIGTERM');
    for (const command of native) await command.done.catch(() => {});
    await chrome?.close();
  });
  const machineFile = join(box.env.PULLBOARD_HOME, 'relay-machine/state.json');
  const pending = await waitFor(() => {
    if (!existsSync(machineFile)) return null;
    return JSON.parse(readFileSync(machineFile, 'utf8')).pending;
  }, 'foreground setup publishes a real one-use phone enrollment');
  chrome = await stableChrome(await startChrome());
  const session = await box.phoneSession();
  assert.equal((await chrome.send('Network.setCookie', { name: 'pb_session', value: session.token, url: box.origin,
    httpOnly: true, sameSite: 'Lax' })).success, true);
  await chrome.navigate(box.origin + '/#device=' + pending.locator + '.' + pending.secret);
  const paired = await setup.done;
  assert.equal(paired.code, 0, 'the real phone enrollment completes native setup');
  await chrome.waitFor("document.querySelector('#phone-approvals') !== null");
  return { chrome, native, machineFile };
}


/** Create a real independent Git project before invoking its public registration command. */
function unregisteredProject(box, name) {
  const root = join(dirname(box.root), name);
  mkdirSync(root);
  for (const args of [['init', '-q', '-b', 'main'],
    ['-c', 'commit.gpgsign=false', 'commit', '--allow-empty', '-q', '-m', 'fixture base'],
    ['remote', 'add', 'origin', 'git@github.com:fixture/repository.git']]) {
    assert.equal(spawnSync('git', args, { cwd: root, env: box.env }).status, 0);
  }
  return root;
}

/** Match a real publication refusal to its native partial failure and preserved local outcome. */
function assertRemoteFailure(box, before, result, action, completed) {
  const post = box.transit.slice(before).find(record => record.method === 'POST'
    && record.path === '/api/v1/devices/approvals');
  assert.ok(post, 'the operation attempted its real remote approval');
  const context = JSON.parse(post.request.toString('utf8')).context;
  const response = JSON.parse(post.response.toString('utf8'));
  assert.equal(context.action, action);
  assert.equal(response.error.code, 'PHONE_APPROVAL_CONTEXT', 'the actual relay refused the proposal');
  assert.equal(result.code, 1, 'a remote publication refusal makes the native command fail');
  if (result.document) {
    assert.deepEqual(result.document.remote, { code: 'PHONE_APPROVAL_CONTEXT',
      reason: 'the relay ' + box.origin + ': ' + response.error.message, requestId: context.id }, 'JSON preserves the original remote refusal separately');
    assert.ok(Array.isArray(result.document.diagnostics), 'the partial failure carries its named diagnostic');
  }
  const lines = result.document?.diagnostics ?? result.stderr.split('\n');
  const refusals = lines.filter(line => line.includes('Remote approval request'));
  assert.equal(refusals.length, 1, 'exactly one line names the partial failure');
  assert.ok(refusals[0].includes(context.id), 'the refusal identifies the exact request');
  assert.ok(refusals[0].includes(response.error.message), 'the refusal retains the relay reason');
  assert.ok(refusals[0].includes(completed), 'the same line names the completed local action');
  assert.match(refusals[0], /\[PHONE_APPROVAL_CONTEXT\]/u);
  assert.match(refusals[0], /explicitly/u, 'the refusal gives an explicit recovery step');
  assert.equal(box.transit.slice(before).some(record => record.method === 'GET'
    && record.path === '/api/v1/devices/approvals/' + context.id), false, 'refused publication never waits for an approval');
}

test('local unlink and registration fail on a remote refusal while retaining local work [H15,H12]', {
  skip: !findChromeExecutable() && 'Chrome is not installed',
}, async t => {
  for (const json of [true, false]) await t.test(json ? 'JSON partial failures' : 'text partial failures', async t => {
    const box = await relayClientFixture(t);
    const { native, machineFile } = await pairPhone(box, t);
    const project = unregisteredProject(box, 'remote-refused-registration');
    box.advance(-31 / 86400);
    const registerBefore = box.transit.length;
    const registration = cliCommand(project, box.env, ['init'], APPROVAL_TIMEOUT_MS, { json });
    native.push(registration);
    const registered = await registration.done;
    const offBefore = box.transit.length;
    const unlink = cliCommand(box.root, box.env, ['relay', 'off'], APPROVAL_TIMEOUT_MS, { json });
    native.push(unlink);
    const off = await unlink.done;
    assert.deepEqual([registered.code, off.code], [1, 1], 'both real native publication-refusal paths fail immediately');
    assertRemoteFailure(box, registerBefore, registered, 'link', 'Local registration is complete');
    assertRemoteFailure(box, offBefore, off, 'delete-board', 'Local link removed');
    assert.equal(existsSync(join(project, '.git/pullboard/board.sqlite')), true, 'registration persists the local board');
    assert.equal(existsSync(join(project, '.git/pullboard/relay.json')), false, 'refused linking does not invent a linked board');
    if (json) assert.equal(off.document.linked, false);
    assert.equal(existsSync(box.linkFile), false, 'local unlink is durable despite the remote publication refusal');
    assert.ok(JSON.parse(readFileSync(machineFile, 'utf8')).excluded.includes(box.root), 'the local opt-out remains durable');
  });
});


/** Register one more committed project; its real init publishes a sealed link card to the phone. */
async function registerProject(box, name) {
  const root = join(dirname(box.root), name);
  mkdirSync(root);
  for (const args of [['init', '-q', '-b', 'main'], ['-c', 'commit.gpgsign=false', 'commit', '--allow-empty', '-q', '-m', 'fixture base'],
    ['remote', 'add', 'origin', `git@github.com:fixture/${name}.git`]]) {
    assert.equal(spawnSync('git', args, { cwd: root, env: box.env }).status, 0);
  }
  const initialized = await cliCommand(root, box.env, ['init']).done;
  assert.equal(initialized.code, 0, 'the new project registers through the actual init command');
  return root;
}

let approvedLinkRun;

/**
 * Walkthrough-090 issue 15 once, for the test below: a paired phone, a new board
 * "notes" whose link card waits on it, relay on --all running, one tap. The snapshot upload is
 * held until the phone has rendered its notice, so the phone is observed before its key arrives.
 */
function approvedLinkScenario(t) {
  approvedLinkRun ??= (async () => {
    const box = await relayClientFixture(t);
    const { chrome, native, machineFile } = await pairPhone(box, t);
    box.providerState.repositories.push('notes');
    const notes = await registerProject(box, 'notes');
    const notesTitle = 'an item only on the newly approved notes board';
    const note = cliCommand(notes, box.env, ['add', box.lane, notesTitle]);
    native.push(note);
    const added = await note.done;
    assert.equal(added.code, 0, `the approved board has its own visible item: ${added.stderr}`);
    const proposal = JSON.parse(readFileSync(machineFile, 'utf8')).approvals.find(entry => entry.root === notes);
    assert.ok(proposal?.published, 'init publishes one sealed link card for notes');
    const board = proposal.context.board;
    const button = '#phone-approve-' + proposal.context.id;
    await chrome.waitFor(`document.querySelector(${JSON.stringify(button)}) !== null`);

    const run = cliCommand(box.root, box.env, ['relay', 'on', '--all', '--url', box.origin], 120_000, { json: false });
    native.push(run);
    let live = '';
    run.child.stdout.on('data', chunk => { live += chunk; });
    await waitFor(() => live.includes('waiting for phone approval: notes') || run.child.exitCode !== null,
      'relay on --all reaches its wait for the phone or exits');
    const waited = live.includes('waiting for phone approval: notes');
    if (!waited) {
      const early = await run.done;
      return { waited, stdout: early.stdout, stderr: early.stderr, code: early.code };
    }

    await chrome.stable(`(() => {
      const notice = document.querySelector('#relay-notice');
      window.__noticeLog = [notice?.textContent ?? ''];
      new MutationObserver(() => window.__noticeLog.push(notice.textContent))
        .observe(notice, { childList: true, subtree: true, characterData: true });
    })()`);
    let held = false;
    let release;
    const released = new Promise(resolveRelease => { release = resolveRelease; });
    box.beforeNextSnapshot(async () => { held = true; await released; });
    await chrome.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
    await chrome.click(`document.querySelector('[data-tab="shouts"]')`);
    await chrome.waitFor(`view.tab === "shouts" && document.querySelector('[data-pane="items"]').hidden`);
    const documentOrigin = await chrome.stable('performance.timeOrigin');
    const authorizeBefore = box.calls.filter(call => call.path.endsWith('/authorize')).length;
    await chrome.click(`document.querySelector(${JSON.stringify(button)})`);
    await waitFor(() => held, 'the computer starts linking notes in the same run once the phone approves');
    let noticeBeforeKey = null;
    try {
      await chrome.waitFor(`(document.querySelector('#relay-notice')?.textContent ?? '').includes(${JSON.stringify(board.slice(0, 8))})
        || (document.querySelector('#relay-notice')?.textContent ?? '').includes('pair this browser')`);
      noticeBeforeKey = await chrome.stable(`document.querySelector('#relay-notice').textContent`);
    } finally { release(); }
    const finished = await run.done;
    const linkedAtExit = existsSync(join(notes, '.git/pullboard/relay.json'));
    let opened = true;
    try {
      await chrome.waitFor(`document.querySelectorAll('#proj-list .proj.repo').length === 2
        && Object.hasOwn(JSON.parse(localStorage.getItem('pullboard.relay.keys.v1') ?? '{}'), ${JSON.stringify(board)})`);
    } catch { opened = false; }
    try { /* budget: hang ceiling for the bounded navigation transition the mobile counter observes; no approval retry. */ await chrome.waitFor(`data?.root === ${JSON.stringify(board)} && document.querySelector('#proj-name')?.textContent === 'notes'
      && document.body.innerText.includes(${JSON.stringify(notesTitle)})`, 6_000); } catch { /* The assertion below names a missed selection directly. */ }
    const displayed = await chrome.stable(`({ root: data?.root, name: document.querySelector('#proj-name')?.textContent,
      text: document.body.innerText })`);
    const visibleItems = [];
    for (const width of [390, 1280]) {
      await chrome.send('Emulation.setDeviceMetricsOverride', { width, height: 844, deviceScaleFactor: 1, mobile: width === 390 });
      visibleItems.push(await chrome.stable(`(() => {
        const pane = document.querySelector('[data-pane="items"]');
        const row = [...document.querySelectorAll('#chain [data-item]')].find(node => node.textContent.includes(${JSON.stringify(notesTitle)}));
        const rect = row?.getBoundingClientRect();
        return { width: innerWidth, tab: view.tab, visible: !pane.hidden && Boolean(rect && row.getClientRects().length && rect.height > 0 && rect.top < innerHeight && rect.bottom > 0) };
      })()`));
    }
    const sameDocument = await chrome.stable('performance.timeOrigin') === documentOrigin;
    const rawKey = readFileSync(join(box.env.PULLBOARD_HOME, 'relay-keys', board + '.key'), 'utf8').trim();
    return {
      waited, code: finished.code, stdout: finished.stdout, stderr: finished.stderr, linkedAtExit, opened, noticeBeforeKey,
      noticeLog: await chrome.stable('window.__noticeLog'), rawKey, targetBoard: board, notesTitle, displayed, visibleItems, sameDocument,
      taps: box.calls.filter(call => call.path.endsWith('/authorize')).length - authorizeBefore,
    };
  })();
  return approvedLinkRun;
}

test('the computer prints linked with the board name [H17,E16]', {
  skip: !findChromeExecutable() && 'Chrome is not installed',
}, async t => {
  const run = await approvedLinkScenario(t);
  const lines = run.stdout.split('\n');
  const waiting = lines.findIndex(line => line.startsWith('waiting for phone approval: notes; '));
  assert.ok(waiting >= 0, `the run says which board waits for the phone: ${run.stdout}`);
  assert.equal(lines.filter(line => line === 'linked: notes').length, 1, `the run prints linked: notes once: ${run.stdout}`);
  assert.ok(lines.indexOf('linked: notes') > waiting, 'linked: notes follows the phone tap in the same run');
  assert.equal(run.stdout.includes(run.rawKey) || run.stderr.includes(run.rawKey), false, 'the board key is never printed');
});
