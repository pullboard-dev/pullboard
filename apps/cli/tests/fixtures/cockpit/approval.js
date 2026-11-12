/** Real standalone API authority for agent-approved row browser proofs [A9,B26,P6]. */
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { startFixtureChild } from '../child.js';
import { fetchLive } from './harness.js';

/** Start the real private API, whose session key grants board access but no person channel. */
export async function approvalAgentApi(box, root) {
  const bin = join(import.meta.dirname, '../../../pullboard.js');
  const child = startFixtureChild(process.execPath, [bin, 'serve', '--port', '0'], { cwd: root, env: box.env });
  child.stderr.resume();
  let stopPromise;
  /** Stop only this fixture-owned server and wait for its process to exit. */
  const stop = () => {
    if (!stopPromise) stopPromise = new Promise(done => {
      if (child.exitCode !== null || child.signalCode !== null) return done();
      child.once('exit', done);
      child.kill('SIGTERM');
    });
    return stopPromise;
  };
  let url;
  try {
    url = await new Promise((resolve, reject) => {
      let output = '';
      // Startup hang ceiling for a private process and socket, not a performance claim.
      const timer = setTimeout(() => reject(new Error('private agent API did not publish its address')), 15_000); // budget: private process/socket startup hang ceiling, not a performance claim.
      child.once('exit', code => { clearTimeout(timer); reject(new Error('private agent API exited ' + code)); });
      child.stdout.on('data', chunk => {
        output += chunk;
        const found = /Pullboard API v1: (http:\/\/127\.0\.0\.1:\d+\/api\/v1\/boards\?k=\S+)/u.exec(output);
        if (found) { clearTimeout(timer); resolve(new URL(found[1])); }
      });
    });
  } catch (error) { await stop(); throw error; }
  const headers = { 'x-pullboard-key': url.searchParams.get('k') };
  /** Exercise the actual HTTP authentication and person-channel refusal with this agent key. */
  const call = async (path, body) => {
    const response = await fetchLive(url.origin + path, {
      method: body === undefined ? 'GET' : 'POST',
      headers: { ...headers, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const document = await response.json();
    return { status: response.status, document };
  };
  try {
    const listed = await call('/api/v1/boards');
    assert.equal(listed.status, 200);
    return { call, stop };
  } catch (error) { await stop(); throw error; }
}

/** Hold actual HTTP state responses in DevTools, without modifying requests, auth or payloads. */
export async function approvalReadGate(chrome, origin) {
  let holding = false;
  const held = [];
  const observers = new Set();
  const failures = [];
  /** Continue an unchanged network response, retaining unexpected interception failures. */
  const proceed = requestId => chrome.send('Fetch.continueResponse', { requestId }).catch(error => { failures.push(error.message); });
  /** Delay only read responses; person POSTs still reach the actual backend immediately. */
  const listener = ({ data }) => {
    const message = JSON.parse(String(data));
    if (message.method !== 'Fetch.requestPaused') return;
    const { requestId } = message.params;
    if (holding) { held.push(requestId); for (const observe of observers) observe(); }
    else void proceed(requestId);
  };
  chrome.socket.addEventListener('message', listener);
  try {
    await chrome.send('Fetch.enable', { patterns: [{ urlPattern: origin + '/api/v1/boards/*/state*', requestStage: 'Response' }] });
  } catch (error) { chrome.socket.removeEventListener('message', listener); throw error; }
  /** Release the real responses only after the isolated spec has been restored. */
  const release = async () => {
    holding = false;
    await Promise.all(held.splice(0).map(proceed));
    assert.deepEqual(failures, [], 'read gate continues original HTTP responses unchanged');
  };
  /** Require a real response to be paused, with a bounded hang ceiling and no fabricated read. */
  const waitForHeld = () => new Promise((resolve, reject) => {
    if (held.length) return resolve(held.length);
    const observe = () => { clearTimeout(timer); observers.delete(observe); resolve(held.length); };
    // Fixture coordination hang ceiling, not a response-time performance requirement.
    const timer = setTimeout(() => { observers.delete(observe); reject(new Error('no actual state response entered the read gate')); }, 10_000); // budget: actual-response coordination hang ceiling, not response-time performance.
    observers.add(observe);
  });
  /** Unlock every held read and remove only this fixture's DevTools interception. */
  const close = async () => {
    try { await release(); }
    finally { await chrome.send('Fetch.disable'); chrome.socket.removeEventListener('message', listener); }
  };
  return { hold: () => { holding = true; }, heldCount: () => held.length, waitForHeld, release, close };
}
