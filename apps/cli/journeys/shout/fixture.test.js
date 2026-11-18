// pullboard: browser
/** @pullboard-test-gui */
/** @pullboard-test-input source-cell apps/cli */
/** Cockpit Chrome helper checks: startup retry, waits and owned cleanup [N26]. */
import assert from 'node:assert/strict';
import {
  spawn,
} from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { createServer } from 'node:http';
import {
  tmpdir,
} from 'node:os';
import { join } from 'node:path';
import {
  test,
} from 'node:test';
import {
  waitForStableBoxes,
} from '../../tests/fixtures/cockpit/stable.js';
import {
  scratch,
  chromeExecutable,
  startSnapshotChrome,
  openSnapshotChrome,
  stopOwnedChrome,
  closeSnapshotChrome,
} from '../../tests/fixtures/cockpit/harness.js';

test('cli.journeys-shout-fixture.chrome-startup-waits-past-the-old: Chrome startup waits past the old timeout, retries once, and reports final stderr [N26,A10]', { timeout: 45_000 }, async () => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'pullboard-chrome-launch-')));
  scratch.push(dir);
  const profile = join(dir, 'slow-profile');
  mkdirSync(profile);
  const attempts = join(dir, 'slow-attempts');
  const delayed = join(dir, 'delayed-chrome');
  writeFileSync(delayed, `#!/usr/bin/env node
const { readFileSync, writeFileSync, writeSync, mkdirSync } = require('node:fs');
const { dirname, join } = require('node:path');
const profile = process.argv.find((arg) => arg.startsWith('--user-data-dir=')).slice('--user-data-dir='.length);
const attempts = join(dirname(profile), 'slow-attempts');
let count = 0;
try { count = Number(readFileSync(attempts, 'utf8')); } catch {}
writeFileSync(attempts, String(++count));
if (count === 1) { writeSync(2, 'first Chrome launch failed\\n'); process.exit(17); }
setTimeout(() => {
  mkdirSync(profile, { recursive: true });
  writeFileSync(join(profile, 'DevToolsActivePort'), '9333\\n/devtools/browser/fake\\n');
  setInterval(() => {}, 1000);
}, 10_100);
`);
  chmodSync(delayed, 0o755);
  const started = Date.now();
  const chrome = await startSnapshotChrome(delayed, profile);
  try {
    assert.ok(Date.now() - started > 10_000, 'the helper waits beyond its former ten-second limit'); // budget: the stand-in publishes DevToolsActivePort after 10,100 ms.
    assert.equal(chrome.port, '9333');
    assert.equal(readFileSync(attempts, 'utf8'), '2', 'the failed first launch is retried exactly once');
  } finally {
    await stopOwnedChrome(chrome.child, chrome.stopped);
  }

  const failedAttempts = join(dir, 'failed-attempts');
  const failureProfile = join(dir, 'failure-profile');
  mkdirSync(failureProfile);
  const failing = join(dir, 'failing-chrome');
  writeFileSync(failing, `#!/usr/bin/env node
const { readFileSync, writeFileSync, writeSync } = require('node:fs');
const { dirname, join } = require('node:path');
const profile = process.argv.find((arg) => arg.startsWith('--user-data-dir=')).slice('--user-data-dir='.length);
const attempts = join(dirname(profile), 'failed-attempts');
let count = 0;
try { count = Number(readFileSync(attempts, 'utf8')); } catch {}
writeFileSync(attempts, String(++count));
writeSync(2, 'Chrome final stderr marker\\n');
process.exit(19);
`);
  chmodSync(failing, 0o755);
  let failure;
  try { await startSnapshotChrome(failing, failureProfile); }
  catch (error) { failure = error; }
  assert.match(failure?.message ?? '', /Chrome final stderr marker/, 'a real launch failure includes Chrome stderr');
  assert.equal(readFileSync(failedAttempts, 'utf8'), '2', 'the failed launch is retried exactly once');
});

test('cli.journeys-shout-fixture.a-chrome-wait-whose-condition-throws: a Chrome wait whose condition throws while the next document loads keeps polling, and names its last error [N26,C7]', { timeout: 60_000 }, async (t) => {
  const executable = chromeExecutable();
  if (!executable) return t.skip('Install Chrome or set PULLBOARD_CHROME to run the browser wait proof.');
  const server = createServer((request, response) => {
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
    if (request.url === '/late') {
      // The head arrives now and the body 1.5 s later, so the next document parses without #late for a while.
      response.write('<!doctype html><html><head><title>late</title></head>');
      setTimeout(() => response.end('<body><p id="late">the late body arrived</p></body></html>'), 1500);
      return;
    }
    if (request.url === '/fault') {
      response.end('<!doctype html><script>window.__faultRan = true; throw new Error("page fault fixture");</script>');
      return;
    }
    response.end('<!doctype html><p id="first">first page</p>');
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const profile = mkdtempSync(join(tmpdir(), 'pullboard-wait-chrome-'));
  let chrome;
  try {
    const origin = `http://127.0.0.1:${server.address().port}`;
    chrome = await openSnapshotChrome(executable, `${origin}/first`, profile);
    await chrome.waitFor("document.querySelector('#first')?.textContent === 'first page'");
    await chrome.send('Page.navigate', { url: `${origin}/late` });
    await chrome.waitFor("document.querySelector('#late').textContent.includes('the late body arrived')");
    await assert.rejects(chrome.waitFor("document.querySelector('#never').textContent === 'never'", 1000), // budget: 1,000 ms is only a ceiling for an impossible browser condition.
      /^Error: Browser condition did not arrive: .*#never.*; it last threw: TypeError: Cannot read properties of null/u);
    assert.deepEqual(chrome.exceptions, [], 'a condition that throws is not a page exception');
    await chrome.send('Page.navigate', { url: `${origin}/fault` });
    await chrome.waitFor('window.__faultRan === true');
    assert.equal(chrome.exceptions.length, 1, 'an exception the page throws by itself is still collected');
  } finally {
    if (chrome) await closeSnapshotChrome(chrome);
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    rmSync(profile, { recursive: true, force: true });
  }
});

test('cli.journeys-shout-fixture.owned-chrome-cleanup-waits-out-a: owned Chrome cleanup waits out a slow exit and still fails a real hang [C7,N26]', async t => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'pullboard-owned-chrome-cleanup-')));
  scratch.push(dir);
  const launched = [];
  const independent = [];
  /** Launch a private stand-in and retain its close promise just as the cockpit launcher does. */
  function launch(code, args = []) {
    const child = spawn(process.execPath, ['-e', code, ...args], { detached: true, stdio: ['ignore', 'ignore', 'pipe'] });
    child.stderr.resume();
    const stopped = new Promise(resolve => child.once('close', resolve));
    const result = { child, stopped };
    launched.push(result);
    return result;
  }
  /** Wait for the child to install its signal handlers before testing cleanup. */
  async function ready(path) {
    const deadline = Date.now() + 10_000;
    while (!existsSync(path) && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 20));
    assert.ok(existsSync(path), 'the owned stand-in installed its handlers');
  }
  t.after(async () => {
    for (const pid of independent) {
      try { process.kill(pid, 'SIGKILL'); } catch (error) { if (error.code !== 'ESRCH') throw error; }
    }
    for (const { child, stopped } of launched) {
      try { process.kill(-child.pid, 'SIGKILL'); } catch (error) { if (error.code !== 'ESRCH') throw error; }
      child.stderr.destroy();
      await stopped;
    }
  });

  const pipeReady = join(dir, 'pipe-ready');
  const holder = `const fs = require('node:fs'); fs.writeFileSync(process.argv[1], String(process.pid)); setInterval(() => {}, 1000);`;
  const pipe = launch(`const { spawn } = require('node:child_process');
    process.on('SIGTERM', () => process.exit(0));
    const helper = spawn(process.execPath, ['-e', process.argv[1], process.argv[2]], { detached: true, stdio: ['ignore', 'ignore', 'inherit'] });
    helper.unref(); setInterval(() => {}, 1000);`, [holder, pipeReady]);
  await ready(pipeReady);
  const holderPid = Number(readFileSync(pipeReady, 'utf8'));
  independent.push(holderPid);
  const nativeKill = process.kill.bind(process);
  let permissionProbe = false;
  const kill = t.mock.method(process, 'kill', (pid, signal) => {
    if (pid === -pipe.child.pid && signal === 0 && !permissionProbe) {
      permissionProbe = true;
      throw Object.assign(new Error('probe temporarily refused'), { code: 'EPERM' });
    }
    return nativeKill(pid, signal);
  });
  try { await stopOwnedChrome(pipe.child, pipe.stopped); }
  finally { kill.mock.restore(); }
  assert.equal(permissionProbe, true, 'a refused group probe cannot prove the group has exited');
  assert.doesNotThrow(() => process.kill(holderPid, 0), 'cleanup releases stderr without killing an independent holder');
  assert.ok(pipe.child.exitCode !== null || pipe.child.signalCode !== null, 'the owned leader exited');

  const slowReady = join(dir, 'slow-ready');
  const slowFinished = join(dir, 'slow-finished');
  const slowHelper = `const fs = require('node:fs');
    process.on('SIGTERM', () => setTimeout(() => { fs.writeFileSync(process.argv[2], 'finished'); process.exit(0); }, 150));
    fs.writeFileSync(process.argv[1], 'ready'); setInterval(() => {}, 1000);`;
  const slow = launch(`const { spawn } = require('node:child_process');
    process.on('SIGTERM', () => process.exit(0));
    spawn(process.execPath, ['-e', process.argv[1], process.argv[2], process.argv[3]], { stdio: 'ignore' });
    setInterval(() => {}, 1000);`, [slowHelper, slowReady, slowFinished]);
  await ready(slowReady);
  await stopOwnedChrome(slow.child, slow.stopped);
  assert.equal(readFileSync(slowFinished, 'utf8'), 'finished', 'cleanup waited for the helper after the leader and its pipe closed');
  assert.throws(() => process.kill(-slow.child.pid, 0), { code: 'ESRCH' }, 'no owned helper survives successful cleanup');

  const hangReady = join(dir, 'hang-ready');
  const hung = launch(`const fs = require('node:fs'); fs.writeFileSync(process.argv[1], 'ready'); setInterval(() => {}, 1000);`, [hangReady]);
  await ready(hangReady);
  const signals = [];
  await assert.rejects(stopOwnedChrome(hung.child, hung.stopped, {
    timeoutMs: 100, // budget: the stand-in intentionally survives both signals; bound only this forced failure.
    signal: (pid, name) => { signals.push({ pid, name }); },
  }), error => {
    assert.match(error.message, /did not exit after SIGKILL; waited \d+ms; live pids:/u);
    assert.ok(error.message.split('live pids: ')[1].split(', ').includes(String(hung.child.pid)), 'the hang names its surviving pid');
    assert.doesNotThrow(() => process.kill(hung.child.pid, 0), 'the reported hang is an actual surviving stand-in');
    return true;
  });
  assert.deepEqual(signals, [
    { pid: -hung.child.pid, name: 'SIGTERM' },
    { pid: -hung.child.pid, name: 'SIGKILL' },
  ], 'cleanup tries both signals against only its owned group');
});


test('cli.journeys-shout-fixture.a-timed-out-wait-names-what: a timed-out wait names what moved [N26,C7]', { timeout: 60_000 }, async () => {
  const executable = chromeExecutable();
  assert.ok(executable, 'Chrome is required for the wait capture control');
  const responses = new Set();
  const server = createServer((request, response) => {
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    // Keep parsing open so the loading observation is from a real unfinished document.
    response.write('<!doctype html><html><body class="loading switching" style="height:4000px">'
      + '<button id="capture-target" style="position:fixed;top:100px;left:20px;width:100px;height:40px">private stand-in text</button>'
      + '<div id="capture-noise" style="width:20px;height:10px"></div>');
    responses.add(response);
    response.once('close', () => responses.delete(response));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const profile = mkdtempSync(join(tmpdir(), 'pullboard-wait-capture-'));
  let chrome;
  try {
    chrome = await openSnapshotChrome(executable, `http://127.0.0.1:${server.address().port}`, profile);
    await chrome.waitFor("!!document.querySelector('#capture-target')");
    const controls = [
      ['target', "node.style.width = (100 + step % 2) + 'px'"],
      ['replacement', "const next = node.cloneNode(true); node.replaceWith(next); node = next"],
      ['text', "node.textContent = String(step % 2)"],
      ['scroll', "scrollTo(0, 30 * (step % 2))"],
    ];
    for (const [kind, mutate] of controls) {
      await chrome.stable('window.__captureStep = 0');
      const find = `(() => {
        const step = ++window.__captureStep;
        let node = document.querySelector('#capture-target');
        document.querySelector('#capture-noise').style.width = (20 + step % 2) + 'px';
        ${mutate};
        return node;
      })()`;
      let failure;
      try { await waitForStableBoxes(chrome, find, 1000); } // budget: declared negative-control deadline for a deliberately moving stand-in page.
      catch (error) { failure = error; }
      assert.match(failure?.message ?? '', /shared wait: target missing, zero-sized or moving:/);
      assert.ok(failure.message.includes('; wait capture '), 'timeout includes bounded wait capture');
      const capture = JSON.parse(failure.message.split('; wait capture ')[1].split('\n')[0]);
      assert.ok(capture.changes[kind] > 0, `${kind} is measured: ${JSON.stringify(capture)}`);
      assert.ok(capture.samples.length > 0 && capture.samples.length <= 4, 'only the bounded tail is retained');
      assert.ok(capture.samples.some(sample => sample.targets?.length), 'the actual target boxes are retained');
      assert.ok(capture.frames > 0 && capture.maxFrameGapMs >= 0, 'frame count and gap are measured');
      assert.ok(capture.samples.every(sample => sample.sampleMs >= 0), 'each layout sample records its duration');
      assert.equal(capture.page.readyState, 'loading');
      assert.equal(capture.page.loading, true);
      assert.equal(capture.page.switching, true);
      assert.ok(JSON.stringify(capture).length < 7000, 'the diagnostic is bounded independently of the page contents');
      assert.ok(!JSON.stringify(capture).includes('private stand-in text'), 'text changes do not copy board contents');
      for (const absent of ['target', 'replacement', 'text', 'scroll'].filter(signal => signal !== kind)) {
        assert.equal(capture.changes[absent], 0, `${kind} does not falsely report ${absent}`);
      }
    }
    await assert.rejects(chrome.waitFor('false', 1000), error => { // budget: declared negative-control deadline for a condition that never becomes true.
      const capture = JSON.parse(error.message.split('; readiness capture ')[1]);
      assert.ok(capture.polls > 0 && capture.falseResults === capture.polls);
      assert.ok(capture.lastPollMs >= 0 && capture.maxPollMs >= capture.lastPollMs);
      assert.equal(capture.lastStable.page.readyState, 'loading');
      assert.equal(capture.lastStable.page.switching, true);
      assert.ok(capture.lastStable.samples.length <= 4);
      return true;
    });
    for (const response of responses) response.end('</body></html>');
    await chrome.waitFor("document.readyState === 'complete'");
    assert.deepEqual(chrome.exceptions, [], 'capture does not create a page exception');
  } finally {
    if (chrome) await closeSnapshotChrome(chrome);
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    rmSync(profile, { recursive: true, force: true });
  }
});
