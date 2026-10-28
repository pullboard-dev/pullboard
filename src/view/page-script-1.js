/**
 * Part 1 of the hosted page's script, verbatim from src/cockpit.js lines 227-330 (#745): its
 * text is what the page served before the split, with the values its ${} expressions read passed in as scope.
 *
 * @param {Record<string, any>} scope - The values cockpitPage passes for the names this part interpolates.
 * @returns {string} The script text of this part.
 */
export function pageScriptPart1(scope) {
  const { connection, hostedOptions, moduleOption, pageStartup, paths, readOnly, requestMode, snapshot, tabValue } = scope;
return `const snapshot = ${JSON.stringify(snapshot)};
let readOnly = ${JSON.stringify(readOnly)};
let requests = ${JSON.stringify(requestMode)};
const pageReadOnly = ${JSON.stringify(readOnly)};
const pageRequests = ${JSON.stringify(requestMode)};
const relayRequestsEnabled = requests;
const configuredTransportModule = ${moduleOption};
let transportModule = configuredTransportModule;
const connection = ${connection};
let transport = null;
let transportLoadError = null;
// Hosted pages can read two independent authorities at once. Local boards use the view's API; relay boards
// retain the relay client's device-only decryption and event stream. The board id, never a mutable global mode,
// selects the authority for each request.
const boardSources = new Map();
const localBoardIds = new Set();
let localReadBase = connection.base;
let localReadHeaders = { ...connection.headers };
// The hosted page (N26, #513): at https://app.pullboard.dev, on the machine that runs pullboard view, the page reads
// that view straight instead of the relay. The view hands it the session's secret by a round trip that ends back here
// with the secret in the address's fragment, which no request carries; the page takes it out of the address before
// anything else reads the address, and keeps it for this tab only. Every request then sends it in x-pullboard-key.
const hosted = ${hostedOptions};
const LOCAL_VIEW = 'http://127.0.0.1:4890';
const LOCAL_TAB = 'pullboard.local.session';
const LOCAL_TRIPS = 'pullboard.local.trips';
let localSession = null;
let localProblem = null;
let localConfirmed = false;
const tabValue = (${tabValue.toString()});
/** Whether a value is a local session this page may use: version 1, a loopback origin with its port, and a secret. */
function validLocalSession(value) {
  if (!value || value.version !== 1 || typeof value.key !== 'string' || !/^[\\x21-\\x7e]{1,256}$/.test(value.key) || typeof value.origin !== 'string') return false;
  try {
    const address = new URL(value.origin);
    return address.protocol === 'http:' && ['127.0.0.1', 'localhost'].includes(address.hostname) && address.port !== '' && address.origin === value.origin;
  } catch { return false; }
}
const pageStartup = (${pageStartup.toString()});
// A relay pairing link carries its own fragment; that load stays the relay's, as before.
const relayPairing = hosted.local && ['board', 'key', 'device'].some((name) => new URLSearchParams(location.hash.slice(1)).has(name));
if (hosted.local && !relayPairing) {
  const fragment = new URLSearchParams(location.hash.slice(1));
  const returned = fragment.get('pullboard-local');
  if (returned !== null) {
    fragment.delete('pullboard-local');
    const rest = fragment.toString();
    let removed = true;
    try { history.replaceState(history.state, '', location.pathname + location.search + (rest ? '#' + rest : '')); }
    catch { removed = false; }
    let returnedSession = null;
    try { returnedSession = JSON.parse(returned); } catch { /* refused below */ }
    if (!removed) localProblem = 'This browser kept the connection secret in the address, so this page will not use it. Close this tab, then open your board below.';
    else if (validLocalSession(returnedSession)) localSession = { version: 1, origin: returnedSession.origin, key: returnedSession.key };
    else localProblem = 'Pullboard on this computer sent back a connection this page cannot read.';
  } else {
    try { const kept = JSON.parse(tabValue(LOCAL_TAB) ?? 'null'); if (validLocalSession(kept)) localSession = kept; } catch { /* nothing kept for this tab */ }
  }
  tabValue(LOCAL_TAB, localSession ? JSON.stringify(localSession) : null);
}
const snapshotReplay = { final: null, events: [], index: 0, playing: false, timer: null };
const keep = (name, value) => { name = snapshot ? 'snapshot.' + name : name; try { if (value === undefined) return localStorage.getItem(name); localStorage.setItem(name, value); } catch { return null; } return value; };
// Whether the host serves this page at /roadmap as well as at /, so the Roadmap's address is a path;
// anywhere else it is a #roadmap fragment on the page's own address (N38).
const routed = ${JSON.stringify(Boolean(paths) && !snapshot)};
/** The tab the address names: the Roadmap at its own address, or null at the board's. */
function addressTab() {
  if (typeof location === 'undefined') return null;
  if (snapshot) {
    const tab = (location.hash || '').slice(1).split('/')[0] || '';
    return ['home', 'items', 'shouts', 'spec', 'doctrine', 'activity', 'roadmap'].includes(tab) ? tab : null;
  }
  if (location.hash === '#items/pipeline') return 'items';
  if (/^#items\\/\\d+$/.test(location.hash)) return 'items';
  return (routed ? location.pathname === '/roadmap' : location.hash === '#roadmap') ? 'roadmap' : null;
}
/** Build an address for an item in the current app or an exported snapshot, preserving repo scope. */
function itemAddress(id, root = view.root) {
  if (snapshot) return location.pathname + location.search + '#items/' + encodeURIComponent(String(id));
  const repo = data?.projects.find((entry) => entry.root === root);
  const group = data?.groups.find((entry) => entry.key === root);
  const name = repo?.name || group?.name;
  const prefix = (data?.projects.filter((entry) => entry.ok).length || 0) > 1 && name ? '/' + encodeURIComponent(name) : '';
  const path = prefix + '/items/' + encodeURIComponent(String(id));
  return routed ? path + location.search : location.pathname + location.search + '#' + path.slice(1);
}
/** Live routed boards open on Dashboard; exports and embedded pages retain their own default and remembered tab. */
function homeTab(page) {
  if (routed) return 'dashboard';
  const kept = keep('pb.tab');
  return kept && kept !== 'roadmap' ? kept : page?.project && !page.project.items?.length ? 'home' : 'items';
}

const view = { roadmapOpen: new Map(), root: keep('pb.project'), tab: addressTab() || homeTab(), itemsView: typeof location !== 'undefined' && location.hash === '#items/pipeline' ? 'pipeline' : 'list', filterOpen: false, seen: {}, code: {}, item: null, adding: false, declining: null, state: 'active', rows: { spec: 'decide', doctrine: 'all' }, row: { spec: null, doctrine: null }, agent: null, allAgents: false, agentsHidden: keep('pb.agents') === 'hidden', statsOpen: false, open: {}, addressDetail: null, shout: null, scrollPlace: false };
let switchGeneration = 0;
// Each board read in the order it started, and the newest one drawn: an answer older than that one is stale.
let refreshStarted = 0;
let refreshDrawn = { generation: 0, full: true };
if (snapshot) view.state = 'all';
let data = null;
let seen = '';
let addressReady = false;
let heldClickPointer = null;
let deferredClickRender = false; const pageDialogs = new Set(); // open page dialogs; the page holds its redraws while one is open
// Detail replies stay with an unchanged summary, while search results are keyed by board and words.
const itemDetails = new Map();
`;
}
