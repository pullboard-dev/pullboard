// pullboard: browser
/** @pullboard-test-input source-tree */
/** @pullboard-test-gui */
/** Real relay browser journeys and their owned setup [N26]. */
import assert from 'node:assert/strict';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
} from 'node:fs';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  after,
  test,
} from 'node:test';
import {
  press,
  stableChrome,
} from '../../tests/fixtures/cockpit/stable.js';
import { relayClientFixture } from '../../tests/fixtures/relay/client.js';
import {
  findChromeExecutable,
  relayWorkBudgetMs,
  startChrome,
} from '../../tests/fixtures/relay/browser.js';
import {
  machine,
  project,
  startView,
  target,
  chromeExecutable,
  openSnapshotChrome,
  closeSnapshotChrome,
  proofShot,
} from '../../tests/fixtures/cockpit/harness.js';
import {
  STAR_SHOWN,
  STAR_TEXT,
  starLineFixture,
  starRepository,
  starSteps,
} from '../../tests/fixtures/cockpit/line.js';

test('the star line shows once to a signed-in person and stays dismissed [N26]', { timeout: 120_000 }, async (t) => { // budget: hang-only ceiling for real Chrome startup and nine page loads.
  const executable = chromeExecutable();
  if (!executable) return t.skip('Install Chrome or set PULLBOARD_CHROME for the star line proof.');
  const star = await starLineFixture();
  const linkedBoard = { id: star.board.id, name: 'person/star-line', repository: 'person/star-line' };
  const profile = mkdtempSync(join(tmpdir(), 'pullboard-star-line-chrome-'));
  const expected = { text: STAR_TEXT + '×', href: starRepository(), lines: 1, parts: 2, count: 1 };
  let chrome;
  try {
    chrome = await openSnapshotChrome(executable, 'about:blank', profile);
    await chrome.send('Page.addScriptToEvaluateOnNewDocument', { source: star.script });
    // Each account read the star line makes itself. Once the page has read the account, a read from the line reaches
    // fetch inside the line's own call, so its stack names starLine (#817).
    await chrome.send('Page.addScriptToEvaluateOnNewDocument', { source: "(() => { const fetchNow = window.fetch.bind(window); window.__starReads = 0; window.fetch = (input, init) => { const address = new URL(String(typeof input === 'string' ? input : input.url), location.href); if (address.origin === location.origin && address.pathname === '/api/v1/boards' && /starLine/.test(new Error().stack || '')) window.__starReads += 1; return fetchNow(input, init); }; })()" });
    const page = starSteps(chrome, star);
    star.state.account = [linkedBoard]; // Even a linked list that answered a signed-out page would show nothing there.
    await chrome.send('Page.navigate', { url: star.origin + '/out' }).then(() => chrome.waitFor("location.pathname === '/out' && !document.querySelector('#local-note').hidden"));
    assert.equal(await page.shown(), null, 'a signed-out page shows no star line');
    assert.equal(star.requests.get('/api/v1/boards'), undefined, 'a signed-out page never asks for the linked list');
    await chrome.send('Page.navigate', { url: star.live.link.href }).then(() => chrome.waitFor('!!data?.project'));
    assert.equal(await chrome.stable("document.querySelector('#star-line') === null && !document.body.textContent.includes('GitHub star')"), true, 'the local view never carries the star line');
    assert.ok(!readFileSync(new URL('../../src/io/entry.js', import.meta.url), 'utf8').includes('GitHub star'), 'src/cli.js never prints the star line');
    assert.ok(!readFileSync(new URL('../../../../packages/mcp/src/logic/main.js', import.meta.url), 'utf8').includes('GitHub star'), 'src/mcp.js never prints the star line');
    assert.ok(!readFileSync(new URL('../../src/logic/help.js', import.meta.url), 'utf8').includes('GitHub star'), 'src/help.js never prints the star line');
    // The account read is refused while this machine's view still answers: the refusal answers the line too, "not
    // linked", and the line never asks again on its own (#817).
    star.state.refused = true;
    await page.open('/in-local', 'no', []);
    assert.ok(star.requests.get('/api/v1/boards') >= 1, 'the page read the account and was refused');
    assert.equal(await page.shown(), null, 'a refused account read shows no star line');
    assert.equal(await chrome.stable('window.__starReads'), 0, 'and the line makes no read of its own after the refusal');
    star.state.refused = false;
    await page.open('/in-local', 'no', []);
    assert.equal(await page.shown(), null, 'a signed-in person with an unlinked local-only board sees no star line');
    await page.open('/in', 'no');
    assert.equal(await page.shown(), null, 'a signed-in person with an empty linked list sees no star line');
    await page.open('/in-local', 'yes', [linkedBoard]); // The person links this machine's board: the page reads it locally.
    assert.deepEqual(await page.shown(), expected, 'a linked board read locally shows one line, one plain sentence, linking to the repository');
    assert.equal(await chrome.stable('window.__starReads'), 0, 'the line learns from the read of the account the page already made, and makes no extra read of its own');
    assert.equal(star.requests.get('/star-transport.js'), undefined, 'no relay client loads while every linked board is local');
    for (const width of [1280, 390]) await proofShot(chrome, 'star-line', width);
    await page.dismiss();
    await page.reload('yes');
    assert.equal(await page.shown(), null, 'a dismissed star line stays dismissed across a reload, with the linked board listed');
    await chrome.stable("localStorage.removeItem('pb.star')");
    await page.open('/in', 'no', []);
    Object.assign(star.state, { account: [linkedBoard], relay: true }); // A board linked from another machine arrives through the relay.
    await chrome.waitFor(`${STAR_SHOWN} !== null`);
    assert.deepEqual(await page.shown(), expected, 'a relay-drawn linked board shows the same one line');
    await page.dismiss();
    await page.reload('yes');
    assert.equal(await page.shown(), null, 'dismissed there too, it stays dismissed across a reload');
  } finally {
    if (chrome) await closeSnapshotChrome(chrome);
    await star.close().finally(() => rmSync(profile, { recursive: true, force: true }));
  }
});


test('the view links every board on this machine in one sign-in [H5,N26]', {
  timeout: relayWorkBudgetMs() * 12,
  skip: !findChromeExecutable() && 'Chrome is not installed',
}, async (t) => {
  for (const mode of ['linked', 'declined', 'closed', 'partial']) {
    await t.test(mode, async (scenario) => {
      const box = await relayClientFixture(scenario);
      box.providerState.deviceAuthorized = false;
      const module = (name) => new URL('../../src/' + name, import.meta.url).href;
      const fixtureModule = new URL('../../tests/fixtures/child.js', import.meta.url).href;
      const prepared = await box.script(`
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { main } from ${JSON.stringify(new URL('../../tests/fixtures/native.js', import.meta.url).href)};
import { updateRelayMachine } from ${JSON.stringify(new URL('../../../../packages/link/index.js', import.meta.url).href)};
import { runFixtureGit } from ${JSON.stringify(fixtureModule)};
const other = join(dirname(${JSON.stringify(box.root)}), 'second-view-board');
mkdirSync(other);
for (const args of [['init','-q','-b','main'], ['-c','commit.gpgsign=false','commit','--allow-empty','-q','-m','chore: private view board']])
  runFixtureGit(args, {cwd:other,env:process.env});
if (${JSON.stringify(mode)} !== 'partial') runFixtureGit(['remote','add','origin','git@github.com:fixture/repository-2.git'], {cwd:other,env:process.env});
assert.equal(await main(['init','--json'], {cwd:other,stdin:process.stdin,stdout:{isTTY:false,write(){}},stderr:{write(){}}}),0);
updateRelayMachine(state => { state.owner = {account:'7',url:${JSON.stringify(box.origin)}}; });
process.stdout.write(JSON.stringify({other}));
`);
      assert.equal(prepared.code, 0, 'two private boards are registered through the real CLI');
      const links = [box.root, prepared.document.other].map(root => join(root, '.git/pullboard/relay.json'));
      assert.deepEqual(links.map(existsSync), [false, false]);
      let releasePoll;
      const held = new Promise(done => { releasePoll = done; });
      box.providerState.beforeDevicePoll = () => held;
      if (mode === 'declined') box.providerState.deviceDeclined = true;
      const local = await startView({dir:box.root,env:{...box.env,SSH_CONNECTION:'127.0.0.1 1 127.0.0.1 2'}}, {signal:scenario.signal});
      const chrome = await stableChrome(await startChrome());
      let cleaned = false;
      /** Close only resources owned by this scenario once, before its private relay is removed. */
      const cleanup = async () => { if (cleaned) return; cleaned = true; releasePoll?.(); await chrome.close(); await local.stop(); };
      scenario.after(cleanup);
      try {
        await chrome.navigate(local.link.href);
        await chrome.waitFor("!document.body.classList.contains('loading') && data?.projects?.length === 2");
        await chrome.stable("typeof sharingReady === 'undefined' ? null : sharingReady");
        // A person who has set the first-run page aside sees the sign-in invitation; while it is up the banner steps aside (#2066).
        await chrome.stable("(() => { keep('pb.firstrun.' + view.root, 'hidden'); render(); return true; })()");
        assert.equal(await chrome.stable("document.querySelector('#share-note')?.hidden === false"), true,
          'the real local view offers one quiet invitation before any board is linked');
        assert.equal(await chrome.stable("document.querySelector('#share-note b')?.textContent"), 'Open your boards on any device');
        assert.equal(await chrome.stable("document.querySelector('#share-note .share-txt > span')?.textContent"), 'Sign in to use pullboard.dev while on the go.');
        assert.deepEqual(JSON.parse(await chrome.stable("JSON.stringify((() => { const a = document.querySelector('#share-note .share-txt a'); return a ? [a.textContent, a.href, a.target, a.rel] : null; })())")), ['How the relay works', 'https://pullboard.dev/relay/', '_blank', 'noopener']);
        const starts = box.providerCalls.filter(call => call.path === '/login/device/code').length;
        await press(chrome, "document.querySelector('#share-start')");
        // The real GitHub popup hides this tab; foreground the owned view before measuring its progress.
        await chrome.send('Page.bringToFront');
        await chrome.stable('sharingTask');
        assert.equal(box.providerCalls.filter(call => call.path === '/login/device/code').length - starts, 1,
          'one native person click starts exactly one real device sign-in for every board');
        assert.equal(await chrome.stable("document.querySelector('#share-status')?.textContent.includes('TEST-ONLY')"), true,
          'the view displays the public GitHub code');
        if (mode === 'linked') {
          await press(chrome, "document.querySelector('#share-hide')");
          assert.equal(await chrome.stable("document.querySelector('#share-again').hidden"), false,
            'dismissing while sign-in waits offers the restore entry');
        }
        if (mode === 'closed') {
          const targets = await chrome.send('Target.getTargets');
          const popup = targets.targetInfos.find(target => target.type === 'page' && target.url.endsWith('/login/device'));
          assert.ok(popup, 'the person sign-in opened in an actual browser page');
          await chrome.send('Target.closeTarget', {targetId:popup.targetId});
          await chrome.waitFor('sharing.closing === true');
          let closedState = null;
          const closed = chrome.stable('sharingTask.then(() => sharing.state)').then(state => { closedState = state; });
          const deadline = Date.now() + relayWorkBudgetMs();
          while (!box.calls.some(call => call.path === '/auth/device/cancel') && closedState === null) {
            assert.ok(Date.now() < deadline, 'closing the sign-in reaches its real cancellation request or a terminal result');
            await new Promise(done => setTimeout(done, 25));
          }
          if (closedState !== null) assert.equal(closedState, 'cancelled', 'closing waits for confirmed core cancellation');
          releasePoll();
          await closed;
          assert.equal(closedState, 'cancelled', 'closing finishes the actual core cancellation');
        } else releasePoll();
        if (mode === 'declined' || mode === 'closed') {
          await chrome.waitFor("sharing.state === 'declined' || sharing.state === 'cancelled'", relayWorkBudgetMs());
          assert.match(await chrome.stable("document.querySelector('#share-status').textContent"), /No boards were linked/u);
          assert.deepEqual(links.map(existsSync), [false, false], 'declining or closing the real sign-in links neither board');
          assert.equal(await chrome.stable("document.querySelector('#share-note').hidden"), false);
        } else {
          await chrome.waitFor("sharing.state === 'pairing' || sharing.state === 'done'", relayWorkBudgetMs() * 2);
          assert.deepEqual(links.map(existsSync), mode === 'linked' ? [true,true] : [true,false],
            'the existing core flow links each authorized registered board');
          const text = await chrome.stable("document.querySelector('#share-status').textContent");
          assert.match(text, /Linked repo/u);
          if (mode === 'linked') assert.match(text, /Linked second-view-board/u);
          else assert.match(text, /Did not link second-view-board: .+/u, 'a refused board is named with its actual reason');
          assert.equal(await chrome.stable("document.querySelector('#share-note').hidden"), true, 'the invitation disappears after linking');
          assert.equal(await chrome.stable("document.querySelector('#share-again').hidden"), true, 'linking also removes a previously dismissed restore entry');
          await press(chrome, "document.querySelector('#share-close')");
          await chrome.stable('sharingTask');
          assert.deepEqual(links.map(existsSync), mode === 'linked' ? [true,true] : [true,false], 'stopping phone pairing preserves completed board links');
        }
        assert.equal(box.providerCalls.filter(call => call.path === '/login/device/code').length - starts, 1, 'no second board sign-in or retry occurred');
        assert.doesNotMatch(await chrome.stable("document.querySelector('#share-status').textContent"), /(?:ps_|pd_|pg_|pm_)[A-Za-z0-9_-]{20,}/u,
          'the progress panel never exposes person, ticket or machine credentials');
      } finally { await cleanup(); }
    });
  }
});


test('view sign-in keeps its key and intents inside the authenticated machine view [H5,N26]', { timeout: relayWorkBudgetMs() * 3 }, async (t) => {
  const box = await relayClientFixture(t);
  box.providerState.deviceAuthorized = false;
  const serveModule = new URL('../../src/io/commands/view.js', import.meta.url).href;
  const viewModule = new URL('../../../view/index.js', import.meta.url).href;
  const machineModule = new URL('../../../../packages/link/index.js', import.meta.url).href;
  const result = await box.script(`
import { request } from 'node:http';
import { serveView } from ${JSON.stringify(serveModule)};
import { main as nativeTestMain } from ${JSON.stringify(new URL('../../tests/fixtures/native.js', import.meta.url).href)};
import { nativeBoardPorts as nativeNativeBoardPorts, openBoard as nativeOpenBoard, openBoardForRead as nativeOpenBoardForRead } from ${JSON.stringify(new URL('../../../lib/index.js', import.meta.url).href)};
import { refusalDocument } from ${JSON.stringify(new URL('../../index.js', import.meta.url).href)};
import { HOSTED_ORIGIN } from ${JSON.stringify(viewModule)};
import { updateRelayMachine } from ${JSON.stringify(machineModule)};
updateRelayMachine(state => { state.owner = {account:'7',url:${JSON.stringify(box.origin)}}; });
const observations = [];
/** Return only safe HTTP observations; the outer native test makes every assertion itself. */
function observe(actual, expected, why) { observations.push({actual,expected,why}); }
const key = 'private-view-sign-in-fixture';
const services = {runCommand:nativeTestMain,boardOpeners:{openBoard:nativeOpenBoard,openBoardForRead:nativeOpenBoardForRead,nativeBoardPorts:nativeNativeBoardPorts},refusalDocument};
const view = await serveView({secret:key,...services});
const other = await serveView({secret:key,...services});
const scoped = await serveView({secret:key,...services,projectRoot:${JSON.stringify(box.root)}});
/** Send one real HTTP request with explicit Host, origin and header fields. */
function call(server, {method='GET', headers={}, body, query=''}={}) {
  const address = new URL('/api/v1/view-link'+query, server.url);
  return new Promise((resolve,reject) => {
    const req = request(address, {method,headers}, res => {
      const chunks=[];
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => resolve({status:res.statusCode,headers:res.headers,body:JSON.parse(Buffer.concat(chunks).toString())}));
    });
    req.on('error',reject);
    req.end(body);
  });
}
const auth = {'x-pullboard-key':key};
const json = {...auth,'content-type':'application/json'};
try {
  for (const options of [{}, {query:'?k='+key}, {headers:auth,query:'?intentId=anything'},
    {headers:{...auth,origin:'https://foreign.invalid'}}, {headers:{...auth,host:'foreign.invalid'}}]) {
    observe((await call(view,options)).status,403,'a sign-in route needs its own Host/origin and a header-only key');
  }
  const invitation = await call(view,{headers:auth});
  observe(invitation.status,200);
  observe(invitation.body,{version:1,available:true},'the idle invitation exposes no board paths or credentials');
  const hosted = await call(view,{headers:{...auth,origin:HOSTED_ORIGIN}});
  observe(hosted.status,200,'the trusted hosted page can use the same local person channel');
  observe(hosted.headers['access-control-allow-origin'],HOSTED_ORIGIN);
  for (const [body,type] of [['action=start','text/plain'], ['[]','application/json'],
    ['{','application/json'], [JSON.stringify({action:'run'}),'application/json'],
    [JSON.stringify({action:'start',relayUrl:'https://foreign.invalid'}),'application/json'],
    [JSON.stringify({action:'status',intentId:'not-owned'}),'application/json'],
    [JSON.stringify({action:'start',padding:'x'.repeat(5000)}),'application/json']]) {
    observe((await call(view,{method:'POST',headers:{...auth,'content-type':type},body})).status,400,'only one bounded known JSON action is admitted');
  }
  observe((await call(view,{method:'PUT',headers:json,body:'{}'})).status,405);
  observe((await call(scoped,{headers:auth})).body,{version:1,available:false});
  const scope = await call(scoped,{method:'POST',headers:json,body:JSON.stringify({action:'start'})});
  observe(scope.status,400,'a one-project view cannot authorize every board on the machine');
  observe(scope.body.error.code,'VIEW_SIGN_IN_SCOPE');
  const started = await call(view,{method:'POST',headers:json,body:JSON.stringify({action:'start'})});
  observe(started.status,200);
  observe(Object.keys(started.body).sort(),['expiresAt','intentId','userCode','verificationURL','version']);
  const intentId = started.body.intentId;
  const foreign = await call(other,{method:'POST',headers:json,body:JSON.stringify({action:'status',intentId})});
  observe(foreign.status,400,'another view cannot read an operation it did not start');
  observe(foreign.body.error?.code,'VIEW_SIGN_IN_UNKNOWN');
  const status = await call(view,{method:'POST',headers:json,body:JSON.stringify({action:'status',intentId})});
  observe(status.body.state,'waiting');
  observe(status.body.boards,[]);
  observe(/(?:ps_|pd_|pg_|pm_)[A-Za-z0-9_-]{20,}/u.test(JSON.stringify(status.body)),false,'public status contains no person, ticket or machine credential');
  const cancelled = await call(view,{method:'POST',headers:json,body:JSON.stringify({action:'cancel',intentId})});
  observe(cancelled.body.state,'cancelled');
  observe(cancelled.body.boards,[]);
  process.stdout.write(JSON.stringify({observations}));
} finally { await scoped.close(); await other.close(); await view.close(); }
`);
  assert.equal(result.code,0,'the private real-HTTP view boundary script completes');
  assert.ok(result.document.observations.length >= 20, 'the private script returned every boundary observation');
  for (const {actual,expected,why} of result.document.observations) assert.deepEqual(actual,expected,why);
  assert.equal(box.providerCalls.filter(call => call.path === '/login/device/code').length,1,
    'all refused requests and idle reads performed no sign-in; only the authenticated start did');
});
