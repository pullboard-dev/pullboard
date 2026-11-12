// pullboard: browser
/** @pullboard-test-gui */
/** The hosted page says how far behind this machine is, and never takes a remote version for it [N26,A2]. */
import assert from 'node:assert/strict';
import { request } from 'node:http';
import {
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import {
  basename,
  join,
} from 'node:path';
import { test } from 'node:test';
import { cliCockpitRenderer$cockpitPage as cockpitPage } from '../../../index.js';
import { help$VERSION as VERSION } from '../../../index.js';
import { createRelayBrowserHandler } from '../../../../relay/index.js';
import {
  machine,
  project,
  startView,
  chromeExecutable,
  openSnapshotChrome,
  closeSnapshotChrome,
  styleOf,
  proofShot,
} from '../../../tests/fixtures/cockpit/harness.js';
import {
  HOSTED,
  showItemChain,
  namedWaits,
  LOCAL,
  call,
  hostedStandIn,
} from './fixture.js';

/**
 * Register a project under a symlink to its real path, as a machine whose path runs through one does (#937). The
 * registry keeps the spelling it was given, while git reports the real path, so the page sees two spellings.
 */
function registeredUnderSymlink(box, repo) {
  const link = join(box.dir, `linked-${basename(repo)}`);
  symlinkSync(repo, link);
  const file = join(box.dir, 'home', 'projects.json');
  const registry = JSON.parse(readFileSync(file, 'utf8'));
  registry.projects = registry.projects.map((project) => (project.root === repo ? { ...project, root: link } : project));
  writeFileSync(file, JSON.stringify(registry));
  return link;
}

/** The hosted page says how far behind this machine's Pullboard is, for a project at its real or symlinked path (#937). */
async function howFarBehind(t, { linked }) {
  const executable = chromeExecutable();
  assert.ok(executable, 'the hosted version notice needs real Chrome');
  const box = machine();
  const board = project(box, 'hosted-release');
  if (linked) registeredUnderSymlink(box, board.repo);
  box.run(board.repo, 'add', 'web', 'A board on an older Pullboard release', '--specs', 'G1');
  const profile = mkdtempSync(join(tmpdir(), 'pullboard-release-lag-'));
  let view, chrome, stopStandIn;
  try {
    view = await startView(box);
    const local = { own: view.base, target: view.base, versionOverride: '0.8.20' };
    chrome = namedWaits(await openSnapshotChrome(executable, 'about:blank', profile), profile);
    for (const permissions of [['loopbackNetwork', 'localNetwork', 'localNetworkAccess'], ['localNetworkAccess']]) {
      try { await chrome.send('Browser.grantPermissions', { origin: HOSTED, permissions }); break; } catch { /* Chrome versions expose different permission names */ }
    }
    const changelog = readFileSync(new URL('../../../../CHANGELOG.md', import.meta.url), 'utf8');
    const versionOrder = (version) => version.split('.').map(Number);
    const compareVersions = (left, right) => {
      const a = versionOrder(left), b = versionOrder(right);
      return a[0] - b[0] || a[1] - b[1] || a[2] - b[2];
    };
    const releaseVersions = [...new Set([...changelog.matchAll(/^## \[(\d+\.\d+\.\d+)\](?:\s|$)/gmu)].map((match) => match[1]))]
      .filter((version) => compareVersions(version, VERSION) <= 0)
      .sort(compareVersions);
    /** Ask the production authenticated relay route to render its default hosted release page. */
    const handler = createRelayBrowserHandler({ authenticate: async () => ({ kind: 'session' }) });
    let productionPage = '';
    let productionHeaders = {};
    const response = { writeHead(_status, headers) { productionHeaders = headers; }, end(content) { productionPage = String(content); } };
    assert.equal(await handler({ method: 'GET', url: '/', headers: {} }, response), true, 'the production relay route serves its authenticated page');
    assert.match(productionHeaders['content-security-policy'], /connect-src[^;]*http:\/\/127\.0\.0\.1:4890[^;]*http:\/\/localhost:4890/u,
      'the production hosted page policy permits its local-view read');
    /** Render the production hosted page for one release target, using only release entries shipped in this package. */
    const pageFor = (version) => cockpitPage('', {
      readOnly: true, requests: true, transportModule: '/relay/client.js', apiHeaders: {}, stylesheet: '/view.css',
      hostedLocal: true, relaySession: true, signIn: '/auth/github/start', hostedReleaseVersion: version, hostedReleaseVersions: releaseVersions,
    }).replace('<main>', '<main><section class="card-panel" id="relay-notice" role="status"><p>Pairing this browser…</p></section>');
    let activePage = pageFor('0.8.21');
    stopStandIn = await hostedStandIn(chrome, { get anonymous() { return activePage; }, get relay() { return activePage; } }, await styleOf(view), local);
    const bannerText = () => chrome.stable("document.querySelector('#hosted-release-text')?.textContent || ''");
    const bannerHidden = () => chrome.stable("document.querySelector('#hosted-release-note')?.hidden ?? true");
    let visit = 0;
    let visitPreload;
    let requestsAt = 0;
    /** Every address one visit asked for, as origin plus path on the hosted page and as origin elsewhere. The page's own
     * record of its fetch calls counts asks a page policy blocks before Chrome's network sees them. */
    const reached = async () => {
      const asked = [...chrome.requests.slice(requestsAt).map((request) => request.url), ...JSON.parse(await chrome.stable('JSON.stringify(window.__releaseFetches || [])'))];
      return [...new Set(asked.map((url) => new URL(url, HOSTED + '/')).filter((address) => address.protocol.startsWith('http'))
        .map((address) => (address.origin === HOSTED ? address.origin + address.pathname : address.origin)))].sort();
    };
    const open = async (version, production = false) => {
      activePage = production ? productionPage : pageFor(version);
      requestsAt = chrome.requests.length;
      if (visitPreload) await chrome.send('Page.removeScriptToEvaluateOnNewDocument', { identifier: visitPreload });
      const marker = ++visit;
      const installed = await chrome.send('Page.addScriptToEvaluateOnNewDocument', { source: `window.__releaseVisit = ${marker}; window.__releaseFetches = []; const pageFetch = window.fetch; window.fetch = function (input, init) { window.__releaseFetches.push(String(input?.url ?? input)); return pageFetch.call(this, input, init); };` });
      visitPreload = installed.identifier;
      await chrome.send('Page.navigate', { url: HOSTED + '/' });
      await showItemChain(chrome, `window.__releaseVisit === ${marker} && document.readyState === 'complete' && data?.project?.releaseNotes?.version === ${JSON.stringify(local.versionOverride)}`, 'A board on an older Pullboard release', 25_000); // budget: hang ceiling for this navigation to finish the local state read before the next visit; no throughput claim.
    };

    // 0.8.21 is a shipped release in CHANGELOG.md, one actual release after the local 0.8.20 install.
    await open('0.8.21');
    assert.match(await bannerText(), /Pullboard 0\.8\.20 is installed; 0\.8\.21 is current, 1 release behind/u);
    assert.equal(await chrome.stable("document.querySelector('#hosted-release-note code')?.textContent"), 'npm i -g pullboard@latest');
    assert.equal(await chrome.stable("document.querySelector('#hosted-release-link')?.href"), 'https://github.com/pullboard-dev/pullboard/blob/main/CHANGELOG.md');
    await proofShot(chrome, 'hosted-release-note', 1280);
    await proofShot(chrome, 'hosted-release-note', 390);
    await chrome.click("document.querySelector('#hosted-release-dismiss')");
    assert.equal(await bannerHidden(), true, 'dismiss hides the note for its current target release');
    await open('0.8.21');
    assert.equal(await bannerHidden(), true, 'the same target release stays dismissed after reload');

    // The next shipped version gets its own dismissal key and its release count comes from actual release entries.
    await open(VERSION, true);
    const releasesBehind = releaseVersions.indexOf(VERSION) - releaseVersions.indexOf('0.8.20');
    assert.ok(releasesBehind > 0, 'the hosted package has shipped releases after the simulated older install');
    assert.equal(await bannerText(), `Pullboard 0.8.20 is installed; ${VERSION} is current, ${releasesBehind} ${releasesBehind === 1 ? 'release' : 'releases'} behind. Update with`);
    assert.equal(await bannerHidden(), false, 'a new target release brings the note back');
    const behindReached = await reached();

    // The production-generated page counts every numeric release heading, including 0.8.4's section with no headline.
    local.versionOverride = '0.8.4';
    await open(VERSION, true);
    const legacyReleasesBehind = releaseVersions.indexOf(VERSION) - releaseVersions.indexOf('0.8.4');
    assert.ok(legacyReleasesBehind > releasesBehind, 'the full shipped heading list includes releases without headlines');
    assert.equal(await bannerText(), `Pullboard 0.8.4 is installed; ${VERSION} is current, ${legacyReleasesBehind} releases behind. Update with`);

    local.versionOverride = VERSION;
    await open(VERSION, true);
    assert.equal(await bannerHidden(), true, 'matching local and hosted releases show no note');
    assert.deepEqual(behindReached, await reached(), 'the note costs no request: a visit that shows it reaches what a matched visit reaches');
    assert.deepEqual(behindReached.filter((address) => !address.startsWith(HOSTED + '/') && address !== LOCAL && address !== view.base), [],
      'the page learns both versions without asking any other address');

    local.versionOverride = '0.8.22-rc.1';
    await open(VERSION);
    assert.equal(await bannerHidden(), true, 'an unlisted prerelease does not get a guessed release count');
    local.versionOverride = '0.8.23';
    await open('0.8.21');
    assert.equal(await bannerHidden(), true, 'a local version newer than this hosted page does not get a false warning');

    // A mixed list (#632 review): a relay board from another machine beside this machine's own. The selected board's
    // source decides: this machine's board keeps its note while the relay transport is loaded, a relay board shows none.
    const remoteBox = machine();
    const remoteBoard = project(remoteBox, 'remote-a');
    remoteBox.run(remoteBoard.repo, 'add', 'web', 'A board on another machine', '--specs', 'G1');
    const remoteView = await startView(remoteBox);
    try {
      const remoteKey = { headers: { 'x-pullboard-key': remoteView.key } };
      const remoteList = JSON.parse((await call(remoteView, '/api/v1/boards', remoteKey)).body);
      const remote = remoteList.boards[0];
      const remoteState = JSON.parse((await call(remoteView, '/api/v1/boards/' + remote.id + '/state', remoteKey)).body);
      // The relay client stands in with the other machine's real list and state; the page only ever calls request().
      local.client = `export function rememberPairing() { return null; }
export async function createTransport() { return { async request(path) {
  if (path === '/api/v1/boards') return ${JSON.stringify({ ...remoteList, boards: [{ ...remote, name: 'acme/remote-a' }] })};
  if (path.startsWith('/api/v1/boards/${remote.id}/state')) return ${JSON.stringify(remoteState)};
  throw new Error('not in this stand-in: ' + path);
} }; }`;
      local.linked = [{ id: remote.id, repository: 'acme/remote-a', linkedAt: 0 }];
      local.versionOverride = '0.8.20';
      await open(VERSION, true);
      await chrome.waitFor("Boolean(transport) && [...boardSources.values()].map((source) => source.kind).sort().join() === 'local,relay' && document.querySelectorAll('#proj-list .proj.repo').length === 2", 25_000); // budget: hang ceiling for the relay module and its board list after the local read; no throughput claim.
      const roots = JSON.parse(await chrome.stable("JSON.stringify(Object.fromEntries([...boardSources.values()].map((source) => [source.kind, source.board.root])))"));
      // The page's own record of its last switch and its last reads, for the readiness capture (#889).
      await chrome.stable(`(() => {
        const read = api, pick = switchTo;
        window.__journal = { switchedTo: null, reads: [] };
        api = async (path, ...rest) => {
          const entry = { path: String(path).split('?')[0], outcome: 'pending' };
          window.__journal.reads = [...window.__journal.reads, entry].slice(-6);
          try { const reply = await read(path, ...rest); entry.outcome = 'ok'; return reply; }
          catch (error) { entry.outcome = 'failed: ' + String(error.message || error).slice(0, 80); throw error; }
        };
        switchTo = (root, ...rest) => { window.__journal.switchedTo = root; return pick(root, ...rest); };
        return true;
      })()`);
      // A failed wait names the selected root, the sources, the last switch and the last reads, next to the root it
      // expected, so a spelling mismatch, a dropped switch, a late read or a lost read shows which it was (#937, #889).
      const selected = async (root) => {
        try { await chrome.waitFor(`data?.project?.root === ${JSON.stringify(root)} && document.querySelector('#chain')?.textContent.length > 0`, 25_000); } // budget: hang ceiling for one board switch and its state read; no throughput claim.
        catch (error) {
          const reported = await chrome.stable(`JSON.stringify({ selected: data?.project?.root ?? null, viewRoot: view.root, sources: [...boardSources.values()].map((source) => source.kind + ':' + source.board.root), ...window.__journal })`).catch(() => 'unreadable');
          throw new Error(`${error.message}; the page reported ${reported}, expected ${JSON.stringify(root)}`);
        }
      };
      const mixedNote = `Pullboard 0.8.20 is installed; ${VERSION} is current, ${releasesBehind} ${releasesBehind === 1 ? 'release' : 'releases'} behind. Update with`;
      await chrome.stable(`(switchTo(${JSON.stringify(roots.local)}), true)`);
      await selected(roots.local);
      assert.equal(await bannerHidden(), false, 'this machine\'s older board shows its note on a list that also reads relay boards');
      assert.equal(await bannerText(), mixedNote);
      assert.equal(await chrome.stable("document.querySelector('#hosted-release-note code')?.textContent"), 'npm i -g pullboard@latest');
      await chrome.stable(`(switchTo(${JSON.stringify(roots.relay)}), true)`);
      await selected(roots.relay);
      assert.match(await chrome.stable("document.querySelector('#chain')?.textContent"), /A board on another machine/u, 'the relay board is the one on screen');
      assert.equal(await bannerHidden(), true, 'a selected relay board shows no note about this machine\'s install');
      await chrome.stable(`(switchTo(${JSON.stringify(roots.local)}), true)`);
      await selected(roots.local);
      assert.equal(await bannerHidden(), false, 'back on this machine\'s board, the note returns');
      // A read of the chosen board that fails once, as one dropped under load, is read again: the page stays on the
      // board the person chose instead of moving to the other one (#889).
      await chrome.stable(`(switchTo(${JSON.stringify(roots.relay)}), true)`);
      await selected(roots.relay);
      await chrome.stable(`(() => {
        const localId = [...boardSources.values()].find((source) => source.kind === 'local').board.id, read = api;
        let armed = true;
        api = async (path, ...rest) => {
          if (armed && String(path).startsWith('/api/v1/boards/' + encodeURIComponent(localId) + '/state')) { armed = false; throw new Error('a dropped read'); }
          return read(path, ...rest);
        };
        return true;
      })()`);
      await chrome.stable(`(switchTo(${JSON.stringify(roots.local)}), true)`);
      await selected(roots.local);
      assert.equal(await chrome.stable('view.root'), roots.local, 'the page keeps the board the person chose after one failed read');
      assert.equal(await bannerText(), mixedNote);
    } finally {
      local.client = null;
      local.linked = null;
      await remoteView.stop();
    }
    assert.deepEqual(chrome.exceptions, [], 'Chrome reports no uncaught page exceptions');
  } finally {
    try { if (stopStandIn) await stopStandIn(); }
    finally {
      try { if (chrome) await closeSnapshotChrome(chrome); }
      finally {
        try { if (view) await view.stop(); }
        finally { rmSync(profile, { recursive: true, force: true }); }
      }
    }
  }
}

test('the hosted page says how far behind this machine\'s Pullboard is [N26,A2]', { timeout: 120_000 }, (t) => howFarBehind(t, { linked: false }));
test('the hosted page shows how far behind a project under a symlinked path is [N26,A2]', { timeout: 120_000 }, (t) => howFarBehind(t, { linked: true }));

test('the hosted relay never treats a remote board version as this machine\'s version [N26,A2]', { timeout: 120_000 }, async (t) => {
  const executable = chromeExecutable();
  assert.ok(executable, 'the relay fallback version guard needs real Chrome');
  const box = machine();
  const board = project(box, 'hosted-relay-release');
  box.run(board.repo, 'add', 'web', 'A board read through the relay transport', '--specs', 'G1');
  const profile = mkdtempSync(join(tmpdir(), 'pullboard-relay-release-'));
  let view, chrome, stopStandIn;
  try {
    view = await startView(box);
    chrome = namedWaits(await openSnapshotChrome(executable, 'about:blank', profile), profile);
    for (const permissions of [['loopbackNetwork', 'localNetwork', 'localNetworkAccess'], ['localNetworkAccess']]) {
      try { await chrome.send('Browser.grantPermissions', { origin: HOSTED, permissions }); break; } catch { /* Chrome versions expose different permission names */ }
    }
    /** The relay page uses an authorized read-only transport backed by this real view's public API. */
    const transportSource = `export async function createTransport() {
      return { async request(path) {
        const response = await fetch(${JSON.stringify(view.base)} + path, { headers: { 'x-pullboard-key': ${JSON.stringify(view.key)} } });
        const document = await response.json();
        if (!response.ok) throw new Error(document.error?.message || String(response.status));
        return document;
      } };
    }`;
    const handler = createRelayBrowserHandler({ authenticate: async () => ({ kind: 'session' }) });
    let relayPage = '';
    const response = { writeHead() {}, end(content) { relayPage = String(content); } };
    assert.equal(await handler({ method: 'GET', url: '/', headers: {} }, response), true, 'the production relay handler supplies the fallback page');
    stopStandIn = await hostedStandIn(chrome, {
      anonymous: relayPage, relay: relayPage, assets: { '/relay/client.js': transportSource },
    }, await styleOf(view), { own: view.base, target: null, relayTarget: view.base, versionOverride: '0.8.20' });
    const relayVisit = '?relay-release-visit=1';
    await chrome.send('Page.navigate', { url: HOSTED + '/' + relayVisit });
    await showItemChain(chrome, `location.search === ${JSON.stringify(relayVisit)} && document.readyState === 'complete' && data?.project?.releaseNotes?.version === '0.8.20'`, 'A board read through the relay transport', 25_000); // budget: hang ceiling for this navigation to finish the relayed state read; no throughput claim.
    assert.equal(await chrome.stable("data.project.releaseNotes.version"), '0.8.20', 'the relayed API state carries its simulated remote install version');
    assert.equal(await chrome.stable("hosted.local && !localSession && connection.base === '' && !!transport && transportModule === '/relay/client.js' && localConfirmed === false"), true,
      'local discovery failed, so the board remains on the relay transport without a confirmed local session');
    assert.equal(await chrome.stable("document.querySelector('#hosted-release-note').hidden"), true,
      'remote board metadata does not describe this machine’s installed version');
    assert.deepEqual(chrome.exceptions, [], 'Chrome reports no uncaught relay fallback exceptions');
  } finally {
    try { if (stopStandIn) await stopStandIn(); }
    finally {
      try { if (chrome) await closeSnapshotChrome(chrome); }
      finally {
        try { if (view) await view.stop(); }
        finally { rmSync(profile, { recursive: true, force: true }); }
      }
    }
  }
});
