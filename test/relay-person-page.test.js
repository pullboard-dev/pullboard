/** Actual relay cockpit request capability and exported read-only guards [H12,H5]. */
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { cockpitPage } from '../src/cockpit.js';
import { ENGINE_VERSION } from '../src/machine.js';
import { findChromeExecutable, startChrome } from './relay-browser-fixture.js';
import { relayClientFixture } from './relay-client-fixture.js';

const chromeOptions = { skip: !findChromeExecutable() && 'Chrome is not installed' };

test('the actual relay page seals its shout and refuses generic direct moves [H12,H5]', chromeOptions, async t => {
  const box = await relayClientFixture(t);
  await box.link();
  const link = JSON.parse(readFileSync(box.linkFile, 'utf8'));
  const chrome = await startChrome();
  t.after(() => chrome.close());
  const cookie = await chrome.send('Network.setCookie', { name: 'pb_session', value: link.token, url: box.origin, httpOnly: true, sameSite: 'Lax' });
  assert.equal(cookie.success, true);
  await chrome.navigate(box.origin + '/#board=' + link.board + '&key=' + readFileSync(box.keyFile, 'utf8').trim());
  await chrome.waitFor('typeof data !== "undefined" && !!data?.project && !!transport');
  const capability = await chrome.evaluate('({readOnly,requests,snapshot,display:getComputedStyle(document.querySelector("#shout-form")).display})');
  assert.deepEqual(capability, { readOnly: true, requests: true, snapshot: false, display: 'flex' });
  const before = (await box.cli('export')).document;
  const callsBefore = box.calls.length;
  const direct = await chrome.evaluate(`api(boardPath(view.root) + '/moves', {verb:'claim',item:1}).then(() => 'allowed', error => error.message)`);
  assert.match(direct, /read-only view/);
  assert.equal(box.calls.slice(callsBefore).some(call => call.method === 'POST'), false, 'the generic direct move never reaches the relay');
  await chrome.evaluate(`document.querySelector('[data-tab=shouts]').click(); document.querySelector('#shout-to').value='coordinator'; document.querySelector('#shout-text').value='RELAY_PAGE_SEALED_SHOUT'; document.querySelector('#shout-form').requestSubmit(); true`);
  await chrome.waitFor('data.project.personRequests?.some(row => row.move?.args?.text === "RELAY_PAGE_SEALED_SHOUT")');

  const request = await chrome.evaluate('data.project.personRequests.find(row => row.move?.args?.text === "RELAY_PAGE_SEALED_SHOUT")');
  assert.equal(request.status, 'waiting');
  assert.deepEqual(request.move, { verb: 'shout', args: { to: 'coordinator', text: 'RELAY_PAGE_SEALED_SHOUT' } });
  assert.equal(box.calls.some(call => call.method === 'POST' && call.path === `/api/v1/boards/${link.board}/requests`), true);
  assert.equal(box.calls.slice(callsBefore).some(call => call.method === 'POST' && call.path.endsWith('/moves')), false, 'the page never posts an executable engine move');
  const response = await fetch(box.origin + '/api/v1/boards/' + link.board + '/events?after=0', { headers: { authorization: 'Bearer ' + link.token, 'x-pullboard-engine': String(ENGINE_VERSION) } });
  assert.equal(response.status, 200);
  const events = await response.json();
  assert.equal(JSON.stringify(events).includes('RELAY_PAGE_SEALED_SHOUT'), false, 'the relay holds ciphertext, not shout text');
  assert.ok(events.events.some(event => event.kind === 'request' && typeof event.sealed === 'string'));
  assert.equal(box.keyInRequest(), false);
  // The browser queued intent; only the next native command may author the shout.
  assert.equal(before.tables.shout.some(row => row.shout_text === 'RELAY_PAGE_SEALED_SHOUT'), false);
  assert.equal((await box.cli('status')).code, 0);
  const after = (await box.cli('export')).document;
  assert.equal(after.tables.shout.filter(row => row.shout_from === 'person' && row.shout_text === 'RELAY_PAGE_SEALED_SHOUT').length, 1);
});

test('an actual exported snapshot and local read-only page refuse all seven person actions [H12,H5]', chromeOptions, async t => {
  const box = await relayClientFixture(t);
  const directory = join(box.root, 'readonly-export');
  assert.equal((await box.cli('view', '--export', directory)).code, 0);
  const readonly = cockpitPage('', { readOnly: true });
  const server = createServer((req, res) => {
    const path = new URL(req.url, 'http://localhost').pathname;
    if (path === '/readonly') { res.writeHead(200, { 'content-type': 'text/html' }); res.end(readonly); return; }
    let file = join(directory, path === '/' ? 'index.html' : path.slice(1));
    if ((!existsSync(file) || !statSync(file).isFile()) && existsSync(file + '.json')) file += '.json';
    if (!existsSync(file) || !statSync(file).isFile()) { res.writeHead(404); res.end(); return; }
    res.writeHead(200, { 'content-type': file.endsWith('.json') ? 'application/json' : 'text/html' });
    res.end(readFileSync(file));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.closeAllConnections(); return new Promise(resolve => server.close(resolve)); });
  const origin = 'http://127.0.0.1:' + server.address().port;
  const chrome = await startChrome();
  t.after(() => chrome.close());
  for (const [path, exported] of [['/', true], ['/readonly', false]]) {
    await chrome.navigate(origin + path);
    await chrome.waitFor('typeof data !== "undefined" && !!data?.project');
    assert.deepEqual(await chrome.evaluate('({snapshot,requests,readOnly})'), { snapshot: exported, requests: false, readOnly: !exported });
    const refusals = await chrome.evaluate(`(async () => {
      const actions=[['add',{lane:'web',title:'refused'}],['shout',{to:'coordinator',text:'refused'}],['answer',{id:1,text:'refused'}],['hold',{lane:'web',reason:'refused'}],['release',{lane:'web'}],['spec-approve',{ids:'G1'}],['spec-decline',{ids:'G1',reason:'refused'}]];
      const results=[];
      for(const [command,args] of actions) results.push(await act(command,args));
      return results;
    })()`);
    assert.deepEqual(refusals, Array(7).fill(false), 'all seven handlers refuse without the requests capability');
    assert.match(await chrome.evaluate(`api(boardPath(view.root)+'/moves',{verb:'shout',args:{to:'coordinator',text:'refused'}}).then(()=>'allowed',error=>error.message)`), /read-only/);
  }
  assert.equal((await box.cli('export')).document.tables.shout.some(row => row.shout_text === 'refused'), false);
});
