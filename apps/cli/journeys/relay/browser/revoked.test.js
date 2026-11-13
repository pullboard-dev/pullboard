// pullboard: browser
/** @pullboard-test-gui */
/** Real Chrome shows a revoked or enrolled browser and the link and delete cards [H5,E16,H17]. */
import assert from 'node:assert/strict';
import {
  existsSync,
  readFileSync,
} from 'node:fs';
import {
  join,
} from 'node:path';
import {
  test,
} from 'node:test';
import {
  decodeBoardKey,
  seal,
} from '../../../../../packages/kernel/index.js';
import {
  ENGINE_VERSION,
} from '../../../../../packages/state/index.js';
import {
  openPagedSnapshot,
} from '../../../../../packages/pages/index.js';
import {
  relayClientFixture,
} from '../../../tests/fixtures/relay/client.js';
import { waitForCondition } from '../../../tests/fixtures/runner/holders.js';
import {
  findChromeExecutable,
  startChrome as startRelayChrome,
} from '../../../tests/fixtures/relay/browser.js';
import {
  pairStudioPhone,
  phoneExpiry,
  readApprovalCard,
  studioCommand,
  studioProject,
} from '../../../tests/fixtures/relay/studio.js';

/**
 * Start relay Chrome as a person who last chose Items on this device: pages land on the Dashboard since #2289, and
 * these cases read the item list (#2556). A saved tab keeps the address clean, unlike a click that writes #items.
 */
async function startChrome(options) {
  const chrome = await startRelayChrome(options);
  await chrome.send('Page.addScriptToEvaluateOnNewDocument', { source: "localStorage.setItem('pb.tab', 'items');" });
  return chrome;
}

async function signIn(chrome, box) {
  const state = JSON.parse(readFileSync(box.linkFile, 'utf8'));
  const result = await chrome.send('Network.setCookie', {
    name: 'pb_session', value: (await box.phoneSession()).token, url: box.origin, httpOnly: true, sameSite: 'Lax',
  });
  assert.equal(result.success, true, 'the real authorized person session is installed in this private browser');
  return state;
}

/** Wait for a genuine native enrollment/approval to reach the fixture, without retrying a move. */
async function browserDeviceTransition(read, message) {
  let value;
  await waitForCondition(() => { value = read(); return Boolean(value); }, message, { signal: AbortSignal.timeout(90_000) });
  return value;
}

/** Pair a real Chrome private key through the foreground Mac and its one-use enrollment. */
async function enrolledBrowser(box, t) {
  const setup = box.startCli(['relay', 'on', '--all', '--url', box.origin]);
  const machineFile = join(box.env.PULLBOARD_HOME, 'relay-machine/state.json');
  const pending = await browserDeviceTransition(() => existsSync(machineFile)
    && JSON.parse(readFileSync(machineFile, 'utf8')).pending, 'the Mac publishes the real phone enrollment');
  const chrome = await startChrome();
  t.after(() => chrome.close());
  await signIn(chrome, box);
  await chrome.navigate(box.origin + '/#device=' + pending.locator + '.' + pending.secret);
  const result = await setup.closed;
  assert.equal(result.code, 0, 'the genuine native phone enrollment succeeds');
  await chrome.waitFor("document.querySelector('#chain')?.textContent.includes('private cleanup fixture item') && document.querySelector('#phone-approvals') !== null");
  const state = JSON.parse(readFileSync(machineFile, 'utf8'));
  assert.equal(state.devices.length, 1);
  return { chrome, device: state.devices[0].deviceId };
}

/** Revoke the only enrolled browser through main's fresh provider sign-in, without its own approval. */
async function revokeBrowser(box, _chrome, device) {
  const before = box.calls.length;
  const authorized = box.providerState.deviceAuthorized;
  box.providerState.deviceAuthorized = false;
  try {
    const revoke = box.startCli(['relay', 'revoke', device]);
    await revoke.waitForOutput('Sign in with GitHub: open ');
    assert.ok(box.calls.slice(before).some(record => record.path === '/auth/device/start'),
      'the only phone is removed through a fresh provider sign-in');
    // The page may read pending approvals (#985); approving is the POST.
    assert.equal(box.calls.slice(before).some(record => record.method === 'POST' && record.path === '/api/v1/devices/approvals'), false,
      'the target browser never approves its own removal');
    box.providerState.deviceAuthorized = true;
    const result = await revoke.closed;
    assert.equal(result.code, 0, 'a genuine fresh sign-in completes native revocation');
    assert.equal(JSON.parse(result.stdout).revoked, true);
  } finally { box.providerState.deviceAuthorized = authorized; }
}

test('a revoked device read is refused as revoked [H5,E16]', {
  skip: !findChromeExecutable() && 'Chrome is not installed',
}, async t => {
  const box = await relayClientFixture(t);
  const { chrome, device } = await enrolledBrowser(box, t);
  const link = JSON.parse(readFileSync(box.linkFile, 'utf8'));
  const session = await box.phoneSession();
  const headers = { cookie: 'pb_session=' + session.token, 'x-pullboard-engine': String(ENGINE_VERSION) };
  const endpoint = box.origin + '/api/v2/boards/' + link.board + '/state';
  assert.equal((await fetch(endpoint, { headers })).status, 200, 'the genuine enrolled browser can read before revocation');
  await revokeBrowser(box, chrome, device);
  await box.restartRelay();
  const response = await fetch(endpoint, { headers });
  const document = await response.json();
  assert.equal(document.error?.code, 'DEVICE_REVOKED', 'the same browser session cannot keep reading ciphertext after device revocation and relay restart');
  assert.equal(response.ok, false);
  assert.equal('state' in document, false);
  const machine = await fetch(endpoint, { headers: { authorization: 'Bearer ' + link.token, 'x-pullboard-engine': String(ENGINE_VERSION) } });
  assert.equal(machine.status, 200, 'revoking this browser does not revoke the linked computer');
});

test('a revoked browser shows it was removed and no board [H5,E16]', {
  skip: !findChromeExecutable() && 'Chrome is not installed',
}, async t => {
  const box = await relayClientFixture(t);
  const { chrome, device } = await enrolledBrowser(box, t);
  const key = 'pullboard.relay.keys.v1';
  assert.equal(await chrome.evaluate(`Object.keys(JSON.parse(localStorage.getItem(${JSON.stringify(key)}))).length > 0`), true);
  await revokeBrowser(box, chrome, device);
  await chrome.navigate(box.origin);
  await chrome.waitFor("document.body.textContent.includes('This browser was removed') || document.querySelector('#chain')?.textContent.includes('private cleanup fixture item')");
  assert.equal(await chrome.evaluate("document.body.textContent.includes('This browser was removed')"), true, 'reload distinguishes a removed browser from an unpaired browser');
  assert.equal(await chrome.evaluate("document.body.textContent.includes('private cleanup fixture item')"), false, 'the old decrypted board is not drawn');
  assert.equal(await chrome.evaluate(`localStorage.getItem(${JSON.stringify(key)}) === null`), true, 'the cached board keys are erased');
  assert.equal(await chrome.evaluate(`new Promise((resolve, reject) => {
    const open = indexedDB.open('pullboard-relay-device-v1', 1);
    open.onsuccess = () => { const db = open.result; const request = db.transaction('keys').objectStore('keys').get('device');
      request.onsuccess = () => { db.close(); resolve(request.result === undefined); }; request.onerror = () => reject(request.error); };
    open.onerror = () => reject(open.error);
  })`), true, 'the removed browser no longer retains its private device key');
  assert.equal(await chrome.evaluate("Object.keys(localStorage).some(key => key.startsWith('pullboard.relay.requests.v1.') || key.startsWith('pullboard.relay.owned-requests.v1.'))"), false, 'cached board request state is erased');
  assert.equal(box.keyInRequest(), false);
});


test('revocation clears an already open browser and its cached board request state [H5,E16]', {
  skip: !findChromeExecutable() && 'Chrome is not installed',
}, async t => {
  const box = await relayClientFixture(t);
  const { chrome, device } = await enrolledBrowser(box, t);
  const board = JSON.parse(readFileSync(box.linkFile, 'utf8')).board;
  assert.equal(await chrome.evaluate("(window.__removedBoardReference = data.project).items.some(item => item.title === 'private cleanup fixture item')"), true);
  await chrome.waitFor('data.project?.historyProgress?.complete === true');
  assert.equal(await chrome.evaluate('window.__removedBoardReference.items === data.project.items'), true,
    'completed background history retains the shared item collection already held by the cockpit');
  // These are device-local opaque caches, never authority or a relay response. Use the real key/sealer.
  await chrome.evaluate(`(async () => {
    const module = await import('/relay/seal.js');
    const board = ${JSON.stringify(board)};
    const key = module.decodeBoardKey(JSON.parse(localStorage.getItem('pullboard.relay.keys.v1'))[board]);
    const sealed = await module.seal(key, new TextEncoder().encode('removed cached request'), {boardId:board,kind:'request',sequence:1});
    let binary = ''; for (const value of sealed) binary += String.fromCharCode(value);
    localStorage.setItem('pullboard.relay.requests.v1.'+board+'.cached', JSON.stringify({id:'cached',sequence:1,sealed:btoa(binary)}));
    localStorage.setItem('pullboard.relay.owned-requests.v1.'+board, JSON.stringify(['cached']));
    return true;
  })()`);
  assert.equal(await chrome.evaluate("Object.keys(localStorage).filter(key => key.startsWith('pullboard.relay.requests.v1.') || key.startsWith('pullboard.relay.owned-requests.v1.')).length"), 2);
  await revokeBrowser(box, chrome, device);
  await chrome.waitFor("document.body.textContent.includes('This browser was removed')");
  assert.equal(await chrome.evaluate("document.body.textContent.includes('private cleanup fixture item')"), false, 'live authorization loss clears the actual drawn board before reload');
  assert.equal(await chrome.evaluate("window.__removedBoardReference.items?.length ?? 0"), 0, 'the shared cached board projection held by the cockpit is cleared, not only its DOM');
  assert.equal(await chrome.evaluate("Object.keys(localStorage).some(key => key.startsWith('pullboard.relay.requests.v1.') || key.startsWith('pullboard.relay.owned-requests.v1.'))"), false, 'non-empty opaque board request caches are erased');
  assert.equal(await chrome.evaluate("document.querySelector('#phone-approvals') === null"), true, 'removed browser releases its approval panel and polling loop');
  assert.equal(await chrome.evaluate("document.querySelector('#relay-removed a')?.getAttribute('href')"), '/auth/github/start');
});

/** Independently probe real public auth delegation after a genuinely enrolled browser is revoked. */
test('reviewer: a revoked bound session cannot regain ciphertext through auth machine minting [H5,E16]', {
 skip: !findChromeExecutable() && 'Chrome is not installed',
}, async t => {
 const box = await relayClientFixture(t);
 const {chrome, device} = await enrolledBrowser(box, t);
 const link = JSON.parse(readFileSync(box.linkFile, 'utf8'));
 const oldSession = await box.phoneSession();
 const retainedKey = await chrome.evaluate(`JSON.parse(localStorage.getItem('pullboard.relay.keys.v1'))[${JSON.stringify(link.board)}]`);
 assert.equal(typeof retainedKey, 'string', 'the genuinely enrolled browser already received this board key');
 const endpoint = box.origin + '/api/v2/boards/' + link.board + '/state';
 const oldHeaders = {authorization:'Bearer '+oldSession.token,'x-pullboard-engine':String(ENGINE_VERSION)};
 assert.equal((await fetch(endpoint,{headers:oldHeaders})).status,200,'the bound session has original read access');
 await revokeBrowser(box, chrome, device);
 const refused = await fetch(endpoint,{headers:oldHeaders});
 assert.equal(refused.status,403,'the direct bound-session read is refused');
 assert.equal((await refused.json()).error.code,'DEVICE_REVOKED','revocation is real, not an expired or foreign session');
 // A genuinely fresh unbound GitHub sign-in must remain eligible for lost-phone recovery (#755).
 const start = await fetch(box.origin+'/auth/github/start',{redirect:'manual'});
 const binding=start.headers.getSetCookie().find(value=>value.startsWith('pb_oauth_binding=')).split(';')[0];
 const approved=await fetch(start.headers.get('location'),{redirect:'manual'});
 const callback=await fetch(approved.headers.get('location'),{redirect:'manual',headers:{cookie:binding}});
 assert.equal(callback.status,303,'a fresh independent OAuth sign-in completes');
 const fresh=callback.headers.getSetCookie().find(value=>value.startsWith('pb_session=')).split(';')[0].slice('pb_session='.length);
 assert.notEqual(fresh,oldSession.token,'the positive control really uses a different fresh session');
 const freshRead=await fetch(endpoint,{headers:{authorization:'Bearer '+fresh,'x-pullboard-engine':String(ENGINE_VERSION)}});
 assert.equal(freshRead.status,200,'fresh unbound person recovery remains eligible');
 const minted=await fetch(box.origin+'/auth/machines',{method:'POST',headers:{...oldHeaders,'content-type':'application/json'},body:JSON.stringify({board:link.board,machine:'revoked-browser-redelegation'})});
 const document=await minted.json();
 let delegatedStatus=null,decryptedOriginal=false;
 if(minted.status===201){
   assert.match(document.token,/^pm_[A-Za-z0-9_-]{43}$/u,'the actual auth endpoint issued a machine delegate');
   const delegated=await fetch(endpoint,{headers:{authorization:'Bearer '+document.token,'x-pullboard-engine':String(ENGINE_VERSION)}});
   delegatedStatus=delegated.status;
   if(delegated.status===200){
     const {state}=await delegated.json();
     const page=await openPagedSnapshot(state.root,{
       key:decodeBoardKey(retainedKey),boardId:link.board,sequence:state.sequence,
       /** Prove any wrongly delegated access reaches the real pinned ciphertext graph with that new credential. */
       async get(id,parents){
         const response=await fetch(box.origin+'/api/v2/boards/'+link.board+'/objects/'+id+'?pin='+encodeURIComponent(state.read.id)+'&via='+parents.join(','),{
           headers:{authorization:'Bearer '+document.token,'x-pullboard-engine':String(ENGINE_VERSION)},
         });
         assert.equal(response.status,200);
         const value=await response.json();
         return Uint8Array.from(Buffer.from(value.page.sealed,'base64url'));
       },
     },{maxEngine:ENGINE_VERSION});
     const snapshot=await page.native();
     decryptedOriginal=JSON.stringify(snapshot).includes('private cleanup fixture item');
     assert.equal(decryptedOriginal,true,'the previously received browser key decrypts the regained board');
   }
 }
 t.diagnostic(JSON.stringify({oldBoundRead:refused.status,freshUnboundRead:freshRead.status,machineMint:minted.status,delegatedRead:delegatedStatus,decryptedOriginal}));
 assert.equal(minted.status,403,'a revoked bound browser session must not mint a fresh machine credential that bypasses its revoked read');
 assert.equal(document.error?.code,'DEVICE_REVOKED');
});
/** The revoked session cannot exchange its refusal for another credential through the auth router. */
test('a revoked browser cannot mint or list relay credentials [H5,E16]', {
  skip: !findChromeExecutable() && 'Chrome is not installed',
}, async t => {
  const box = await relayClientFixture(t);
  const { chrome, device } = await enrolledBrowser(box, t);
  const link = JSON.parse(readFileSync(box.linkFile, 'utf8'));
  const session = await box.phoneSession();
  const old = { authorization: 'Bearer ' + session.token };
  const paths = ['/auth/session', '/auth/boards', '/auth/machines?board=' + link.board, '/auth/tokens?board=' + link.board];
  for (const path of paths) {
    const response = await fetch(box.origin + path, { headers: old });
    assert.equal(response.status, 200, 'the active enrolled session can read ' + path);
    await response.body?.cancel();
  }
  await revokeBrowser(box, chrome, device);
  await box.restartRelay();
  for (const headers of [old, { cookie: 'pb_session=' + session.token, origin: box.origin }]) {
    for (const path of paths) {
      const response = await fetch(box.origin + path, { headers });
      assert.equal(response.status, 403, 'the revoked session cannot read ' + path);
      assert.equal((await response.json()).error.code, 'DEVICE_REVOKED');
    }
    for (const [path, input] of [
      ['/auth/tokens', { board: link.board, agent: 'revoked-auth-route-probe' }],
      ['/auth/machines', { board: link.board, machine: 'revoked-auth-route-probe' }],
    ]) {
      const response = await fetch(box.origin + path, { method: 'POST',
        headers: { ...headers, 'content-type': 'application/json' }, body: JSON.stringify(input) });
      const document = await response.json();
      assert.equal(response.status, 403, 'the revoked session cannot mint through ' + path);
      assert.equal(document.error?.code, 'DEVICE_REVOKED');
      assert.equal(Object.hasOwn(document, 'token'), false, 'a refusal contains no delegated credential');
    }
  }
});

test('the link approval card names the computer and the board [H17,H5]', {
  skip: !findChromeExecutable() && 'Chrome is not installed',
}, async t => {
  const box = await relayClientFixture(t);
  const { chrome, machineFile } = await pairStudioPhone(t, box);
  const notes = await studioProject(box, 'notes');
  const proposal = JSON.parse(readFileSync(machineFile, 'utf8')).approvals.find(entry => entry.root === notes);
  assert.ok(proposal?.published, 'registering notes on studio publishes one link request to the phone');
  await chrome.navigate(box.origin);
  await chrome.waitFor(`document.querySelector('.phone-approval[data-request="${proposal.context.id}"] button') !== null`);
  const card = await readApprovalCard(chrome, proposal.context.id);
  assert.match(card.title, /^Link notes from studio\?$/u, 'the card asks in words which computer links which board');
  assert.equal(card.text.includes('fixture/repository'), true, 'the card names the repository being linked');
  assert.equal(card.text.includes('expires ' + phoneExpiry(proposal.context.expires)), true, 'the expiry is in the phone\'s local time');
  assert.equal(card.text.includes(new Date(proposal.context.expires).toISOString()), false, 'no UTC timestamp on the card');
  assert.doesNotMatch(card.text, /[0-9a-f]{32}/u, 'no raw 32-hex board id on the card');
  assert.equal(card.text.includes(proposal.context.machine) || /machine-/u.test(card.text), false, 'no machine id on the card');
  assert.ok(card.pad.every(value => value > 0), 'the card has padding on every side');
  assert.equal(card.inside, true, 'every line of the card\'s text sits inside its padding');
  assert.equal(card.action, 'Link project');
});

test('the delete card names the board and confirms the delete [H17,H5]', {
  skip: !findChromeExecutable() && 'Chrome is not installed',
}, async t => {
  const box = await relayClientFixture(t);
  const notes = await studioProject(box, 'notes');
  const { chrome } = await pairStudioPhone(t, box);
  await chrome.waitFor("document.querySelectorAll('#proj-list .proj.repo').length === 2");
  const board = JSON.parse(readFileSync(join(notes, '.git/pullboard/relay.json'), 'utf8')).board;
  const off = await studioCommand(box, notes, ['relay', 'off']).done;
  assert.equal(off.code, 0, 'relay off on studio removes the local link and asks the phone');
  const posted = box.transit.findLast(record => record.method === 'POST' && record.path === '/api/v1/devices/approvals');
  const context = JSON.parse(posted.request.toString('utf8')).context;
  assert.equal(context.action, 'delete-board');
  assert.equal(context.board, board);
  const selector = `.phone-approval[data-request="${context.id}"]`;
  await chrome.waitFor(`document.querySelector('${selector} button') !== null`);
  const card = await readApprovalCard(chrome, context.id);
  assert.match(card.title, /^Delete notes from the relay\?$/u, 'the delete card names the board');
  assert.equal(card.text.includes('studio'), true, 'the delete card names the computer that asked');
  assert.doesNotMatch(card.text, /[0-9a-f]{32}/u, 'no raw board id on the delete card');
  assert.equal(card.inside, true, 'the delete card keeps its text inside its padding');
  assert.equal(card.action, 'Delete relay copy');
  await chrome.evaluate(`document.querySelector('${selector} button').click()`);
  await chrome.waitFor("[...document.querySelectorAll('#phone-approvals [role=status]')].some(node => node.textContent === 'notes was deleted from the relay.')");
  const phone = await box.phoneSession();
  const boards = await (await fetch(box.origin + '/auth/boards', { headers: { cookie: 'pb_session=' + phone.token } })).json();
  assert.equal(boards.boards.some(entry => entry.id === board), false, 'the confirmation follows the relay deleting the board');
  await chrome.evaluate(`(() => {
    const original = window.fetch.bind(window);
    window.__approvalLists = 0;
    window.fetch = async (input, init) => {
      const response = await original(input, init);
      if (new URL(typeof input === 'string' ? input : input.url, location.href).pathname.endsWith('/approvals')) window.__approvalLists += 1;
      return response;
    };
  })()`);
  await chrome.waitFor('window.__approvalLists >= 2');
  assert.equal(await chrome.evaluate(`document.querySelector('${selector}') === null && [...document.querySelectorAll('#phone-approvals [role=status]')]
    .some(node => node.textContent === 'notes was deleted from the relay.')`), true, 'the tapped card is gone and its confirmation stays after the next refresh');
});
