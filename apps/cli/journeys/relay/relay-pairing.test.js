// pullboard: browser
/** @pullboard-test-gui */
/** The command shown to a second browser enrolls it without replacing the first [H15,H17]. */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { relayClientFixture } from '../../tests/fixtures/relay/client.js';
import { findChromeExecutable } from '../../tests/fixtures/relay/browser.js';
import { startChrome } from '../../tests/fixtures/relay/browser.js';
import { stableChrome } from '../../tests/fixtures/cockpit/stable.js';

/** Observe real machine enrollment until the command exits, without fabricating relay state. */
async function pendingEnrollment(file, command) {
  const until = Date.now() + command.deadlineMs;
  while (Date.now() < until) {
    let state;
    try { state = JSON.parse(readFileSync(file, 'utf8')); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (state?.pending) return state.pending;
    if (command.child.exitCode !== null || command.child.signalCode !== null) return null;
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  assert.fail('the real pairing command never published a fresh browser enrollment');
}

/** Sign the second browser in through a distinct real OAuth session, never reuse a device-bound cookie. */
async function secondBrowserSession(origin) {
  const start = await fetch(origin + '/auth/github/start', { redirect: 'manual' });
  const binding = start.headers.getSetCookie().find(value => value.startsWith('pb_oauth_binding=')).split(';')[0];
  const approved = await fetch(start.headers.get('location'), { redirect: 'manual' });
  const callback = await fetch(approved.headers.get('location'), { redirect: 'manual', headers: { cookie: binding } });
  assert.equal(callback.status, 303, 'the second browser has its own real OAuth sign-in');
  return callback.headers.getSetCookie().find(value => value.startsWith('pb_session=')).split(';')[0].slice('pb_session='.length);
}

/** Read only public device identity and private-key extractability from actual browser storage. */
function deviceExpression() {
  return `new Promise((resolve, reject) => { const request = indexedDB.open('pullboard-relay-device-v1', 1);
    request.onsuccess = () => { const db = request.result; const read = db.transaction('keys').objectStore('keys').get('device');
      read.onsuccess = () => { const value = read.result; db.close(); resolve({ id: value.deviceId, extractable: value.privateKey.extractable }); };
      read.onerror = () => reject(new Error('private fixture device read failed')); };
    request.onerror = () => reject(new Error('private fixture browser storage unavailable')); })`;
}

test('clause 1: a second browser pairs with the command the page names after the first is paired [H15,H17]', async t => {
  assert.ok(findChromeExecutable(), 'the acceptance case requires the installed real browser');
  const box = await relayClientFixture(t);
  const browsers = [];
  t.after(async () => {
    const outcomes = await Promise.allSettled(browsers.map(browser => browser.close()));
    for (const outcome of outcomes) if (outcome.status === 'rejected') throw outcome.reason;
  });
  const machineFile = join(box.env.PULLBOARD_HOME, 'relay-machine/state.json');
  const firstCommand = box.startCli(['relay', 'on', '--all', '--url', box.origin]);
  const firstPending = await pendingEnrollment(machineFile, firstCommand);
  assert.ok(firstPending, 'real on --all publishes the first browser enrollment');
  const first = await stableChrome(await startChrome({ profileDirectory: join(box.env.HOME, 'first-browser') }));
  browsers.push(first);
  const session = await box.phoneSession();
  assert.equal((await first.send('Network.setCookie', { name: 'pb_session', value: session.token, url: box.origin, httpOnly: true, sameSite: 'Lax' })).success, true);
  await first.navigate(box.origin + '/#device=' + firstPending.locator + '.' + firstPending.secret);
  const firstDone = await firstCommand.closed;
  assert.equal(firstDone.code, 0, 'the first real enrollment completes');
  await first.waitFor("document.querySelectorAll('#proj-list .proj.repo').length === 1");
  await first.waitFor("data?.project?.items?.some(item => item.title === 'private cleanup fixture item') && document.querySelector('[data-tab=items]')");
  await first.click("document.querySelector('[data-tab=items]')");
  await first.waitFor("document.querySelector('#chain')?.textContent.includes('private cleanup fixture item')");
  const firstDevice = await first.stable(deviceExpression());
  assert.equal(firstDevice.extractable, false);

  const second = await stableChrome(await startChrome({ profileDirectory: join(box.env.HOME, 'second-browser') }));
  browsers.push(second);
  assert.equal((await second.send('Network.setCookie', { name: 'pb_session', value: await secondBrowserSession(box.origin), url: box.origin, httpOnly: true, sameSite: 'Lax' })).success, true);
  await second.navigate(box.origin + '/');
  await second.waitFor("document.querySelector('.relay-command:not([hidden]) code')?.textContent.includes('pullboard relay')");
  const named = await second.stable("document.querySelector('.relay-command code').textContent.replace(/^\\$\\s*/, '').trim()");
  assert.match(named, /^pullboard relay /u, 'the real second browser names a native pairing command');
  const args = named.split(/\s+/u);
  assert.equal(args.shift(), 'pullboard');
  const secondCommand = box.startCli(args);
  const secondPending = await pendingEnrollment(machineFile, secondCommand);
  assert.ok(secondPending, 'the command the second browser names publishes a fresh enrollment');
  assert.notEqual(secondPending.locator, firstPending.locator, 'the second enrollment is fresh');
  await second.navigate(box.origin + '/#device=' + secondPending.locator + '.' + secondPending.secret);
  assert.equal((await secondCommand.closed).code, 0, 'the second real enrollment completes');
  await second.waitFor("document.querySelectorAll('#proj-list .proj.repo').length === 1");
  await second.waitFor("data?.project?.items?.some(item => item.title === 'private cleanup fixture item') && document.querySelector('[data-tab=items]')");
  await second.click("document.querySelector('[data-tab=items]')");
  await second.waitFor("document.querySelector('#chain')?.textContent.includes('private cleanup fixture item')");
  const secondDevice = await second.stable(deviceExpression());
  assert.equal(secondDevice.extractable, false);
  assert.notEqual(secondDevice.id, firstDevice.id, 'independent browser profiles retain distinct keys');
  const state = JSON.parse(readFileSync(machineFile, 'utf8'));
  assert.deepEqual(state.devices.map(device => device.deviceId).sort(), [firstDevice.id, secondDevice.id].sort(), 'both browser enrollments remain on this machine');
  assert.equal(state.pending, null);
  const freshTitle = 'Fresh board content after the second browser paired';
  assert.equal((await box.cli('add', box.lane, freshTitle)).code, 0, 'a real later native move publishes fresh content');
  for (const browser of [first, second]) {
    await browser.navigate(box.origin + '/');
    await browser.waitFor("data?.project?.items?.some(item => item.title === " + JSON.stringify(freshTitle) + ") && document.querySelector('[data-tab=items]')");
    await browser.click("document.querySelector('[data-tab=items]')");
    await browser.waitFor("document.querySelector('#chain')?.textContent.includes(" + JSON.stringify(freshTitle) + ")");
  }
  assert.equal((await first.stable(deviceExpression())).id, firstDevice.id, 'the first browser still opens its board with its original key');
});
