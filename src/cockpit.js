import { effectiveGuards, IN_STATE, MACHINE } from './machine.js';

/**
 * The item lifecycle as the page draws it (M1): each state with what it means and, for a final
 * state, what every way in checks; each move with who makes it, its command or the clock's
 * condition, and the rules it checks in order, each with the code it refuses with. The page lays
 * this out itself, so the drawing is the declaration and cannot go stale.
 *
 * @returns {{ initial: string, states: object[], moves: object[] }}
 */
function lifecycle() {
  const guards = new Map(MACHINE.guards.map((guard) => [guard.id, guard]));
  const rule = (move, id) => (id === IN_STATE ? `the item is ${move.from.join(' or ')} (${move.refuse})` : `${guards.get(id).rule} (${guards.get(id).refuse})`);
  return {
    initial: MACHINE.initial,
    states: MACHINE.states.map((state) => ({ id: state.id, means: state.means, final: Boolean(state.final), entry: (MACHINE.exitGuards[state.id] ?? []).map((id) => guards.get(id).rule) })),
    moves: MACHINE.moves.map((move) => ({ verb: move.verb, from: move.from, to: move.to, by: move.by, how: move.command ?? `when ${move.when}`, checks: effectiveGuards(move).map((id) => rule(move, id)) })),
  };
}

/**
 * The page `pullboard view` serves (N26): one self-contained file, no assets from anywhere, that
 * reads the board through the server's JSON and refreshes itself. The layout is the one the person
 * asked for: a sidebar listing every project on the machine with what needs them there, and a main
 * column with the tabs over two panes, a list and the selected thing's detail. Activity draws the
 * item lifecycle from src/machine.js with this board's counts. Under 900px wide the sidebar folds
 * into a top bar. Forms post actions that the server runs as CLI commands (N27), so the page never
 * decides a rule itself, and every field a person types in sits outside what the refresh rebuilds.
 * Its styles are src/view.css, which it links with the session's secret as every request carries it;
 * styles stay in that separate file so its policy can refuse inline styles. The serving host
 * supplies the API base and credential headers; clients need no loopback-specific connection.
 * The Roadmap tab has its own address (N38): /roadmap on a host that serves the page there too,
 * which `paths` declares, and a #roadmap fragment anywhere else, such as a snapshot hosted under a
 * folder, where a path the host does not serve would leave a reload with nothing.
 *
 * @param {string} [key] - The session's secret.
 * @param {{snapshot?: boolean, readOnly?: boolean, requests?: boolean, transportModule?: string|null, apiBase?: string, apiHeaders?: Record<string, string>, stylesheet?: string, paths?: boolean}} [options] - Served connection and assets, optional person requests over a read-only transport, host routes, or a static page with event replay.
 * @returns {string}
 */
export function cockpitPage(key = '', { snapshot = false, readOnly = false, requests = false, transportModule = null, apiBase = '', apiHeaders = { 'x-pullboard-key': key }, stylesheet = null, paths = false } = {}) {
  if (transportModule !== null && (typeof transportModule !== 'string' || !transportModule.trim())) throw new TypeError('transportModule must be a non-empty module URL or null');
  const connection = JSON.stringify(transportModule ? { base: '', headers: {} } : { base: apiBase.replace(/\/$/, ''), headers: apiHeaders }).replace(/</g, '\\u003c');
  const moduleOption = JSON.stringify(transportModule).replace(/</g, '\\u003c');
  const requestMode = Boolean(readOnly && requests && !snapshot && transportModule);
  const css = stylesheet ?? (snapshot ? 'view.css' : transportModule ? '/view.css' : '/view.css?k=' + encodeURIComponent(key));
  const cssAttribute = css.replace(/[&<>"']/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]);
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Pullboard</title>
<link rel="stylesheet" href="${cssAttribute}">
<link rel="icon" href="data:,">
</head>
<body class="loading${snapshot ? ' snapshot' : ''}${readOnly ? ' read-only' : ''}${requestMode ? ' requests' : ''}">
<div class="shell">
<aside class="side" id="side" aria-label="Projects">
  <div class="side-top">
    <button class="brand" id="side-toggle" type="button" aria-pressed="false" aria-controls="side-body" aria-label="Collapse the project list" title="Collapse the project list"><svg viewBox="0 0 64 64" aria-hidden="true"><path fill="currentColor" d="M8 7h35a6 6 0 0 1 6 6v7H8a5 5 0 0 1-5-5v-3a5 5 0 0 1 5-5Z"/><rect width="56" height="14" x="3" y="25" fill="var(--accent)" rx="5"/><path fill="currentColor" d="M8 43h35a6 6 0 0 1 6 6v8H8a5 5 0 0 1-5-5v-4a5 5 0 0 1 5-5Z"/></svg><span>Pullboard</span></button>
    <button class="switch-btn" id="proj-switch" type="button" aria-expanded="false" aria-controls="side-body"><span id="proj-name">Projects</span><b class="need" id="proj-elsewhere" title="Needs you in other projects" hidden></b><small>▾</small></button>
    <button class="theme-btn" id="theme" type="button" title="Theme: system"><svg class="sys" viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="8" r="6" fill="none" stroke="currentColor" stroke-width="1.5"/><path fill="currentColor" d="M8 2a6 6 0 0 1 0 12Z"/></svg><svg class="sun" viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="8" r="3" fill="none" stroke="currentColor" stroke-width="1.5"/><path fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" d="M8 1.5v1.2M8 13.3v1.2M1.5 8h1.2M13.3 8h1.2M3.4 3.4l.85.85M11.75 11.75l.85.85M3.4 12.6l.85-.85M11.75 4.25l.85-.85"/></svg><svg class="moon" viewBox="0 0 16 16" aria-hidden="true"><path fill="none" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round" d="M13.6 9.6A6 6 0 1 1 6.4 2.4a5.2 5.2 0 0 0 7.2 7.2Z"/></svg></button>
  </div>
  <div class="side-body" id="side-body">
    <div class="label">Projects</div>
    <nav id="proj-list" aria-label="Projects on this machine"></nav>
    <section class="products" id="products" aria-label="Products" hidden><div class="label">Products</div><div id="prod-list"></div></section>
  </div>
</aside>
<div class="body">
<header class="top">
  <nav class="tabs" id="tabs" aria-label="Board">
    <button class="tab" data-tab="items" type="button">Items<b id="count-items"></b></button>
    <button class="tab" data-tab="shouts" type="button">Shouts<b id="count-shouts"></b></button>
    <button class="tab" data-tab="spec" type="button">Spec<b id="count-spec"></b></button>
    <button class="tab" data-tab="doctrine" type="button">Doctrine<b id="count-doctrine"></b></button>
    <button class="tab" data-tab="activity" type="button">Activity</button>
    <button class="tab" data-tab="roadmap" type="button">Roadmap</button>
  </nav>
  <span class="live" id="live"></span>
</header>
<main>
  <section class="card-panel first">
    <h2>No boards yet</h2>
    <p>Run <code>pullboard init</code> in a git repo, or ask an agent to. Its board shows up here by itself.</p>
  </section>
  <section class="card-panel snapshot-controls" id="snapshot-controls" ${snapshot ? '' : 'hidden'} aria-label="Snapshot replay">
    <span>Read-only snapshot</span>
    <button class="ghost" id="replay-play" type="button">Play from first event</button>
    <button class="ghost" id="replay-pause" type="button" disabled>Pause</button>
    <label>Speed <select id="replay-speed"><option value="1">1×</option><option value="4">4×</option><option value="16">16×</option></select></label>
    <output id="replay-progress" aria-live="polite">Loading events…</output>
  </section>
  <section id="group-view" class="group-view" hidden>
    <section class="card-panel group-panel"><h2>Needs you</h2><div id="group-needs"></div></section>
    <section class="card-panel group-panel"><h2>Activity</h2><div class="feed" id="group-activity"></div></section>
  </section>
  <section class="card-panel person-requests" id="person-requests" aria-label="Your requests" aria-live="polite" hidden></section>
  <section data-pane="items" class="two">
    <div class="primary">
      <div class="card-panel toolbar"><div class="seg" id="state-chips" role="group" aria-label="Show"></div><input id="q" type="search" placeholder="Search" aria-label="Search titles, lanes or ids"><button class="go" id="new-item" type="button">New item</button></div>
      <section class="needs-you" id="needs" aria-label="What needs you" hidden></section>
      <ol class="card-panel chain" id="chain" aria-label="Items"></ol>
    </div>
    <aside class="card-panel detail" aria-label="Item detail">
      <div id="detail"></div>
      <form id="add-form" class="panel-form" hidden>
        <h3>New item</h3>
        <label>Lane<select id="add-lane"></select></label>
        <label>Title<input id="add-title" required placeholder="What to build"></label>
        <label>Criterion<input id="add-criterion" placeholder="How a verifier knows it is done"></label>
        <label>Spec rows<input id="add-specs" placeholder="G1,G2"></label>
        <label>Brief<textarea id="add-brief" rows="4" placeholder="How to build it: the files, the change, the test"></textarea></label>
        <div class="actions"><button class="go" type="submit">Add item</button><button class="ghost" id="add-cancel" type="button">Cancel</button></div>
      </form>
    </aside>
  </section>
  <section data-pane="shouts" class="two narrow">
    <div class="primary">
      <section class="needs-you" id="decisions" aria-label="Decisions needed" hidden></section>
      <form id="shout-form" class="card-panel inline"><p class="answering" id="answering" hidden><span>Answering <b id="answering-who"></b>: <span id="answering-q"></span></span><button class="ghost" id="answer-cancel" type="button">Cancel</button></p><label>To<input id="shout-to" list="shout-targets" required placeholder="all, a lane or an agent"></label><datalist id="shout-targets"></datalist><label class="wide">Message<input id="shout-text" required></label><button class="go" id="shout-send" type="submit">Shout</button></form>
      <div class="card-panel feed" id="feed"></div>
    </div>
    <aside class="card-panel detail" aria-label="Agents and lanes">
      <div><h3>Agents</h3><div id="agents"></div></div>
      <div><h3>Lanes</h3><div id="lanes"></div></div>
      <form id="hold-form" class="panel-form"><label>Hold a lane<select id="hold-lane"></select></label><label>Why<input id="hold-reason" required placeholder="What its agents should wait for"></label><button class="go" type="submit">Hold lane</button></form>
    </aside>
  </section>
  <section data-pane="spec" class="two">
    <div class="primary"><div class="chips" id="spec-chips"></div><div class="card-panel rows" id="spec-list"></div></div>
    <aside class="card-panel detail" aria-label="Spec row"><div id="spec-detail"></div></aside>
  </section>
  <section data-pane="doctrine" class="two">
    <div class="primary"><div class="chips" id="doctrine-chips"></div><div class="card-panel rows" id="doctrine-list"></div></div>
    <aside class="card-panel detail" aria-label="Practice row"><div id="doctrine-detail"></div></aside>
  </section>
  <section data-pane="activity">
    <figure class="card-panel flow" id="flow-panel"><button class="flow-hide" id="flow-hide" type="button" title="Hide the lifecycle" aria-label="Hide the lifecycle">×</button><div id="flow"></div><figcaption>The lifecycle every item follows, as pullboard declares it. Boxes count the items in each state now, labels the moves made along each route, and ↻ the moves that keep an item where it is; hover over one for what it means and checks.</figcaption></figure>
    <button class="ghost flow-show" id="flow-show" type="button" hidden>Show the lifecycle</button>
    <div class="card-panel feed" id="activity"></div>
  </section>
  <section data-pane="roadmap" class="roadmap" id="roadmap" aria-label="Roadmap"></section>
</main>
</div>
</div>
<div class="spec-reason-backdrop" id="spec-decline-dialog" hidden>
  <form class="spec-reason-dialog" id="spec-decline-form" aria-labelledby="spec-decline-title">
    <h2 id="spec-decline-title">Decline spec row</h2>
    <label>Reason<input id="spec-decline-reason" required maxlength="240" placeholder="Why this row needs changes"></label>
    <div class="actions"><button class="go" id="spec-decline-submit" type="submit">Decline row</button><button class="ghost" id="spec-decline-cancel" type="button">Cancel</button></div>
  </form>
</div>
<div class="console" id="console" title="Click to close" hidden></div>
<script>
const snapshot = ${JSON.stringify(snapshot)};
const readOnly = ${JSON.stringify(readOnly)};
const requests = ${JSON.stringify(requestMode)};
const transportModule = ${moduleOption};
const connection = ${connection};
let transport = null;
let transportLoadError = null;
const snapshotReplay = { final: null, events: [], index: 0, playing: false, timer: null };
const keep = (name, value) => { name = snapshot ? 'snapshot.' + name : name; try { if (value === undefined) return localStorage.getItem(name); localStorage.setItem(name, value); } catch { return null; } return value; };
// Whether the host serves this page at /roadmap as well as at /, so the Roadmap's address is a path;
// anywhere else it is a #roadmap fragment on the page's own address (N38).
const routed = ${JSON.stringify(Boolean(paths) && !snapshot)};
/** The tab the address names: the Roadmap at its own address, or null at the board's. */
function addressTab() {
  if (typeof location === 'undefined') return null;
  return (routed ? location.pathname === '/roadmap' : location.hash === '#roadmap') ? 'roadmap' : null;
}
/** The tab the board's own address shows: the one last picked there, or Items. */
function homeTab() {
  const kept = keep('pb.tab');
  return kept && kept !== 'roadmap' ? kept : 'items';
}
const view = { root: keep('pb.project'), tab: addressTab() || homeTab(), seen: {}, code: {}, item: null, adding: false, declining: null, state: 'active', rows: { spec: 'decide', doctrine: 'all' }, row: { spec: null, doctrine: null } };
if (snapshot) view.state = 'all';
let data = null;
let seen = '';
const $ = (id) => document.getElementById(id);
/**
 * Draw the page in the theme the person picked: light or dark, or anything else to follow the system.
 * The tokens hold both values, so only the scheme they answer to changes.
 */
function theme(pick) {
  if (pick === 'light' || pick === 'dark') document.documentElement.dataset.theme = pick;
  else delete document.documentElement.dataset.theme;
  $('theme').title = 'Theme: ' + (document.documentElement.dataset.theme || 'system');
}
theme(keep('pb.theme'));
/** Collapse the sidebar into the tab bar on a wide screen, or bring it back, as the person last chose. */
function collapseSide(collapsed) {
  if (collapsed) document.documentElement.dataset.side = 'collapsed';
  else delete document.documentElement.dataset.side;
  $('side-toggle').setAttribute('aria-pressed', String(collapsed));
  $('side-toggle').title = collapsed ? 'Show the project list' : 'Collapse the project list';
  $('side-toggle').setAttribute('aria-label', $('side-toggle').title);
}
collapseSide(keep('pb.side') === 'collapsed');
const esc = (text) => String(text ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const ago = (iso) => { const m = Math.round((Date.now() - Date.parse(iso)) / 60000); return m < 1 ? 'now' : m < 60 ? m + 'm' : m < 2880 ? Math.round(m / 60) + 'h' : Math.round(m / 1440) + 'd'; };
// An age as the page shows it: the moment it counts from stays on it, so tickAges can move it on.
const age = (iso) => '<time data-ago="' + esc(iso) + '">' + ago(iso) + '</time>';
const clock = (iso) => new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
const when = (iso) => (new Date(iso).toDateString() === new Date().toDateString() ? '' : new Date(iso).toLocaleDateString([], { month: 'short', day: 'numeric' }) + ' ') + clock(iso);
// A day as a feed names it: Today, Yesterday, or its weekday and date.
const dayName = (iso) => {
  const then = new Date(iso).toDateString(), today = new Date();
  if (then === today.toDateString()) return 'Today';
  today.setDate(today.getDate() - 1);
  return then === today.toDateString() ? 'Yesterday' : new Date(iso).toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' });
};
// A feed's rows, newest first, with the day named above each run of rows from the same day.
const byDay = (rows, at, row) => rows.map((x, i) => (i && new Date(at(x)).toDateString() === new Date(at(rows[i - 1])).toDateString() ? '' : '<h4 class="day">' + dayName(at(x)) + '</h4>') + row(x)).join('');
const firstLine = (text) => String(text ?? '').split('\\n').map((line) => line.trim()).find(Boolean) || '';
// The latest verdict is a reject and no accept followed: open again, being reworked, resubmitted, or
// withdrawn after it.
const rejected = (i) => i.status !== 'verified' && !!i.verdict && i.verdict.decision === 'REJECT';
/** Render a review note with escaped text and references bound to the selected board. */
const verdictHtml = (v, titles) => '<div class="verdict ' + (v.decision === 'ACCEPT' ? 'yes' : 'no') + '"><b>' + esc(v.decision) + ' ' + esc(v.reason) + '</b><span class="by">' + esc(v.by) + ' · ' + when(v.at) + ' · at ' + esc(String(v.commit || '').slice(0, 12)) + '</span><div class="note">' + linked(v.note, titles) + '</div></div>';
const stateOf = (i) => i.status === 'claimed' ? 'building' : i.status === 'submitted' ? 'verify' : i.status === 'verified' ? 'verified' : i.status === 'withdrawn' ? 'withdrawn' : i.verdict && i.verdict.decision === 'REJECT' ? 'back' : 'open';
const STATES = { building: ['building', 'busy'], verify: ['to verify', 'warn'], back: ['sent back', 'no'], verified: ['verified', 'ok'], open: ['open', ''], withdrawn: ['withdrawn', ''] };
const chip = (s) => '<span class="chip ' + STATES[s][1] + '">' + STATES[s][0] + '</span>';
// A shout's path:lines@commit reference (B23): a button, and under it, once opened, that code as it
// was at that commit, with its line numbers. The text before it on its line goes with it, so the view
// can refuse a reference that text may make part of a longer path.
const codeRef = (ref, before) => {
  const c = view.code[view.root + '\\n' + before + '\\n' + ref];
  const open = Boolean(c && c.open);
  const shown = !open ? '' : c.error ? '<span class="code no">' + esc(c.error) + '</span>' : !c.lines ? '<span class="code more">loading…</span>'
    : '<span class="code">' + c.lines.map((line, n) => '<span><i>' + (c.from + n) + '</i>' + esc(line) + '</span>').join('') + (c.more ? '<span class="more">the first ' + c.lines.length + ' lines</span>' : '') + '</span>';
  return '<button class="ref" data-code="' + esc(ref) + '"' + (before ? ' data-before="' + esc(before) + '"' : '') + ' type="button" aria-expanded="' + open + '">' + esc(ref) + '</button>' + shown;
};
/** Format the API's structured fact binding as the live reference the code preview accepts. */
function factCodeRef(ref) {
  if (!ref || typeof ref !== 'object') return String(ref ?? '');
  const lines = ref.start === ref.end ? String(ref.start) : ref.start + '-' + ref.end;
  return ref.path + ':' + lines + '@' + ref.commit;
}
const tone = (s) => s === 'approved' ? 'ok' : s === 'pending' ? 'no' : s === 'draft' ? 'warn' : '';
/** A doctrine rule's source, with a version only when it comes from the shipped standard. */
const ruleSource = (row) => row.origin === 'standard' ? 'standard ' + row.version : 'repo';
const count = (n, one, many = one) => n + ' ' + (n === 1 ? one : many);
// What needs the person in a project, as its Needs-you list counts it: only the person's calls (B26),
// the decisions passed up to them, spec rows waiting for them, and held lanes, which only the main
// checkout, the person's seat, can set. Work waiting for a verdict or sent back belongs to the agents,
// and the line under the project says so without counting it.
const needCount = (x) => x.ok ? x.decisions + x.pending + x.drafts + x.holds : 0;
const doing = (x) => [x.decisions && count(x.decisions, 'decision', 'decisions'), x.pending && count(x.pending, 'question', 'questions'), x.drafts && count(x.drafts, 'draft row', 'draft rows'), x.holds && count(x.holds, 'lane held', 'lanes held'), x.sentBack && count(x.sentBack, 'sent back'), x.awaiting && count(x.awaiting, 'to verify'), x.building && count(x.building, 'building')].filter(Boolean).join(' · ') || (x.open ? count(x.open, 'item open', 'items open') : 'nothing open');
/** The person's calls in one repo, as its Needs-you panel shows them, reused by a combined project view. */
function projectNeeds(p) {
  return [
    ...p.decisions.map((d) => ({ ref: d.shout_from, text: d.shout_text, what: 'decision', at: d.shout_at })),
    ...p.spec.filter((row) => row.status === 'pending' && !row.decision).map((row) => ({ ref: row.id, text: row.text, what: 'answer in SPEC.md' })),
    ...p.holds.map((hold) => ({ ref: hold.hold_lane, text: hold.hold_reason, what: 'lane held by ' + hold.hold_by })),
    ...(p.spec.some((row) => row.status === 'draft' && !row.decision) ? [{ ref: String(p.spec.filter((row) => row.status === 'draft' && !row.decision).length), text: 'draft spec rows to approve or drop', what: 'review in SPEC.md', target: 'tab:spec' }] : []),
  ];
}
// The item lifecycle as pullboard declares it in src/machine.js, embedded when the page is served.
const FLOW = ${JSON.stringify(lifecycle()).replaceAll('<', '\\u003c')};

/**
 * An item's history replayed through the lifecycle: each event with the state it found the item in
 * and the move it made, if it made one. The board logs a move under its verb, and a claim on a
 * claimed item as renew, but never the clock's lapse: an event that cannot start where the replay
 * stands, or an item that reads otherwise than where its history leaves it, means the clock moved
 * first, and the replay puts that lapse in, with no time of its own.
 */
function replay(item) {
  const clock = FLOW.moves.filter((m) => m.by.includes('clock'));
  const steps = [];
  let at = FLOW.initial;
  const step = (move, e) => {
    steps.push({ from: at, move, at: e ? e.at : null, by: e ? e.by : 'the clock', kind: e ? e.kind : move.verb });
    if (move) at = move.to;
  };
  for (const e of item.history) {
    const verb = e.kind === 'renew' ? 'claim' : e.kind;
    // A renew is the claim that stays claimed; a claim logged as such is the one that arrives.
    const fits = (s) => FLOW.moves.find((m) => m.verb === verb && m.from.includes(s) && (verb !== 'claim' || (e.kind === 'renew') === (m.to === s)));
    const lapse = fits(at) ? null : clock.find((m) => m.from.includes(at) && fits(m.to));
    if (lapse) step(lapse, null);
    step(fits(at) || null, e);
  }
  const lapse = at === item.status ? null : clock.find((m) => m.from.includes(at) && m.to === item.status);
  if (lapse) step(lapse, null);
  return steps;
}

/** How often each move was made on this board, keyed from>to:verb, from every item's replay. */
function moveCounts(items) {
  const counts = new Map();
  for (const item of items) {
    for (const s of replay(item)) {
      if (s.move) counts.set(s.from + '>' + s.move.to + ':' + s.move.verb, (counts.get(s.from + '>' + s.move.to + ':' + s.move.verb) || 0) + 1);
    }
  }
  return counts;
}

// A finished stay as the timeline says it: 45m, 3h 20m, 2d 4h.
const span = (ms) => {
  const m = Math.max(0, Math.round(ms / 60000));
  return m < 1 ? 'under a minute' : m < 60 ? m + 'm' : m < 1440 ? Math.floor(m / 60) + 'h' + (m % 60 ? ' ' + (m % 60) + 'm' : '') : Math.floor(m / 1440) + 'd' + (Math.floor((m % 1440) / 60) ? ' ' + Math.floor((m % 1440) / 60) + 'h' : '');
};

/**
 * An item's history drawn as a timeline. Each move is a dot in the colour of the state it led to, a
 * reject in the colour of work sent back, and the item's creation (logged as add) one in the start
 * state's colour; an event that moves nothing is a hollow dot. Between the dots runs a line in the
 * colour of the state the item stayed in, and under each dot that began a stay, how long it lasted,
 * or how long so far while the item can still leave. A lapse has a row but no time, so a stay that
 * ends or begins at one says its length was not logged rather than guess it.
 */
function timeline(item) {
  const entries = Array.isArray(item.thread) && item.thread.length
    ? item.thread
    : item.history.filter((entry) => entry.kind !== 'fact').map((entry, eventId) => ({ type: 'move', eventId: eventId + 1, ...entry }));
  const steps = replay({ ...item, history: entries.filter((entry) => entry.type === 'move').map(({ kind, by, at }) => ({ kind, by, at })) });
  const facts = entries.filter((entry) => entry.type === 'fact');
  const replacements = new Map(facts.filter((fact) => fact.supersedes).map((fact) => [fact.supersedes, fact]));
  const rows = [];
  let stepIndex = 0;
  /** Render a lifecycle step, keeping inferred clock lapses between recorded moves. */
  const moveRow = (s, event, index) => {
    const enters = s.move ? s.move.to : s.kind === 'add' ? FLOW.initial : null;
    const state = enters || s.from;
    const final = FLOW.states.some((f) => f.id === state && f.final);
    const next = steps.slice(index + 1).find((n) => n.move);
    const named = s.kind === 'reject' ? 'sent back' : state;
    const stay = !enters || final ? ''
      : !s.at ? esc(named + (next ? ' after the ' : ' so far since the ') + s.kind + ', length not logged')
      : !next ? esc(named) + ' for ' + age(s.at) + ' so far'
      : !next.at ? esc(named + ' until the ' + next.kind + ', length not logged')
      : esc(named + ' for ' + span(Date.parse(next.at) - Date.parse(s.at)));
    rows.push('<li class="tl-' + esc(state) + (s.kind === 'reject' ? ' tl-back' : '') + (enters ? '' : ' tl-quiet') + '"' + (event ? ' data-event-id="' + event.eventId + '"' : '') + '><time>' + (s.at ? when(s.at) : '') + '</time><span><b>' + esc(s.kind) + '</b> ' + esc(s.by) + '</span>' + (stay ? '<small>' + stay + '</small>' : '') + '</li>');
  };
  /** Render one API fact with its identity, replacement and committed code binding. */
  const factRow = (fact) => {
    const replacement = replacements.get(fact.id);
    const judgement = ['decision', 'rejection', 'supersession', 'root-cause'].includes(fact.kind);
    rows.push('<li id="fact-' + esc(fact.id) + '" class="tl-fact' + (judgement ? ' tl-judgement' : '') + (replacement ? ' tl-superseded' : '') + '" data-event-id="' + fact.eventId + '"><time>' + when(fact.at) + '</time><span class="tl-fact-head"><span class="chip">' + esc(fact.kind) + '</span> <b>' + esc(fact.by) + '</b></span><span class="tl-body">' + esc(fact.text) + '</span><small>' + age(fact.at) + (replacement ? ' · <a class="thread-replacement" href="#fact-' + esc(replacement.id) + '">replaced by ' + esc(replacement.kind) + '</a>' : '') + '</small>' + (fact.ref ? '<div class="tl-code">' + codeRef(factCodeRef(fact.ref), '') + '</div>' : '') + '</li>');
  };
  for (const entry of entries) {
    if (entry.type === 'fact') { factRow(entry); continue; }
    while (stepIndex < steps.length && !(steps[stepIndex].kind === entry.kind && steps[stepIndex].by === entry.by && steps[stepIndex].at === entry.at)) {
      moveRow(steps[stepIndex], null, stepIndex);
      stepIndex += 1;
    }
    if (stepIndex < steps.length) {
      moveRow(steps[stepIndex], entry, stepIndex);
      stepIndex += 1;
    }
  }
  while (stepIndex < steps.length) {
    moveRow(steps[stepIndex], null, stepIndex);
    stepIndex += 1;
  }
  return '<ol class="tl">' + rows.join('') + '</ol>';
}

/**
 * The lifecycle drawn as SVG with this board's counts, the way the README's figure draws it. The
 * longest way from the start to a final state runs along a row, the first-declared final winning a
 * tie, its states joined by straight arrows. A pair of states a move leads back along takes a dashed
 * square route above the row, the further back the higher. The moves that keep a state are written
 * in its box after a ↻. A state off the row sits below the last state on the row that leads to it,
 * and the routes into it join into one, labelled once. Final states have a double border. Boxes
 * count the items there now; labels count the moves made along each route, or name its moves when
 * none was. Words are wrapped and placed by a generous estimate of their width, so none overlaps.
 */
function flowSvg(p) {
  const counts = moveCounts(p.items);
  const finals = FLOW.states.filter((s) => s.final).map((s) => s.id);
  const leads = (s) => FLOW.moves.filter((m) => m.from.includes(s) && m.to !== s).map((m) => m.to);
  let row = [];
  const walk = (trail) => {
    const at = trail[trail.length - 1];
    if (finals.includes(at)) {
      if (trail.length > row.length || (trail.length === row.length && finals.indexOf(at) < finals.indexOf(row[row.length - 1]))) row = trail;
      return;
    }
    for (const next of new Set(leads(at))) if (!trail.includes(next)) walk([...trail, next]);
  };
  walk([FLOW.initial]);
  const W = 880, L = 20, BW = 160, step = (W - 2 * L - BW) / Math.max(row.length - 1, 1);
  const f = (v) => String(Math.round(v * 10) / 10);
  const col = (s) => row.indexOf(s);
  const pairs = [];
  for (const m of FLOW.moves) for (const from of m.from) {
    let pair = pairs.find((e) => e.from === from && e.to === m.to);
    if (!pair) pairs.push((pair = { from, to: m.to, moves: [] }));
    pair.moves.push(m);
  }
  const made = (pair, m) => counts.get(pair.from + '>' + pair.to + ':' + m.verb) || 0;
  const says = (pair) => pair.moves.map((m) => m.verb + ', ' + pair.from + ' to ' + pair.to + ', by the ' + m.by.join(' or ') + ': ' + m.how + '. Made ' + count(made(pair, m), 'time', 'times') + (m.checks.length ? '.\\nChecks, in order:\\n' + m.checks.map((c) => '  ' + c).join('\\n') : '.')).join('\\n\\n');
  // What some pairs' moves come to: each verb with how often it was made, or every verb when none was.
  const told = (list) => {
    const sums = new Map();
    for (const pair of list) for (const m of pair.moves) sums.set(m.verb, (sums.get(m.verb) || 0) + made(pair, m));
    const done = [...sums].filter(([, n]) => n);
    return { words: done.length ? done.map(([verb, n]) => verb + ' ' + n) : [...sums.keys()], idle: !done.length };
  };
  // A generous width for words at a size, and words joined by dots into the fewest even lines that
  // fit a room, as the README's figure splits them.
  const wide = (words, size) => words.length * size * 0.56;
  const wrap = (words, room, size) => {
    for (let n = 1; ; n += 1) {
      const per = Math.ceil(words.length / n), lines = [];
      for (let i = 0; i < words.length; i += per) lines.push(words.slice(i, i + per).join(' · '));
      if (per === 1 || lines.every((line) => wide(line, size) <= room)) return lines;
    }
  };
  const text = (x, y, words, cls, anchor = 'middle') => '<text class="' + cls + '" x="' + f(x) + '" y="' + f(y) + '" text-anchor="' + anchor + '">' + esc(words) + '</text>';
  const lines = (x, y, said, cls, anchor) => said.map((line, i) => text(x, y - 15 * (said.length - 1 - i), line, cls, anchor)).join('');
  const path = (points) => 'M' + points.map(([x, y]) => f(x) + ' ' + f(y)).join('L');

  // Inside each box: its name and count, then the moves that keep it, then any items sent back.
  const back = p.items.filter((i) => stateOf(i) === 'back').length;
  const inside = new Map(FLOW.states.map((s) => {
    const keeps = pairs.find((pair) => pair.from === s.id && pair.to === s.id);
    const said = keeps ? told([keeps]) : null;
    const kept = said ? wrap(said.words, BW - 28 - wide('↻ ', 11), 11).map((line, i) => (i ? '  ' : '↻ ') + line) : [];
    return [s.id, { keeps, said, kept, back: s.id === FLOW.initial && back ? back + ' sent back' : '' }];
  }));
  const BH = 44 + 15 * Math.max(1, ...[...inside.values()].map((box) => box.kept.length + (box.back ? 1 : 0)));

  // Routes back along the row, each at a level by how far back it goes; their words above them.
  const ups = pairs.filter((pair) => pair.from !== pair.to && col(pair.from) >= 0 && col(pair.to) >= 0 && col(pair.to) !== col(pair.from) + 1)
    .map((pair) => ({ pair, span: Math.abs(col(pair.from) - col(pair.to)) })).sort((a, b) => a.span - b.span);
  const spans = [...new Set(ups.map((up) => up.span))];
  for (const up of ups) {
    up.level = spans.indexOf(up.span);
    const a = L + BW / 2 + col(up.pair.from) * step, b = L + BW / 2 + col(up.pair.to) * step;
    const before = (key, value) => ups.filter((other) => other !== up && other.pair[key] === value && other.span < up.span).length;
    up.start = a + (a > b ? 16 : -16) + (a > b ? 26 : -26) * before('from', up.pair.from);
    up.end = b + (a > b ? BW / 2 - 40 : 40 - BW / 2) + (a > b ? -30 : 30) * before('to', up.pair.to);
    up.said = told([up.pair]);
    up.lines = wrap(up.said.words, Math.abs(up.start - up.end) - 20, 12);
  }
  // Each level stands clear of the words of the level below it.
  const rise = [];
  for (const level of spans.keys()) {
    const below = ups.filter((up) => up.level === level - 1);
    rise[level] = level ? rise[level - 1] + 18 + 15 * Math.max(...below.map((up) => up.lines.length)) : 30;
  }
  const highest = ups.length ? Math.max(...ups.map((up) => rise[up.level] + 21 + 15 * (up.lines.length - 1))) : 0;
  const top = 12 + highest, Y = top + BH / 2, bottom = top + BH;
  const pos = new Map(row.map((s, i) => [s, { x: L + BW / 2 + i * step, y: Y }]));

  // A state off the row sits below the last state on it that leads there.
  const below = FLOW.states.filter((s) => !pos.has(s.id));
  for (const s of below) {
    const from = row.filter((r) => leads(r).includes(s.id));
    pos.set(s.id, { x: from.length ? pos.get(from[from.length - 1]).x : W / 2, y: bottom + 80 + BH / 2 });
  }
  const H = (below.length ? bottom + 80 + BH : bottom) + 14;

  const group = (pairList, route, label) => pairList.map((pair, n) => '<g><title>' + esc(says(pair)) + '</title><path class="edge' + (route.back ? ' back' : '') + '" d="' + route.d + '" marker-end="url(#pb-head' + (route.back ? '-back' : '') + ')"/>' + (n === 0 ? label : '') + '</g>').join('');
  const tone = (said, extra = '') => 'tag' + (said.idle ? ' idle' : '') + extra;
  const routes = [];
  // Straight along the row.
  for (const pair of pairs.filter((pair) => col(pair.from) >= 0 && col(pair.to) === col(pair.from) + 1)) {
    const a = pos.get(pair.from), b = pos.get(pair.to), said = told([pair]);
    routes.push(group([pair], { d: path([[a.x + BW / 2, Y], [b.x - BW / 2 - 1, Y]]) }, text((a.x + b.x) / 2, Y - 8, said.words.join(' · '), tone(said))));
  }
  // Square, above the row.
  for (const up of ups) {
    const isBack = col(up.pair.to) < col(up.pair.from), y = top - rise[up.level];
    routes.push(group([up.pair], { back: isBack, d: path([[up.start, top], [up.start, y], [up.end, y], [up.end, top - 1]]) }, lines((up.start + up.end) / 2, y - 7, up.lines, tone(up.said, isBack ? ' back' : ''))));
  }
  // Down from the row, joining into one route per state below, labelled once on the way in.
  for (const s of below) {
    const t = pos.get(s.id), into = pairs.filter((pair) => pair.to === s.id && pos.has(pair.from) && pair.from !== s.id);
    const said = told(into), tTop = t.y - BH / 2;
    const xs = into.map((pair) => pos.get(pair.from).x).sort((a, b) => a - b);
    const left = xs.filter((x) => x < t.x - 0.5), right = xs.filter((x) => x > t.x + 0.5);
    const label = left.length
      ? lines((left[0] + (left[1] ?? t.x - BW / 2)) / 2, t.y - 8, wrap(said.words, (left[1] ?? t.x - BW / 2) - left[0] - 20, 12), tone(said))
      : right.length
        ? lines((right[right.length - 1] + (right[right.length - 2] ?? t.x + BW / 2)) / 2, t.y - 8, wrap(said.words, right[right.length - 1] - (right[right.length - 2] ?? t.x + BW / 2) - 20, 12), tone(said))
        : lines(t.x + 10, (bottom + tTop) / 2 + 4, said.words, tone(said), 'start');
    // The label goes with the route that reaches furthest, drawn first; the others join it.
    const order = [...into].sort((p1, p2) => Math.abs(pos.get(p2.from).x - t.x) - Math.abs(pos.get(p1.from).x - t.x));
    order.forEach((pair, n) => {
      const a = pos.get(pair.from);
      const d = Math.abs(a.x - t.x) < 0.5 ? path([[a.x, bottom], [t.x, tTop - 1]]) : path([[a.x, bottom], [a.x, t.y], [a.x < t.x ? t.x - BW / 2 - 1 : t.x + BW / 2 + 1, t.y]]);
      routes.push(group([pair], { d }, n === 0 ? label : ''));
    });
  }

  const boxes = FLOW.states.map((s) => {
    const { x, y } = pos.get(s.id), box = inside.get(s.id), left = x - BW / 2, boxTop = y - BH / 2;
    const tip = s.id + ': ' + s.means + (s.entry.length ? '.\\nEvery way in checks:\\n' + s.entry.map((r) => '  ' + r).join('\\n') : '.');
    const keeps = box.kept.length ? '<g><title>' + esc(says(box.keeps)) + '</title>' + box.kept.map((line, i) => text(left + 14, boxTop + 47 + 15 * i, line, 'keep' + (box.said.idle ? ' idle' : ''), 'start')).join('') + '</g>' : '';
    return '<g class="s-' + esc(s.id) + '"><title>' + esc(tip) + '</title><rect class="box" x="' + f(left) + '" y="' + f(boxTop) + '" width="' + BW + '" height="' + BH + '" rx="10"/>'
      + (s.final ? '<rect class="box inner" x="' + f(left + 4) + '" y="' + f(boxTop + 4) + '" width="' + (BW - 8) + '" height="' + (BH - 8) + '" rx="7"/>' : '')
      + text(left + 14, boxTop + 25, s.id, 'name', 'start') + text(x + BW / 2 - 14, boxTop + 29, String(p.items.filter((i) => i.status === s.id).length), 'n', 'end')
      + keeps + (box.back ? text(left + 14, boxTop + 47 + 15 * box.kept.length, box.back, 'sub', 'start') : '') + '</g>';
  });
  const head = (id, cls) => '<marker id="' + id + '" class="' + cls + '" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0 0L10 5L0 10z"/></marker>';
  return '<svg viewBox="0 0 ' + W + ' ' + f(H) + '" role="img" aria-label="The item lifecycle, with counts from this board"><defs>' + head('pb-head', '') + head('pb-head-back', 'back') + '</defs>' + routes.join('') + boxes.join('') + '</svg>';
}

/** Read or move through API v1, retaining the rule and repair guidance in a refusal. */
async function api(path, body) {
  if (body && (snapshot || readOnly)) throw new Error(snapshot ? 'This is a read-only snapshot.' : 'This is a read-only view.');
  if (transportModule) {
    if (transport) return transport.request(path, body);
    if (transportLoadError) throw transportLoadError;
    throw new Error('The browser transport is still loading.');
  }
  path = snapshot ? path.split('?')[0].slice(1) + '.json' : connection.base + path;
  const res = await fetch(path, { method: body ? 'POST' : 'GET', headers: snapshot ? {} : { ...connection.headers, ...(body ? { 'content-type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const json = await res.json();
  if (!res.ok) {
    const refusal = json.error;
    const message = refusal && typeof refusal === 'object' ? '[' + refusal.code + '] ' + refusal.message : refusal || res.status;
    throw new Error(message);
  }
  return json;
}

/** Send only literal person intent; the transport seals it and generic API writes stay refused. */
async function sendPersonRequest(root, move) {
  if (!requests || snapshot || !readOnly) throw new Error('This view cannot send person requests.');
  if (!['add', 'shout', 'answer', 'hold', 'spec-approve', 'spec-decline'].includes(move.verb)) throw new Error('Choose a person action from the view controls.');
  if (!transport) throw transportLoadError || new Error('The browser transport is still loading.');
  return transport.request(boardPath(root) + '/moves', move);
}

/** Name a person request using its public literal intent, without exposing its sealed document. */
function requestLabel(request) {
  const move = request.move;
  const args = move?.args || {};
  if (move?.verb === 'add') return 'New item: ' + (args.title || 'Untitled');
  if (move?.verb === 'shout') return 'Shout to ' + (args.to || 'coordinator') + ': ' + (args.text || '');
  if (move?.verb === 'answer') return 'Answer #' + move.item + ': ' + (args.text || '');
  if (move?.verb === 'hold') return (args.off ? 'Release ' : 'Hold ') + (args.lane || '') + ' lane' + (!args.off && args.reason ? ': ' + args.reason : '');
  if (move?.verb === 'spec-approve') return 'Approve row ' + (args.ids || '');
  if (move?.verb === 'spec-decline') return 'Decline row ' + (args.ids || '');
  return 'Person request';
}

/** Retain the native request status and the CLI's complete refusal guidance beside an action. */
function requestNotice(request) {
  const label = { waiting: 'Waiting', done: 'Done', refused: 'Refused' }[request.status] || 'Unknown status';
  const error = request.status === 'refused' && request.error;
  return label + ' · ' + requestLabel(request) + (error ? '\\n' + (error.code ? '[' + error.code + '] ' : '') + (error.message || '') + (error.next ? '\\n' + error.next : '') : '');
}

/** Show the public request receipts on every board tab and update the latest action's status. */
function renderPersonRequests(project) {
  const entries = project?.personRequests || [];
  const panel = $('person-requests');
  panel.hidden = !entries.length;
  panel.innerHTML = entries.length ? '<h2>Your requests</h2><ul class="request-list">' + [...entries].sort((a, b) => b.sequence - a.sequence).map((request) => {
    const status = { waiting: 'Waiting', done: 'Done', refused: 'Refused' }[request.status] || 'Unknown status';
    const error = request.status === 'refused' && request.error;
    const reason = error ? '<p class="request-error">' + (error.code ? '<b>' + esc(error.code) + '</b> ' : '') + esc(error.message || '') + '</p>' + (error.next ? '<p class="request-next">' + esc(error.next) + '</p>' : '') : '';
    return '<li data-person-request="' + esc(request.id) + '"><span class="request-label">' + esc(requestLabel(request)) + '</span><span class="chip request-status ' + (request.status === 'done' ? 'ok' : request.status === 'refused' ? 'no' : 'warn') + '">' + status + '</span>' + reason + '</li>';
  }).join('') + '</ul>' : '';
  const active = view.request;
  const current = active && active.root === view.root && active.run === view.acting && entries.find((request) => request.id === active.id);
  if (current && !$('console').hidden) {
    $('console').className = 'console' + (current.status === 'done' ? ' ok' : current.status === 'refused' ? ' no' : '');
    $('console').textContent = requestNotice(current);
  }
  const feedback = view.specFeedback;
  const rowRequest = feedback?.root === view.root && feedback.requestId && entries.find((request) => request.id === feedback.requestId);
  if (rowRequest) {
    feedback.status = rowRequest.status;
    feedback.tone = rowRequest.status === 'done' ? 'ok' : rowRequest.status === 'refused' ? 'no' : '';
    feedback.text = requestNotice(rowRequest);
  }
}

/** A board's sidebar counts, derived from the same API state the page displays. */
function boardSummary(board, state) {
  /** Count one item state for the sidebar. */
  const count = (test) => state.items.filter(test).length;
  return {
    ...board, ok: true,
    building: count((item) => item.status === 'claimed'),
    awaiting: count((item) => item.status === 'submitted'),
    sentBack: count((item) => item.status === 'open' && item.verdict && item.verdict.decision === 'REJECT'),
    open: count((item) => item.status === 'open'),
    verified: count((item) => item.status === 'verified'),
    pending: state.spec.filter((row) => row.status === 'pending' && !row.decision).length,
    drafts: state.spec.filter((row) => row.status === 'draft' && !row.decision).length,
    holds: state.holds.length,
    decisions: state.decisions.length,
    // What each item's state reads from, so another repo's roadmap can show it as this board's
    // Items tab does, sent back included, and open it here.
    items: state.items.map((item) => ({ id: item.id, title: item.title, status: item.status, verdict: item.verdict && { decision: item.verdict.decision } })),
  };
}

/** Resolve a displayed repo to the persistent board identity supplied by API v1. */
function boardPath(root) {
  const board = data && data.projects.find((entry) => entry.root === root && entry.ok);
  if (!board) throw new Error('This board is unavailable; choose a readable project and retry.');
  return '/api/v1/boards/' + encodeURIComponent(board.id);
}

/** Compose the multi-repo page from the public board list and each board's public state. */
async function boardState(root, mark) {
  const listed = await api('/api/v1/boards');
  const states = new Map();
  const cursor = mark !== null && mark !== undefined && /^\\d+$/.test(String(mark)) && Number.isSafeInteger(Number(mark)) ? Number(mark) : null;
  const projects = await Promise.all(listed.boards.map(async (board) => {
    try {
      const query = board.root === root && cursor !== null ? '?seen=' + encodeURIComponent(cursor) : '';
      const reply = await api('/api/v1/boards/' + encodeURIComponent(board.id) + '/state' + query);
      states.set(board.root, reply.state);
      return boardSummary(board, reply.state);
    } catch (error) {
      return { ...board, ok: false, error: String(error.message || error) };
    }
  }));
  projects.push(...(listed.warnings || []).map((warning) => ({ ...warning, ok: false, error: warning.error.error.message })));
  const grouped = new Map();
  for (const project of projects) {
    if (!project.project) continue;
    if (!grouped.has(project.project)) grouped.set(project.project, []);
    grouped.get(project.project).push(project);
  }
  const groups = [...grouped].map(([name, repos]) => ({ name, key: 'group:' + name, repos }));
  const group = groups.find((entry) => entry.key === root);
  return {
    projects, groups, project: states.get(root) || null,
    group: group ? { name: group.name, repos: group.repos.filter((repo) => repo.ok).map((repo) => ({ root: repo.root, name: repo.name, board: states.get(repo.root) })) } : null,
  };
}

/** Refresh from API v1 and discard a response for a project the person already left. */
async function refresh() {
  const root = view.root;
  const mark = root ? view.seen['pb.seen.' + root] ?? keep('pb.seen.' + root) : null;
  const next = await boardState(root, mark);
  // The person switched projects while this answer was on its way: the switch's own refresh shows it.
  if (root !== view.root) return;
  if (!next.project && !next.group && next.projects.some((p) => p.ok)) {
    view.root = next.projects.find((p) => p.ok).root;
    keep('pb.project', view.root);
    return refresh();
  }
  // The project this board is, so a switch still loading never reads it as the next one's.
  next.root = root;
  // Rebuild only when the board changed: a list rebuilt under the pointer can swallow a click.
  const text = JSON.stringify(next);
  if (text !== seen) {
    seen = text;
    data = next;
    render();
  }
  if (snapshot && !snapshotReplay.final && data.project) {
    snapshotReplay.final = structuredClone(data.project);
    snapshotReplay.events = (await api(boardPath(view.root) + '/events')).events;
    snapshotReplay.index = snapshotReplay.events.length;
    replayControls();
  }
  $('live').textContent = snapshot ? 'read-only snapshot' : 'live · ' + new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' });
}

/** Display the current event and make the replay's play, pause and end states explicit. */
function replayControls() {
  const r = snapshotReplay;
  const event = r.events[r.index - 1];
  $('replay-progress').textContent = 'Event ' + r.index + ' / ' + r.events.length + (event ? ' · ' + event.event_kind + (event.item_id ? ' #' + event.item_id : '') : '') + (r.index === r.events.length ? ' · End' : '');
  $('replay-play').disabled = r.playing || !r.final || !r.events.length;
  $('replay-play').textContent = r.index === r.events.length ? 'Play from first event' : 'Play';
  $('replay-pause').disabled = !r.playing;
}

/** Project only the events already played, using the same declared lifecycle as the live page. */
function replayProject(index) {
  const r = snapshotReplay;
  if (index === r.events.length) return structuredClone(r.final);
  const p = structuredClone(r.final);
  const log = r.events.slice(0, index);
  p.items = p.items.flatMap((item) => {
    const history = log.filter((event) => event.item_id === item.id);
    if (!history.some((event) => event.event_kind === 'add')) return [];
    let state = FLOW.initial;
    item.owner = null;
    item.builtBy = null;
    item.verifiedBy = null;
    item.reviewer = null;
    item.reviewUntil = null;
    item.commit = null;
    item.merged = null;
    let verdicts = 0;
    for (const event of history) {
      const verb = event.event_kind === 'renew' ? 'claim' : event.event_kind;
      /** Find a declared move, distinguishing a renewed claim from a new one. */
      const fits = (at) => FLOW.moves.find((move) => move.verb === verb && move.from.includes(at) && (verb !== 'claim' || (event.event_kind === 'renew') === (move.to === at)));
      const lapse = fits(state) ? null : FLOW.moves.find((move) => move.by.includes('clock') && move.from.includes(state) && fits(move.to));
      if (lapse) state = lapse.to;
      const move = fits(state);
      if (move) state = move.to;
      const detail = JSON.parse(event.event_detail);
      if (verb === 'claim') item.owner = event.event_by;
      if (verb === 'submit') { item.commit = detail.commit; item.builtBy = event.event_by; item.reviewer = null; item.reviewUntil = null; }
      if (verb === 'reserve') { item.reviewer = event.event_by; item.reviewUntil = detail.until; }
      if (verb === 'accept') { item.verifiedBy = event.event_by; verdicts += 1; }
      if (verb === 'reject') { item.owner = null; verdicts += 1; }
      if (verb === 'accept' || verb === 'reject' || verb === 'release' || verb === 'withdraw') { item.reviewer = null; item.reviewUntil = null; }
      if (verb === 'release' || verb === 'withdraw') item.owner = null;
      if (verb === 'merged') item.merged = detail.commit;
    }
    item.status = state;
    item.history = history.map((event) => ({ kind: event.event_kind, by: event.event_by, at: event.event_at }));
    item.updatedAt = history.at(-1).event_at;
    item.verdicts = item.verdicts.slice(0, verdicts);
    item.verdict = item.verdicts.at(-1) ?? null;
    return [item];
  });
  const statuses = new Map(p.items.map((item) => [item.id, item.status]));
  for (const item of p.items) {
    const added = log.find((event) => event.item_id === item.id && event.event_kind === 'add');
    item.blockedBy = (JSON.parse(added.event_detail).after || []).filter((id) => statuses.get(id) !== 'verified');
  }
  // A milestone lists only this board's items added by now; another repo's stay as the export read them.
  p.milestones = (p.milestones || []).map((milestone) => ({ ...milestone, items: milestone.items.filter((entry) => typeof entry.id !== 'number' || statuses.has(entry.id)) }));
  const shouted = new Set(log.map((event) => JSON.parse(event.event_detail).shout).filter(Boolean));
  p.shouts = p.shouts.filter((shout) => shouted.has(shout.shout_id));
  p.decisions = p.decisions.filter((shout) => shouted.has(shout.shout_id));
  p.asked = p.asked.filter((shout) => shouted.has(shout.shout_id));
  const held = new Map();
  for (const event of log) {
    const detail = JSON.parse(event.event_detail);
    if (event.event_kind === 'hold') held.set(detail.lane, { hold_lane: detail.lane, hold_reason: detail.reason, hold_by: event.event_by, hold_at: event.event_at });
    if (event.event_kind === 'unhold') held.delete(detail.lane);
  }
  p.holds = [...held.values()].sort((a, b) => a.hold_lane.localeCompare(b.hold_lane));
  p.events = log.slice(-80).reverse();
  return p;
}

/** Draw a replay position without refreshing or changing the exported board. */
function replayPosition(index) {
  const r = snapshotReplay;
  r.index = index;
  view.root = r.final.root;
  view.state = 'all';
  data.root = view.root;
  data.group = null;
  data.project = replayProject(index);
  data.projects = data.projects.map((board) => board.root === view.root ? boardSummary(board, data.project) : board);
  render();
  replayControls();
}

/** Pause before clearing the next callback, so no event advances after the control returns. */
function pauseReplay() {
  snapshotReplay.playing = false;
  clearTimeout(snapshotReplay.timer);
  replayControls();
}

/** Play one event per speed-adjusted interval, stopping exactly at the exported final state. */
function advanceReplay() {
  const r = snapshotReplay;
  if (!r.playing) return;
  replayPosition(r.index + 1);
  if (r.index === r.events.length) return pauseReplay();
  r.timer = setTimeout(advanceReplay, 1000 / Number($('replay-speed').value));
}

/** Resume a paused replay, or restart at the first event when the snapshot is at the end. */
function playReplay() {
  const r = snapshotReplay;
  if (!r.final || !r.events.length || r.playing) return;
  if (r.index === r.events.length) replayPosition(0);
  r.playing = true;
  advanceReplay();
}

/**
 * The sidebar: every project, the one shown, and what needs the person elsewhere. A switch draws only
 * this until the new board arrives, so the main column never mixes the old board with the new pick.
 */
function renderSide() {
  /** Render a repo button or one muted recovery line when its board cannot be read. */
  const repoButton = (x) => {
    if (!x.ok) return '<p class="repo-error" role="status"><b>' + esc(x.name) + ':</b> ' + esc(x.error) + '</p>';
    const on = x.root === view.root;
    return '<button class="proj repo' + (on ? ' on' : '') + '"' + (on ? ' aria-current="true"' : '') + ' data-root="' + esc(x.root) + '" title="' + esc(x.root) + '" type="button"><span class="pname">' + esc(x.name) + '</span>' + (needCount(x) ? '<b class="need" title="needs you">' + needCount(x) + '</b>' : '') + '<small>' + esc(doing(x)) + '</small></button>';
  };
  const groupedRoots = new Set(data.groups.flatMap((group) => group.repos.map((repo) => repo.root)));
  const grouped = data.groups.map((group) => {
    const on = group.key === view.root;
    const needs = group.repos.reduce((total, repo) => total + needCount(repo), 0);
    const count = group.repos.length;
    return '<section class="repo-group"><button class="proj project-pick' + (on ? ' on' : '') + '"' + (on ? ' aria-current="true"' : '') + ' data-root="' + esc(group.key) + '" type="button"><span class="pname">' + esc(group.name) + '</span>' + (needs ? '<b class="need" title="needs you">' + needs + '</b>' : '') + '<small>' + count + ' ' + (count === 1 ? 'repo' : 'repos') + '</small></button><div class="repos">' + group.repos.map(repoButton).join('') + '</div></section>';
  }).join('');
  const loose = data.projects.filter((repo) => !repo.project && !groupedRoots.has(repo.root)).map(repoButton).join('');
  $('proj-list').innerHTML = grouped || loose ? grouped + loose : '<div class="empty">None yet.</div>';
  const currentGroup = data.groups.find((group) => group.key === view.root);
  const currentRoots = new Set(currentGroup ? currentGroup.repos.map((repo) => repo.root) : [view.root]);
  const elsewhere = data.projects.filter((x) => !currentRoots.has(x.root)).reduce((n, x) => n + needCount(x), 0);
  $('proj-elsewhere').textContent = elsewhere ? elsewhere + ' elsewhere' : '';
  $('proj-elsewhere').hidden = !elsewhere;
  const p = data.project;
  const selectedGroup = data.groups.find((group) => group.key === view.root);
  $('proj-name').textContent = selectedGroup?.name || (p ? (data.projects.find((x) => x.root === view.root) || { name: p.root.split('/').pop() }).name : 'No project');
  // The browser tab says it too, for when the view sits behind other tabs.
  const needs = data.projects.reduce((n, x) => n + needCount(x), 0);
  document.title = p || selectedGroup ? (needs ? '(' + needs + ') ' : '') + $('proj-name').textContent + ' · Pullboard' : 'Pullboard';
}

  /** Escape plain text while preserving safe item and code-preview links.
   * @param {string} text
   * @param {Map<string, string>} titles
   * @param {boolean} allowLinks
   * @returns {string}
   */
  function linked(text, titles, allowLinks = true) { return String(text ?? '').split(/(#\\d+|(?<![^\\s([{"'\`])[^\\s:@()[\\]{}"'\`]+:\\d+(?:-\\d+)?@[0-9a-f]{7,40}(?![^\\s)\\]}"'\`.,;:!?]))/).map((part, n, parts) => {
    if (n % 2 && part[0] !== '#') return allowLinks ? codeRef(part, parts.slice(0, n).join('').split('\\n').pop().slice(-2000)) : '<code class="inline">' + esc(part) + '</code>';
    const id = /^#\\d+$/.test(part) ? String(Number(part.slice(1))) : '';
    return titles.has(id) && allowLinks ? '<button class="ref" data-go="item:' + id + '" title="' + esc(titles.get(id)) + '" type="button">' + esc(part) + '</button>' : esc(part);
  }).join(''); }
  /** Format inline code and recognized command tokens without interpreting markup.
   * @param {string} text
   * @param {Map<string, string>} titles
   * @param {boolean} allowLinks
   * @returns {string}
   */
  function inline(text, titles, allowLinks = true) { return String(text ?? '').split(/(\`[^\`]*\`|[^\\s:@()[\\]{}"'\`]+:\\d+(?:-\\d+)?@[0-9a-f]{7,40}|pullboard(?:\\s+\\w+)+|--[\\w-]+|(?:\\/|\\.\\.?\\/|[\\w.-]+\\/)\\w[\\w./-]*\\.[A-Za-z0-9]+|\\b[0-9a-fA-F]{7,40}\\b|#\\d+)/g).map((part, n, parts) => {
    if (part.startsWith('\`') && part.endsWith('\`')) return '<code class="inline">' + esc(part.slice(1, -1)) + '</code>';
    if (part.includes('@') && part.includes(':')) {
      const textBefore = parts.slice(0, n).join('');
      const fullText = parts.join('');
      const after = fullText[textBefore.length + part.length] || '';
      const leftBoundary = !textBefore || [9, 10, 32, 40, 91, 123, 34, 39, 96].includes(textBefore.at(-1).charCodeAt(0));
      const rightBoundary = !after || [9, 10, 32, 41, 93, 125, 34, 39, 96, 46, 44, 59, 58, 33, 63].includes(after.charCodeAt(0));
      const validRef = leftBoundary && rightBoundary;
      if (allowLinks && validRef) return codeRef(part, textBefore.slice(-2000));
      return '<code class="inline">' + esc(part) + '</code>';
    }
    if (/^(?:pullboard(?:\\s+\\w+)+|--[\\w-]+|(?:\\/|\\.\\.?\\/|[\\w.-]+\\/)\\w[\\w./-]*\\.[A-Za-z0-9]+|\\b[0-9a-fA-F]{7,40}\\b)$/.test(part)) return '<code class="inline">' + esc(part) + '</code>';
    return linked(part, titles, allowLinks);
  }).join(''); }
  /** Render inline text and fenced or shell command blocks with escaped contents.
   * @param {string} text
   * @param {Map<string, string>} titles
   * @param {boolean} allowLinks
   * @returns {string}
   */
  function rich(text, titles, allowLinks = true) {
    const lines = String(text ?? '').split('\\n');
    const output = [];
    for (let i = 0; i < lines.length;) {
      if (lines[i].startsWith('\`\`\`')) {
        const block = [];
        i++;
        while (i < lines.length && !lines[i].startsWith('\`\`\`')) block.push(lines[i++]);
        if (i < lines.length) i++;
        output.push('<code class="code block">' + esc(block.join('\\n')) + '</code>');
      } else if (lines[i].startsWith('$ ')) {
        const block = [];
        while (i < lines.length && lines[i].startsWith('$ ')) block.push(lines[i++]);
        output.push('<code class="code block">' + esc(block.join('\\n')) + '</code>');
      } else {
        const block = [];
        while (i < lines.length && !lines[i].startsWith('\`\`\`') && !lines[i].startsWith('$ ')) block.push(inline(lines[i++], titles, allowLinks));
        output.push(block.join('<br>'));
      }
    }
    return output.join('<br>');
  }

/** Draw a project's cross-repo Needs-you list and one activity feed. */
function renderGroup(group) {
  const needs = group.repos.flatMap((repo) => projectNeeds(repo.board).map((row) => ({ ...row, repo })));
  $('group-needs').innerHTML = needs.length ? needs.map((row) => {
    const titles = new Map(row.repo.board.items.map((item) => [String(item.id), item.title]));
    const text = rich(row.text, titles).replaceAll('<button class="ref" data-go=', '<button class="ref" data-root="' + esc(row.repo.root) + '" data-go=');
    return '<div class="group-need"><b>' + esc(row.repo.name) + '</b><code>' + esc(row.ref) + '</code><span>' + text + '</span><button data-root="' + esc(row.repo.root) + '" type="button"><em>' + esc(row.what) + (row.at ? ', ' + age(row.at) : '') + ' →</em></button></div>';
  }).join('') : '<div class="empty">Nothing needs you across this project.</div>';
  const events = group.repos.flatMap((repo) => {
    const titles = new Map(repo.board.items.map((item) => [String(item.id), item.title]));
    return repo.board.events.map((event) => ({ ...event, repo, titles, title: event.item_id ? titles.get(String(event.item_id)) : null }));
  }).sort((a, b) => b.event_at.localeCompare(a.event_at)).slice(0, 80);
  $('group-activity').innerHTML = events.length ? byDay(events, (event) => event.event_at, (event) => '<div><time>' + clock(event.event_at) + '</time><div class="act"><b class="repo-label">' + esc(event.repo.name) + '</b> <span>' + esc(event.event_by) + ' ' + esc(event.event_kind) + (event.item_id ? ' #' + event.item_id + (event.title ? ' ' + rich(event.title, event.titles).replaceAll('<button class="ref" data-go=', '<button class="ref" data-root="' + esc(event.repo.root) + '" data-go=') : '') : '') + '</span></div></div>') : '<div class="empty">No activity yet.</div>';
}

/**
 * A milestone's item as the Items tab reads it (N26). This board's own come from its items, and
 * another repo's, written repo#id, from that repo's board when the view lists one by that name or
 * folder, as the roadmap resolves it: the same state, sent back included, and it opens there. An
 * item no listed board holds keeps the status the roadmap read for it, and opens nowhere.
 */
function milestoneItem(entry, p) {
  const local = typeof entry.id === 'number';
  const ref = local ? null : /^(.+)#([1-9]\\d*)$/.exec(String(entry.id));
  const named = ref ? data.projects.filter((x) => x.name === ref[1] || String(x.root).split('/').pop() === ref[1]) : [];
  const root = local ? view.root : named.length === 1 && named[0].ok ? named[0].root : null;
  const id = local ? entry.id : ref ? Number(ref[2]) : null;
  const item = (root === view.root ? p.items : root ? named[0].items : []).find((i) => i.id === id) || null;
  // A status the lifecycle declares; the roadmap says unavailable or missing for an item it could not read.
  const read = item || (FLOW.states.some((state) => state.id === entry.status) ? { status: entry.status, verdict: null } : null);
  return {
    label: local ? '#' + entry.id : String(entry.id),
    title: item ? item.title : read ? entry.title : '',
    root,
    titles: new Map((root === view.root ? p.items : root ? named[0].items : []).map((i) => [String(i.id), i.title])),
    state: read ? stateOf(read) : null,
    word: entry.status,
    open: item ? { root, id } : null,
    // Why an item does not open, short enough to read beside its id on a phone.
    why: item ? '' : local ? 'not on this board' : root ? 'not on that board' : snapshot ? 'not in this snapshot'
      : named.length > 1 ? 'board name not unique' : named.length ? 'board unreadable' : 'no such board',
  };
}

/**
 * One item's row on the Roadmap, laid out as the Items list lays one out: the dot of its state, its
 * id and title on one line that ends in an ellipsis when cut, and the Items tab's chip. The whole
 * title is the row's tooltip. An item that opens is a button; one that cannot says why instead.
 */
function milestoneRow(row, titles) {
  const title = row.title ? inline(String(row.title).replace(/\\s+/g, ' '), row.titles || titles).replaceAll('<button class="ref" data-go=', '<button class="ref" data-board="' + esc(row.root) + '" data-go=') : '<span class="muted">' + esc(row.why) + '</span>';
  const inner = '<span class="dot' + (row.state ? ' ' + row.state : '') + '"></span><span class="t"><span class="id">' + esc(row.label) + '</span>' + title + '</span>' + (row.state ? chip(row.state) : '<span class="chip">' + esc(row.word) + '</span>');
  if (!row.open) return '<li><div class="milestone-item" title="' + esc(row.title ? row.title + ' (' + row.why + ')' : row.why) + '">' + inner + '</div></li>';
  const attributes = 'class="milestone-item" data-go="item:' + row.open.id + '"' + (row.open.root === view.root ? '' : ' data-board="' + esc(row.open.root) + '"') + ' title="' + esc(row.title) + '"';
  // A title with its own links needs a separate containing control, never a nested button.
  return title.includes('class="ref"')
    ? '<li><div ' + attributes + ' role="button" tabindex="0">' + inner + '</div></li>'
    : '<li><button ' + attributes + ' type="button">' + inner + '</button></li>';
}

/**
 * The Roadmap (N26, N38): a card for each milestone in the board's order, with how many of its
 * items are verified as a count and a bar, a row for each, and the note to the person in its own
 * highlighted line. A milestone with no items says so, rather than draw an empty bar.
 */
function roadmapCards(p, titles) {
  const milestones = p.milestones || [];
  if (!milestones.length) return '<div class="card-panel empty">No milestones yet. The coordinator adds one with <code class="inline">pullboard milestone add</code>.</div>';
  return milestones.map((milestone) => {
    const rows = milestone.items.map((entry) => milestoneItem(entry, p));
    const done = rows.filter((row) => row.state === 'verified').length;
    const name = esc(milestone.name);
    return '<article class="card-panel milestone"><header><h2>' + linked(milestone.name, titles) + '</h2>' + (rows.length ? '<span class="milestone-count">' + done + '/' + rows.length + ' done</span>' : '') + '</header>'
      + (rows.length
        ? '<svg class="milestone-progress" viewBox="0 0 100 1" preserveAspectRatio="none" role="progressbar" aria-label="' + name + ': ' + done + ' of ' + rows.length + ' done" aria-valuemin="0" aria-valuemax="' + rows.length + '" aria-valuenow="' + done + '"><rect width="' + Math.round((100 * done) / rows.length) + '" height="1"/></svg><ul>' + rows.map((row) => milestoneRow(row, titles)).join('') + '</ul>'
        : '<p class="milestone-empty">No items yet.</p>')
      + (milestone.note ? '<p class="milestone-note">' + rich(milestone.note, titles) + '</p>' : '') + '</article>';
  }).join('');
}

/** Draw the board shown: the sidebar, then every tab's panes from the project's board. */
function render() {
  const p = data.project;
  const group = data.group;
  renderSide();
  if (view.answering && view.answering.root !== view.root) answer(null);
  // Until the first board arrives the page shows no tabs or panes, so a machine with none never
  // flashes them; with no board to show, one message says how a board starts, in their place.
  document.body.classList.remove('loading');
  document.body.classList.toggle('boardless', !p && !group);
  $('group-view').hidden = !group;
  $('tabs').hidden = Boolean(group);
  document.querySelectorAll('[data-pane]').forEach((pane) => { pane.hidden = Boolean(group) || pane.dataset.pane !== view.tab; });
  $('products').hidden = !p || !p.products.length;
  renderPersonRequests(p);
  if (group) { renderGroup(group); return; }
  if (!p) return;
  // Each product's progress (N28): the rows an accepted item cites, and its items by state.
  $('prod-list').innerHTML = p.products.map((x) => {
    const states = [['open', '', x.items.open], ['building', 'building', x.items.claimed], ['to verify', 'verify', x.items.submitted], ['verified', 'verified', x.items.verified]].filter(([, , n]) => n);
    return '<div class="prod" title="' + x.rows + ' rows in force, ' + x.approved + ' approved, ' + x.proven + ' cited by accepted items"><p><b>' + esc(x.name) + '</b><span>' + x.proven + '/' + x.rows + ' rows met</span></p><svg class="bar" viewBox="0 0 100 1" preserveAspectRatio="none" aria-hidden="true"><rect width="' + (x.rows ? Math.round((100 * x.proven) / x.rows) : 0) + '" height="1"/></svg>'
      + (states.length ? '<small>' + states.map(([label, dot, n]) => '<span><i class="dot ' + dot + '"></i>' + n + ' ' + label + '</span>').join('') + '</small>' : '') + '</div>';
  }).join('');
  const items = p.items.filter((i) => i.status !== 'withdrawn');
  const active = items.filter((i) => stateOf(i) !== 'verified');
  $('count-items').textContent = active.length || '';
  $('count-spec').textContent = p.spec.filter((r) => ['pending', 'draft'].includes(r.status) && !r.decision).length || '';
  $('count-doctrine').textContent = p.practice.filter((r) => ['pending', 'draft'].includes(r.status)).length || '';
  const titles = new Map(p.items.map((i) => [String(i.id), i.title]));
  $('roadmap').innerHTML = roadmapCards(p, titles);

  // What needs the person, first, and only the person's calls (B26): the decisions passed up to them,
  // questions in the spec, held lanes, then draft rows. Work waiting for a verdict or sent back shows
  // on the board with who holds it; it is the agents' to move.
  const needs = [
    ...p.decisions.map((d) => ['decide:' + d.shout_id, d.shout_from, d.shout_text, 'decide', d.shout_at]),
    ...p.spec.filter((r) => r.status === 'pending' && !r.decision).map((r) => ['spec:' + r.id, r.id, r.text, 'answer in SPEC.md']),
    ...p.holds.map((h) => ['tab:shouts', h.hold_lane, h.hold_reason, 'lane held by ' + h.hold_by]),
  ];
  const drafts = p.spec.filter((r) => r.status === 'draft' && !r.decision).length;
  $('needs').hidden = !needs.length && !drafts;
  $('needs').innerHTML = '<div class="head"><i></i>Needs you</div>' + needs.slice(0, 6).map(([target, ref, text, what, at]) => '<div class="ny"><code>' + esc(ref) + '</code><span class="ny-text">' + rich(text, titles) + '</span><button class="ny-open" data-go="' + esc(target) + '" type="button"><em>' + esc(what) + (at ? ', ' + age(at) : '') + ' →</em></button></div>').join('') + (needs.length > 6 ? '<div class="muted more">and ' + (needs.length - 6) + ' more</div>' : '') + (drafts ? '<div class="ny"><code>' + drafts + '</code><span class="ny-text">draft spec rows to approve or drop</span><button class="ny-open" data-go="tab:spec" type="button"><em>review →</em></button></div>' : '');

  const lanes = p.lanes;
  const working = lanes.filter((l) => l !== 'coordinator');
  // New work goes first to a lane that owns folders, where builders work, then to the coordinator; a
  // lane that owns none, such as review, is for verifiers and comes last.
  const filing = [...working.filter((l) => p.owning.includes(l)), 'coordinator', ...working.filter((l) => !p.owning.includes(l))];
  if ($('add-lane').dataset.lanes !== filing.join()) {
    $('add-lane').dataset.lanes = filing.join();
    $('add-lane').innerHTML = filing.map((l) => '<option>' + esc(l) + '</option>').join('');
    $('hold-lane').innerHTML = working.map((l) => '<option>' + esc(l) + '</option>').join('');
  }
  const approved = p.spec.filter((r) => r.status === 'approved');
  $('add-specs').placeholder = (approved.length ? approved : p.spec).slice(0, 2).map((r) => r.id).join(',') || 'none yet';
  const q = $('q').value.trim().toLowerCase();
  // Each chip counts what it would show under the lane and the search. A search looks through every
  // state, withdrawn items included; browsing leaves those out.
  const matching = (q ? p.items : items)
    .filter((i) => !q || ('#' + i.id + ' ' + i.title + ' ' + i.lane + ' ' + i.specs.join(' ') + ' ' + (i.criterion || '')).toLowerCase().includes(q));
  const inState = (s) => (i) => s === 'all' || (s === 'active' ? !['verified', 'withdrawn'].includes(stateOf(i)) : stateOf(i) === s);
  const names = { active: 'Active', verified: 'Verified', all: 'All' };
  $('state-chips').innerHTML = Object.keys(names).map((s) => '<button data-state="' + s + '" class="' + (view.state === s ? 'on' : '') + '" type="button">' + names[s] + '<b>' + matching.filter(inState(s)).length + '</b></button>').join('');
  const shown = matching.filter(inState(view.state)).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  // With nothing picked, the detail shows the first row, and keeps it when a refresh reorders the list.
  // While another project loads, the item picked there waits for its own board.
  if (data.root === view.root && !view.adding && !p.items.some((i) => i.id === view.item)) view.item = shown.length ? shown[0].id : null;
  const heldLanes = new Map(p.holds.map((h) => [h.hold_lane, h]));
  $('chain').innerHTML = shown.length ? shown.map((i) => {
    const s = stateOf(i);
    const who = s === 'building' ? i.owner : [i.builtBy, i.verifiedBy].filter(Boolean).join(' → ');
    // What an open item waits on, if anything: items not yet verified, or a hold on its lane.
    const hold = s === 'open' ? heldLanes.get(i.lane) : null;
    const waits = s === 'open' && i.blockedBy.length ? i.blockedBy : [];
    const gated = waits.length > 0 || !!hold;
    const pills = (waits.length ? '<span class="gate">' + waits.map((id, index) => '<span class="wait-unit">' + (index ? '' : 'waits on ') + '<button class="ref" data-go="item:' + id + '" type="button">#' + id + '</button></span>').join(', ') + '</span>' : '') + (hold ? '<span class="gate">lane held: ' + linked(hold.hold_reason, titles) + '</span>' : '');
    const tag = s === 'building' && i.owner ? '<span class="chip busy" title="building, held by ' + esc(i.owner) + '">' + esc(i.owner) + '</span>'
      : s === 'verify' && i.reviewer ? '<span class="chip warn" title="reviewing until ' + esc(when(i.reviewUntil)) + '">' + esc(i.reviewer) + ' reviewing</span>'
      : s === 'open' ? (gated ? '<span class="chip gate">' + (waits.length ? 'gated' : 'lane held') + '</span>' : '<span class="chip free">unclaimed</span>') : chip(s);
    return '<li class="row' + (view.item === i.id ? ' on' : '') + (gated ? ' gated' : '') + '" data-item="' + i.id + '"><span class="dot ' + s + '"></span><div><div class="t"><span>#' + i.id + '</span>' + rich(i.title, titles) + '</div><div class="meta"><span>' + esc(i.lane) + '</span>' + (i.specs.length ? '<span>' + esc(i.specs.join(', ')) + '</span>' : '') + (who ? '<span>' + esc(who) + '</span>' : '') + pills + '<span>' + age(i.updatedAt) + '</span>' + (rejected(i) ? '<span class="why">' + linked(i.verdict.reason + ': ' + firstLine(i.verdict.note), titles) + '</span>' : '') + '</div></div>' + tag + '</li>';
  }).join('') : '<li class="empty">' + (items.length ? 'No items match.' : snapshot ? 'No items at this event.' : 'No items yet. Add the first one with New item.') + '</li>';

  const item = p.items.find((i) => i.id === view.item);
  // The form shows when asked for, or when the project has no item at all, withdrawn ones included.
  const adding = view.adding || !p.items.length;
  $('add-form').hidden = !adding;
  $('add-cancel').hidden = !p.items.length;
  $('detail').hidden = adding;
  if (!item) $('detail').innerHTML = '<div class="empty">Pick an item to see its criterion, verdicts and history.</div>';
  if (item && !view.adding) {
    const s = stateOf(item);
    const cited = item.specs.map((id) => p.spec.find((r) => r.id === id) || { id, status: 'missing', text: '(not in SPEC.md)' });
    // Why it came back is the first thing the person reads; the verdicts before it stay below.
    const back = rejected(item);
    const earlier = back ? item.verdicts.slice(0, -1) : item.verdicts;
    $('detail').innerHTML = '<div class="stack"><div><h2><span>#' + item.id + '</span>' + rich(item.title, titles) + '</h2><div class="meta spaced">' + chip(s) + '<span class="chip">' + esc(item.lane) + '</span><span class="chip">' + esc(item.route) + '</span></div></div>'
      + (back ? '<div class="sentback"><h3>Sent back' + (s === 'building' ? ', being reworked' : s === 'verify' ? ', resubmitted' : s === 'withdrawn' ? ', then withdrawn' : '') + '</h3>' + verdictHtml(item.verdict, titles) + '</div>' : '')
      + (item.criterion ? '<div><h3>Criterion</h3><div class="text">' + rich(item.criterion, titles) + '</div></div>' : '')
      + (cited.length ? '<div><h3>Spec rows it serves</h3>' + cited.map((r) => '<div class="rowref"><code>' + esc(r.id) + '</code><div>' + linked(r.text, titles) + ' <span class="chip ' + tone(r.status) + '">' + esc(r.status) + '</span></div></div>').join('') + '</div>' : '')
      + (item.brief ? '<div><h3>Brief</h3><div class="text muted">' + rich(item.brief, titles) + '</div></div>' : '')
      + '<div><h3>People and commits</h3><dl class="kv">' + (item.owner && s === 'building' ? '<dt>holding</dt><dd>' + esc(item.owner) + '</dd>' : '') + (item.builtBy ? '<dt>built by</dt><dd>' + esc(item.builtBy) + '</dd>' : '') + (item.verifiedBy ? '<dt>verified by</dt><dd>' + esc(item.verifiedBy) + '</dd>' : '') + (item.commit ? '<dt>commit</dt><dd><code>' + esc(item.commit.slice(0, 12)) + '</code></dd>' : '') + (item.merged ? '<dt>merged</dt><dd><code>' + esc(item.merged.slice(0, 12)) + '</code></dd>' : '') + (item.blockedBy.length ? '<dt>waits on</dt><dd class="waits-on">' + item.blockedBy.map((id) => '<span class="wait-unit"><button class="ref" data-go="item:' + id + '" type="button">#' + id + '</button></span>').join(', ') + '</dd>' : '') + '</dl></div>'
      + (back && !earlier.length ? '' : '<div><h3>' + (back ? 'Earlier verdicts' : 'Verdicts') + '</h3>' + (earlier.length ? earlier.map((v) => verdictHtml(v, titles)).join('') : '<div class="muted">None yet.</div>') + '</div>')
      + '<div><h3>History</h3>' + timeline(item) + '</div>'
      + '<div class="links"><button data-shout="' + esc(item.lane) + '" data-about="' + item.id + '" type="button">Shout the ' + esc(item.lane) + ' lane about #' + item.id + '</button><button data-new type="button">New item</button></div></div>';
  }

  // Every #id in a shout that names an item opens it, whatever stands next to it. The ids are found in
  // the raw text and each piece is escaped on its own, so an apostrophe's &#39; is never read as one;
  // a number that names no item stays text. A path:lines@commit reference opens that code (B23). It
  // counts only as a whole word, never as the tail of one, so what it opens is what it says, and the
  // view refuses what is no path in the repo.
  const mark = (x) => (x.shout_decision ? '<span class="mark ask">decision</span> ' : x.shout_answers ? '<span class="mark">answer</span> ' : '');
  // Evidence a shout carries (B22), as the fields it is: its kind and outcome, the item, who sent it,
  // and the commit, shortened, with the full SHA on hover.
  const evidence = (x) => (x.shout_evidence_kind ? '<span class="ev"><b>' + esc(x.shout_evidence_kind) + '</b> ' + esc(x.shout_evidence_outcome) + ' · ' + linked('#' + x.shout_evidence_item, titles) + ' · ' + esc(x.shout_from) + ' · <code title="' + esc(x.shout_evidence_commit) + '">' + esc(String(x.shout_evidence_commit).slice(0, 12)) + '</code></span>' : '');
  $('feed').innerHTML = p.shouts.length ? byDay(p.shouts, (x) => x.shout_at, (x) => '<div><time>' + clock(x.shout_at) + '</time><div><b>' + esc(x.shout_from) + ' → ' + esc(x.shout_to) + '</b> ' + mark(x) + rich(x.shout_text, titles) + evidence(x) + '</div></div>') : '<div class="empty">No shouts yet.</div>';
  // Each ask waits here until it is answered (B21); the answer itself is typed in the form below. The
  // person answers the ones passed up to them; the rest wait on whoever holds them (B26).
  $('decisions').hidden = !p.decisions.length && !p.asked.length;
  $('decisions').innerHTML = (p.decisions.length ? '<div class="head"><i></i>Decision needed</div>' + p.decisions.map((d) => '<div class="ask"><p><small><b>' + esc(d.shout_from) + '</b> asks, ' + age(d.shout_at) + '</small></p><p>' + rich(d.shout_text, titles) + '</p><button class="ghost" data-go="decide:' + d.shout_id + '" type="button">Answer</button></div>').join('') : '')
    + (p.asked.length ? '<div class="head quiet">Waiting on others</div>' + p.asked.map((d) => '<div class="ask other"><p><small><b>' + esc(d.shout_from) + '</b> asks <b>' + esc(d.shout_to) + '</b>, ' + age(d.shout_at) + '</small></p><p>' + rich(d.shout_text, titles) + '</p></div>').join('') : '');
  $('shout-targets').innerHTML = ['all', ...lanes, ...p.agents.map((a) => a.agent_id)].map((t) => '<option value="' + esc(t) + '">').join('');
  // Each agent with what it holds: its claim, then its work sent back, then its work waiting for a
  // verdict. The worktree path is there on hover; what the person reads is who is doing what.
  // A review an agent holds (V15) comes right after its claim.
  const rank = (a, i) => i.status === 'claimed' ? 0 : i.reviewer === a.agent_id ? 1 : stateOf(i) === 'back' ? 2 : 3;
  const holding = (a) => items.filter((i) => i.status === 'claimed' ? i.owner === a.agent_id : i.reviewer === a.agent_id || (i.builtBy === a.agent_id && ['back', 'verify'].includes(stateOf(i)))).sort((x, y) => rank(a, x) - rank(a, y));
  $('agents').innerHTML = p.agents.length ? p.agents.map((a) => {
    const mine = holding(a);
    return '<div class="agent"><div><b title="' + esc(a.agent_path) + '">' + esc(a.agent_id) + '</b><span class="muted">' + esc(a.agent_lane) + ' · ' + esc(a.agent_route) + '</span>' + (a.lastMoveAt ? '<time data-ago="' + esc(a.lastMoveAt) + '" title="last moved ' + when(a.lastMoveAt) + '">' + ago(a.lastMoveAt) + '</time>' : '') + '</div>'
      + (mine.length ? mine.map((i) => '<div class="agent-work" data-item="' + i.id + '"><span>#' + i.id + ' ' + rich(i.title, titles) + '</span>' + (i.reviewer === a.agent_id ? '<span class="chip warn">reviewing</span>' : chip(stateOf(i))) + '</div>').join('') : '<small>idle</small>') + '</div>';
  }).join('') : '<div class="empty">No agents yet.</div>';
  const held = new Map(p.holds.map((h) => [h.hold_lane, h]));
  $('lanes').innerHTML = working.map((l) => '<div class="lane"><span><b>' + esc(l) + '</b> ' + (held.has(l) ? '<span class="chip no">held by ' + esc(held.get(l).hold_by) + '</span> <span class="muted">' + linked(held.get(l).hold_reason, titles) + '</span>' : '<span class="chip ok">open</span>') + '</span>' + (held.has(l) ? '<button class="ghost" data-release="' + esc(l) + '" type="button">Release</button>' : '') + '</div>').join('');

  for (const kind of ['spec', 'doctrine']) {
    const rows = kind === 'spec' ? p.spec : p.practice;
    const filter = view.rows[kind];
    const labels = { decide: 'Needs your decision', all: 'All rows', approved: 'Approved' };
    /** A source row stays in Needs your decision until its person decision is recorded. */
    const undecided = (r) => ['pending', 'draft'].includes(r.status) && !r.decision;
    const n = { decide: rows.filter(undecided).length, all: rows.length, approved: rows.filter((r) => r.status === 'approved').length };
    $(kind + '-chips').innerHTML = Object.keys(labels).map((f) => '<button data-rows="' + kind + ':' + f + '" class="' + (filter === f ? 'on' : '') + '" type="button">' + labels[f] + '<b>' + n[f] + '</b></button>').join('');
    const shownRows = rows.filter((r) => filter === 'all' || (filter === 'decide' ? undecided(r) : r.status === 'approved'));
    const feedback = kind === 'spec' && view.specFeedback?.root === view.root && view.specFeedback.from === 'list' ? view.specFeedback : null;
    const feedbackId = feedback && (shownRows.some((r) => r.id === feedback.id) ? feedback.id : shownRows.some((r) => r.id === feedback.next) ? feedback.next : shownRows[0]?.id);
    let section = null;
    $(kind + '-list').innerHTML = shownRows.length ? shownRows.map((r) => {
      const sectionRows = !snapshot && (!readOnly || requests) && kind === 'spec' && r.section !== section ? rows.filter((entry) => entry.section === r.section && undecided(entry)) : [];
      const head = r.section !== section ? '<div class="spec-section-head"><h4>' + esc(r.section) + '</h4>' + (sectionRows.length ? '<button class="spec-section-approve" data-section-approve="' + esc(r.section) + '" type="button">Approve all ' + sectionRows.length + ' in this section</button>' : '') + '</div>' : '';
      section = r.section;
      const declined = kind === 'doctrine' && r.status === 'wont';
      const text = declined ? '<s>' + linked(r.standardText || r.text, titles) + '</s>' : linked(r.text, titles);
      const reason = declined && r.reason ? '<small class="rule-reason">Reason: ' + linked(r.reason, titles) + '</small>' : '';
      const source = kind === 'doctrine' ? '<small class="rule-source">' + esc(ruleSource(r)) + '</small>' : '';
      const status = r.stage || r.status;
      /** Render person-only row decisions in both the list and its detail pane. */
      const decisionActions = (!snapshot && (!readOnly || requests) && kind === 'spec' && undecided(r))
        ? '<div class="spec-decision-actions"><button class="approve-row" data-row-decision="approve" data-row-id="' + esc(r.id) + '" type="button">Approve</button><button class="decline-row" data-row-decision="decline" data-row-id="' + esc(r.id) + '" type="button">Decline</button></div>'
        : '';
      return head + (feedback && feedbackId === r.id ? specFeedback(feedback) : '') + '<div class="srow' + (view.row[kind] === r.id ? ' on' : '') + '" data-row="' + kind + ':' + esc(r.id) + '"><code>' + esc(r.id) + '</code><span><span class="chip ' + tone(r.status) + '">' + esc(status) + '</span>' + source + '</span><span>' + text + reason + decisionActions + '</span></div>';
    }).join('') : '<div class="empty">' + (rows.length ? 'No rows match.' : kind === 'spec' ? 'No spec rows yet. Each requirement is one row in SPEC.md, such as G1 [draft, must] and a line; write them, or ask an agent to, and they show up here.' : 'No doctrine rows yet: they live in DOCTRINE.md.') + '</div>';
    if (feedback && !shownRows.length) $(kind + '-list').innerHTML += specFeedback(feedback);
    const row = rows.find((r) => r.id === view.row[kind]);
    const citing = row ? p.items.filter((i) => i.specs.includes(row.id)) : [];
    const declined = kind === 'doctrine' && row && row.status === 'wont';
    const text = row ? declined ? '<s>' + linked(row.standardText || row.text, titles) + '</s>' : linked(row.text, titles) : '';
    const source = kind === 'doctrine' && row ? '<span class="chip">' + esc(ruleSource(row)) + '</span>' : '';
    const reason = declined && row.reason ? '<dt>reason</dt><dd>' + linked(row.reason, titles) + '</dd>' : '';
    const home = kind === 'doctrine' && row && row.origin === 'standard' ? 'Standard rules come with Pullboard; override or decline one in DOCTRINE.md.' : 'Rows change in ' + (kind === 'spec' ? 'SPEC.md' : 'DOCTRINE.md') + ', and only you approve them.';
    const rowStatus = row?.stage || row?.status;
    const rowDecisionActions = !snapshot && (!readOnly || requests) && row && kind === 'spec' && undecided(row)
      ? '<div class="spec-decision-actions detail-decision-actions"><button class="approve-row" data-row-decision="approve" data-row-id="' + esc(row.id) + '" type="button">Approve</button><button class="decline-row" data-row-decision="decline" data-row-id="' + esc(row.id) + '" type="button">Decline</button></div>'
      : '';
    $(kind + '-detail').innerHTML = row ? '<div class="stack tight"><h2><span>' + esc(row.id) + '</span>' + text + '</h2><div class="meta"><span class="chip ' + tone(row.status) + '">' + esc(rowStatus) + '</span>' + (row.tier ? '<span class="chip">' + esc(row.tier) + '</span>' : '') + source + '</div>' + rowDecisionActions + (kind === 'spec' && view.specFeedback?.root === view.root && view.specFeedback.from === 'detail' && view.specFeedback.id === row.id ? specFeedback(view.specFeedback) : '') + '<dl class="kv"><dt>section</dt><dd>' + esc(row.section) + '</dd>' + reason + (row.gate ? '<dt>gate</dt><dd>' + esc(row.gate) + '</dd>' : '') + (row.serves && row.serves.length ? '<dt>serves</dt><dd>' + esc(row.serves.join(', ')) + '</dd>' : '') + '</dl><div><h3>Items that cite it</h3>' + (citing.length ? '<div class="links">' + citing.map((i) => '<div class="links-item" data-item="' + i.id + '"><span>#' + i.id + ' ' + rich(i.title, titles) + '</span></div>').join('') + '</div>' : '<div class="muted">None yet.</div>') + '</div><div class="muted">' + home + '</div></div>' : '<div class="empty">Pick a row to see it, and the items that cite it.</div>';
  }

  if (keep('pb.flow') !== 'hidden') $('flow').innerHTML = flowSvg(p);
  $('activity').innerHTML = p.events.length ? byDay(p.events, (e) => e.event_at, (e) => '<div><time>' + clock(e.event_at) + '</time><div class="act"><b>' + esc(e.event_by) + '</b> ' + esc(e.event_kind) + (e.item_id ? ' <button class="ref" data-go="item:' + e.item_id + '" type="button">#' + e.item_id + '</button>' + (titles.has(String(e.item_id)) ? ' <span class="what">' + rich(titles.get(String(e.item_id)), titles) + '</span>' : '') : '') + '</div></div>') : '<div class="empty">No activity yet.</div>';
  showTab();
}

/**
 * Show or hide the lifecycle on Activity, and keep the choice: a person who closed it has learned
 * it, so it stays closed across reloads, and across restarts of the view, which serves from the
 * same address again, until they open it. While hidden it is not drawn.
 */
function showFlow(shown) {
  keep('pb.flow', shown ? 'shown' : 'hidden');
  $('flow-panel').hidden = !shown;
  $('flow-show').hidden = shown;
  if (shown && data && data.project) $('flow').innerHTML = flowSvg(data.project);
}

function showTab() {
  document.querySelectorAll('[data-pane]').forEach((pane) => { pane.hidden = pane.dataset.pane !== view.tab; });
  document.querySelectorAll('.tab').forEach((button) => button.classList.toggle('on', button.dataset.tab === view.tab));
  countUnseen();
}

/** The address that names a tab: the Roadmap's own, or the board's, keeping the rest as it is. */
function tabHref(tab) {
  const own = tab === 'roadmap';
  return routed ? (own ? '/roadmap' : '/') + location.search : location.pathname + location.search + (own ? '#roadmap' : '');
}

/**
 * Keep the address naming what the page shows (N38). Moving between the Roadmap and another tab
 * changes it and adds a history entry, so Back and Forward return there; anything else, or push
 * false, only updates the entry. Each entry carries its project and item too, so returning to one
 * shows that board as it was. A host that refuses the change still shows the tab.
 */
function address(push = true) {
  if (typeof history === 'undefined' || typeof location === 'undefined') return;
  const state = { tab: view.tab, root: view.root, item: view.item };
  const href = tabHref(view.tab);
  try {
    if (push && href !== location.pathname + location.search + (routed ? '' : location.hash)) history.pushState(state, '', href);
    else history.replaceState(state, '');
  } catch { /* The tab shows all the same. */ }
}

/**
 * Show what a history entry names, on Back, Forward or an edited #roadmap: the tab its address
 * names, or at the board's address the tab the entry kept, and the project and item it kept.
 */
function fromAddress(event) {
  const kept = (event && event.state) || {};
  view.tab = addressTab() || (kept.tab && kept.tab !== 'roadmap' ? kept.tab : homeTab());
  if (view.tab !== 'roadmap') keep('pb.tab', view.tab);
  const item = typeof kept.item === 'number' ? kept.item : null;
  if (kept.root && kept.root !== view.root && data && data.projects.some((x) => x.ok && x.root === kept.root)) return switchTo(kept.root, item, false);
  if (item !== null && view.tab === 'items') view.item = item;
  address(false);
  if (data) render();
  else showTab();
}

/** Pick a tab. The board's address keeps it for next time; the Roadmap has an address of its own. */
function openTab(tab) {
  view.tab = tab;
  if (tab !== 'roadmap') keep('pb.tab', tab);
  address();
}

/**
 * Count on the Shouts tab the shouts that came after the newest one the person has seen in this
 * project. Seeing means having the Shouts tab open with the board drawn; a project shown for the
 * first time has seen everything so far. The mark is kept in this browser, so a reload counts
 * nothing old. The board counts the shouts since the mark the last refresh sent, so a burst larger
 * than the forty loaded still counts in full; until a moved mark reaches the board, the loaded
 * shouts count, which is exact then since the mark only ever moves to the newest.
 */
function countUnseen() {
  const p = data && data.project;
  // While a switch loads, the board on hand is the last project's: it marks nothing for this one.
  if (!p || data.root !== view.root) return;
  const key = 'pb.seen.' + view.root;
  const kept = view.seen[key] ?? keep(key);
  const newest = p.shouts.length ? p.shouts[0].shout_id : 0;
  const seen = view.tab === 'shouts' || kept === null || kept === undefined ? newest : Number(kept);
  if (String(seen) !== String(kept)) { view.seen[key] = seen; keep(key, String(seen)); }
  $('count-shouts').textContent = (p.unseen && p.unseen.since === seen ? p.unseen.count : p.shouts.filter((x) => x.shout_id > seen).length) || '';
}

/**
 * Put the shout form in answer mode for an open decision (B21), or back to a plain shout with null.
 * The form is never redrawn, so what the person types survives every refresh; only its answer line,
 * its To and its button change. The To the person had comes back when the answer is done. An answer
 * belongs to the project whose question it shows: leaving that project leaves answer mode.
 */
function answer(id) {
  const ask = id === null ? null : data.project.decisions.find((d) => d.shout_id === id) || null;
  if (ask && !view.answering) view.to = $('shout-to').value;
  if (!ask && view.answering) $('shout-to').value = view.to || '';
  view.answering = ask ? { root: view.root, id: ask.shout_id } : null;
  $('answering').hidden = !ask;
  $('answering-who').textContent = ask ? ask.shout_from : '';
  const question = ask ? linked(ask.shout_text, new Map(data.project.items.map((i) => [String(i.id), i.title]))) : '';
  if (question.includes('<button class="ref"')) $('answering-q').innerHTML = question;
  else $('answering-q').textContent = ask ? ask.shout_text : '';
  if (ask) $('shout-to').value = ask.shout_from;
  $('shout-to').disabled = Boolean(ask);
  $('shout-send').textContent = ask ? 'Answer' : 'Shout';
  if (ask) $('shout-text').focus();
}

/**
 * Follow a link in the page: an item, a spec row, a tab or a decision to answer. An item can live on
 * another project's board, root, which the page then switches to.
 */
function go(target, root = view.root) {
  const [kind, id] = target.split(':');
  let tab = view.tab;
  if (kind === 'item') { tab = 'items'; view.state = 'all'; view.before = null; }
  else if (kind === 'spec') { tab = 'spec'; view.row.spec = id; view.rows.spec = 'all'; }
  else if (kind === 'tab') tab = id;
  else if (kind === 'decide') { tab = 'shouts'; answer(Number(id)); }
  openTab(tab);
  if (kind === 'item') pick(Number(id), root);
  else render();
}

/** Show an item's detail, on another project's board when root names one. */
function pick(id, root = view.root) {
  view.adding = false;
  if (root !== view.root) return switchTo(root, id);
  view.item = id;
  address(false);
  render();
  reveal();
}

/** Where the list and the detail stack (under 900px), bring the detail into view. */
function reveal() {
  if (matchMedia('(max-width: 900px)').matches) $('detail').scrollIntoView({ block: 'start', behavior: 'smooth' });
}

/**
 * A search looks through every state. Each keystroke with text in the box selects All, even after a
 * chip was clicked mid-search; emptying the box brings back the chip from before the search began.
 */
function search() {
  if ($('q').value.trim()) {
    if (view.before == null) view.before = view.state;
    view.state = 'all';
  } else if (view.before != null) {
    view.state = view.before;
    view.before = null;
  }
  render();
}

/**
 * Open or close the code a path:lines@commit reference names (B23). The first open asks the view for
 * those lines as they were at that commit; the answer stays with the page, so every refresh redraws
 * it, and a failed ask is tried again on the next open.
 */
async function code(ref, before) {
  const c = (view.code[view.root + '\\n' + before + '\\n' + ref] ??= { open: false });
  c.open = !c.open;
  render();
  if (!c.open || c.lines) return;
  c.error = null;
  try {
    const reply = await api(boardPath(view.root) + '/code?ref=' + encodeURIComponent(ref) + '&before=' + encodeURIComponent(before));
    Object.assign(c, reply.code);
  } catch (error) {
    c.error = String(error.message || error);
  }
  render();
}

/** Translate person actions into their public literal intent and a familiar command label. */
function pageMove(command, args = {}) {
  /** Trim form values before constructing the move and its display label. */
  const text = (value) => String(value || '').trim();
  if (command === 'add') {
    const fields = { lane: text(args.lane), title: text(args.title) };
    const label = ['add', fields.lane, fields.title];
    for (const name of ['criterion', 'specs', 'brief']) if (text(args[name])) { fields[name] = text(args[name]); label.push('--' + name, fields[name]); }
    return { body: { verb: 'add', args: fields }, label: label.join(' ') };
  }
  if (command === 'shout') return { body: { verb: 'shout', args: { to: text(args.to), text: text(args.text) } }, label: ['shout', text(args.to), text(args.text)].join(' ') };
  if (command === 'answer') return { body: { verb: 'answer', item: Number(args.id), args: { text: text(args.text), as: 'person' } }, label: ['answer', text(args.id), text(args.text), '--as', 'person'].join(' ') };
  if (command === 'hold') return { body: { verb: 'hold', args: { lane: text(args.lane), reason: text(args.reason) } }, label: ['hold', text(args.lane), '--reason', text(args.reason)].join(' ') };
  if (command === 'release') return { body: { verb: 'hold', args: { lane: text(args.lane), off: true } }, label: ['hold', text(args.lane), '--off'].join(' ') };
  if (command === 'spec-approve') {
    const ids = text(args.ids);
    if (!ids) throw new Error('Choose at least one spec row to approve.');
    return { body: { verb: 'spec-approve', args: { ids } }, label: 'spec approve ' + ids };
  }
  if (command === 'spec-decline') {
    const ids = text(args.ids), reason = text(args.reason);
    if (!ids || !reason) throw new Error('Choose a spec row and enter a reason to decline it.');
    return { body: { verb: 'spec-decline', args: { ids, reason } }, label: 'spec decline ' + ids + ' --reason ' + reason };
  }
  throw new Error('No view action ' + String(command) + '; choose add, shout, answer, hold or release.');
}

/** Describe an API-confirmed move without exposing its transport document in the page. */
function moveMessage(move, result) {
  if (move.verb === 'add') return 'added #' + result.item.item_id;
  if (move.verb === 'shout') return 'shouted to ' + move.args.to;
  if (move.verb === 'answer') return 'answered #' + move.item;
  if (move.verb === 'spec-approve') return 'approved rows ' + move.args.ids + ' (pending apply)';
  if (move.verb === 'spec-decline') return 'declined rows ' + move.args.ids + ' (pending apply)';
  return move.args.off ? 'released the ' + move.args.lane + ' lane' : 'holding the ' + move.args.lane + ' lane: ' + move.args.reason;
}

/** Render escaped decision feedback beside the affected Spec row (B26, N26). */
function specFeedback(feedback) {
  return '<div class="spec-feedback ' + feedback.tone + '" role="status">' + esc(feedback.text) + '</div>';
}

/** Record a Spec decision beside its row and retain the list's reading position (B26, N26). */
async function decideSpec(command, args, anchor) {
  if (snapshot || (readOnly && !requests)) return false;
  const root = view.root, scroll = window.scrollY;
  const ids = String(args.ids).split(/\s+/);
  const rows = [...$('spec-list').querySelectorAll('[data-row]')];
  const index = rows.findIndex((row) => row.dataset.row === 'spec:' + ids[0]);
  const next = rows.slice(index + 1).find((row) => !ids.includes(row.dataset.row.slice(5)))?.dataset.row.slice(5);
  const feedback = { root, id: ids[0], next, from: anchor?.closest('#spec-detail') ? 'detail' : 'list', tone: '', text: 'Recording decision…' };
  view.specFeedback = feedback;
  render();
  window.scrollTo({ top: scroll, behavior: 'instant' });
  try {
    const move = pageMove(command, args);
    const result = requests ? await sendPersonRequest(root, move.body) : await api(boardPath(root) + '/moves', move.body);
    const request = requests && result?.result?.request;
    if (requests && (!request?.id || !['waiting', 'done', 'refused'].includes(request.status))) throw new Error('The request did not include its status; refresh the board to check it.');
    feedback.tone = requests ? request.status === 'done' ? 'ok' : request.status === 'refused' ? 'no' : '' : 'ok';
    feedback.text = requests ? requestNotice(request) : moveMessage(move.body, result.result);
    if (requests) { feedback.requestId = request.id; feedback.status = request.status; }
    await refresh();
  } catch (error) {
    feedback.tone = 'no';
    feedback.text = String(error.message || error);
  }
  if (root === view.root && view.specFeedback === feedback) {
    render();
    window.scrollTo({ top: scroll, behavior: 'instant' });
    if (!requests || feedback.status === 'done') setTimeout(() => { if (view.specFeedback === feedback) { view.specFeedback = null; render(); } }, 6000);
  }
  return requests ? Boolean(feedback.requestId) && feedback.status !== 'refused' : feedback.tone === 'ok';
}

/** Run a public API move beside its action and let only the latest one own the console and timer. */
async function act(command, args, anchor) {
  const out = $('console');
  if (snapshot || (readOnly && !requests)) { out.hidden = false; out.className = 'console no'; out.textContent = snapshot ? 'This is a read-only snapshot.' : 'This is a read-only view.'; return false; }
  if (anchor) {
    const target = anchor.matches('form')
      ? anchor.querySelector('.actions') || anchor.querySelector('[type="submit"]') || anchor
      : anchor.closest('#lanes') || anchor;
    target.insertAdjacentElement(anchor.matches('form') ? 'beforebegin' : 'afterend', out);
  }
  const run = (view.acting = (view.acting || 0) + 1);
  const root = view.root;
  const latest = () => run === view.acting && root === view.root;
  view.request = null;
  clearTimeout(view.closing);
  out.hidden = false;
  out.className = 'console';
  out.textContent = requests ? 'Request waiting…' : 'running…';
  out.scrollIntoView({ block: 'nearest' });
  try {
    const move = pageMove(command, args);
    const result = requests ? await sendPersonRequest(root, move.body) : await api(boardPath(root) + '/moves', move.body);
    const request = requests && result?.result?.request;
    if (requests && (!request?.id || !['waiting', 'done', 'refused'].includes(request.status))) throw new Error('The request did not include its status; refresh the board to check it.');
    if (latest()) {
      out.className = 'console' + (requests ? request.status === 'done' ? ' ok' : request.status === 'refused' ? ' no' : '' : ' ok');
      out.textContent = requests ? requestNotice(request) : '$ pullboard ' + move.label + '\\n' + moveMessage(move.body, result.result);
      if (requests) view.request = { root, id: request.id, run };
      out.scrollIntoView({ block: 'center' });
      // What went through says so and then steps aside; a refusal stays until the person closes it.
      if (!requests || request.status === 'done') view.closing = setTimeout(() => { if (latest()) out.hidden = true; }, 6000);
    }
    await refresh();
    if (latest()) out.scrollIntoView({ block: 'center' });
    return !requests || request.status !== 'refused';
  } catch (error) {
    if (latest()) {
      out.className = 'console no';
      out.textContent = String(error.message || error);
      out.scrollIntoView({ block: 'center' });
    }
    return false;
  }
}

/**
 * Move every age on the page on to now, where it stands. A list is rebuilt only when the board
 * changes, so a click is never lost to a rebuild; on a quiet board the ages would otherwise stay
 * as old as the page.
 */
function tickAges() {
  document.querySelectorAll('[data-ago]').forEach((node) => { node.textContent = ago(node.dataset.ago); });
}

/** Open or close the project list where the sidebar is folded into a top bar (under 900px). */
function fold(open) {
  $('side').classList.toggle('open', open);
  $('proj-switch').setAttribute('aria-expanded', String(open));
}

/** Show another project and its item; history restores keep the tab their entry named. */
function switchTo(root, target = null, record = true) {
  answer(null);
  view.root = root;
  const item = typeof target === 'number' ? target : /^item:(\\d+)$/.exec(target || '');
  view.item = typeof item === 'number' ? item : item ? Number(item[1]) : null;
  view.adding = false;
  if (record && view.item !== null) { view.tab = 'items'; keep('pb.tab', view.tab); }
  keep('pb.project', root);
  if (record) address(false);
  fold(false);
  // The board that arrives is drawn even if it matches the last one seen, so the pick is made from it.
  seen = '';
  if (data) renderSide();
  document.body.classList.add('switching');
  refresh().catch(() => { $('live').textContent = 'offline: is pullboard view still running?'; }).finally(() => {
    document.body.classList.remove('switching');
    if (view.item !== null && view.root === root && view.tab === 'items') reveal();
  });
}

document.addEventListener('click', (event) => {
  const t = event.target.closest('[data-root],[data-tab],[data-go],[data-item],[data-state],[data-rows],[data-row],[data-row-decision],[data-section-approve],[data-release],[data-shout],[data-new],[data-code],#proj-switch,#console');
  if (!event.target.closest('.side')) fold(false);
  if (!t) return;
  if (t.id === 'proj-switch') { fold(!$('side').classList.contains('open')); return; }
  if (t.id === 'console') { t.hidden = true; return; }
  if (t.dataset.root) switchTo(t.dataset.root, t.dataset.go || '');
  else if (t.dataset.tab) { openTab(t.dataset.tab); showTab(); }
  else if (t.dataset.go) go(t.dataset.go, t.dataset.board);
  else if (t.dataset.item) pick(Number(t.dataset.item));
  else if (t.dataset.state) { view.state = t.dataset.state; render(); }
  else if (t.dataset.rows) { const [kind, f] = t.dataset.rows.split(':'); view.rows[kind] = f; render(); }
  else if (t.dataset.rowDecision) {
    const id = t.dataset.rowId;
    if (t.dataset.rowDecision === 'approve') decideSpec('spec-approve', { ids: id }, t);
    else {
      view.declining = id;
      view.declineFrom = t.closest('#spec-detail') ? 'detail' : 'list';
      $('spec-decline-title').textContent = 'Decline ' + id;
      $('spec-decline-reason').value = '';
      $('spec-decline-dialog').hidden = false;
      $('spec-decline-reason').focus();
    }
  }
  else if (t.dataset.sectionApprove) {
    const section = t.dataset.sectionApprove;
    const ids = data.project.spec.filter((row) => row.section === section && ['pending', 'draft'].includes(row.status) && !row.decision).map((row) => row.id);
    if (ids.length && window.confirm('Approve all ' + ids.length + ' undecided rows in “' + section + '”?')) decideSpec('spec-approve', { ids: ids.join(' ') }, t);
  }
  else if (t.dataset.row) { const [kind, id] = t.dataset.row.split(':'); view.row[kind] = id; render(); }
  else if (t.dataset.code) code(t.dataset.code, t.dataset.before || '');
  else if (t.dataset.release) act('release', { lane: t.dataset.release }, t);
  else if (t.dataset.shout) { answer(null); $('shout-to').value = t.dataset.shout; $('shout-text').value = '#' + t.dataset.about + ': '; openTab('shouts'); showTab(); $('shout-text').focus(); }
  else if (t.dataset.new !== undefined) { view.adding = true; render(); $('add-title').focus(); }
});
/** Let a Roadmap row with independent inline links keep its keyboard button behavior. */
document.addEventListener('keydown', (event) => {
  if (!['Enter', ' '].includes(event.key)) return;
  const row = event.target.closest('.milestone-item[role="button"]');
  if (event.target !== row) return;
  event.preventDefault();
  go(row.dataset.go, row.dataset.board || view.root);
});
// The form covers the picked item rather than dropping it, so Cancel brings it back.
$('new-item').addEventListener('click', () => { view.adding = true; render(); $('add-title').focus(); });
$('add-cancel').addEventListener('click', () => { view.adding = false; render(); });
$('spec-decline-cancel').addEventListener('click', () => { view.declining = null; $('spec-decline-dialog').hidden = true; });
$('spec-decline-form').addEventListener('submit', (event) => {
  event.preventDefault();
  const id = view.declining;
  const reason = $('spec-decline-reason').value.trim();
  if (!id || !reason) return;
  view.declining = null;
  $('spec-decline-dialog').hidden = true;
  const anchor = view.declineFrom === 'detail' ? $('spec-detail') : [...$('spec-list').querySelectorAll('[data-row]')].find((row) => row.dataset.row === 'spec:' + id);
  decideSpec('spec-decline', { ids: id, reason }, anchor);
});
$('answer-cancel').addEventListener('click', () => answer(null));
$('flow-hide').addEventListener('click', () => showFlow(false));
$('flow-show').addEventListener('click', () => showFlow(true));
$('flow-panel').hidden = keep('pb.flow') === 'hidden';
$('flow-show').hidden = !$('flow-panel').hidden;
// Each press moves on one, from the system's theme to light, then dark, and back; this browser keeps it.
$('side-toggle').addEventListener('click', () => {
  // A phone always shows the switcher, so there the logo is only the logo.
  if (!matchMedia('(width > 900px)').matches) return;
  const collapsed = !document.documentElement.dataset.side;
  collapseSide(collapsed);
  fold(false);
  keep('pb.side', collapsed ? 'collapsed' : 'open');
});
$('theme').addEventListener('click', () => {
  const next = { light: 'dark', dark: 'system' }[document.documentElement.dataset.theme] || 'light';
  keep('pb.theme', next);
  theme(next);
});
$('q').addEventListener('input', search);
$('add-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  if (await act('add', { lane: $('add-lane').value, title: $('add-title').value, criterion: $('add-criterion').value, specs: $('add-specs').value, brief: $('add-brief').value }, event.currentTarget)) {
    $('add-title').value = '';
    $('add-criterion').value = '';
    $('add-specs').value = '';
    $('add-brief').value = '';
  }
});
$('shout-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const text = $('shout-text').value;
  const ask = view.answering;
  if (ask && ask.root !== view.root) return answer(null);
  if (!(await (ask ? act('answer', { id: ask.id, text }, event.currentTarget) : act('shout', { to: $('shout-to').value, text }, event.currentTarget)))) return;
  $('shout-text').value = '';
  answer(null);
});
$('hold-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  if (await act('hold', { lane: $('hold-lane').value, reason: $('hold-reason').value }, event.currentTarget)) $('hold-reason').value = '';
});
// The first entry keeps the tab it opened on; Back and Forward show what each entry names.
address(false);
globalThis.addEventListener?.('popstate', fromAddress);
showTab();
if (snapshot) {
  $('replay-play').addEventListener('click', playReplay);
  $('replay-pause').addEventListener('click', pauseReplay);
  $('replay-speed').addEventListener('change', () => {
    if (snapshotReplay.playing) { clearTimeout(snapshotReplay.timer); snapshotReplay.timer = setTimeout(advanceReplay, 1000 / Number($('replay-speed').value)); }
  });
}
/** Load an explicitly configured transport before the first read; its updates refresh this page. */
async function startPage() {
  if (transportModule) {
    try {
      const module = await import(transportModule);
      if (typeof module.createTransport !== 'function') throw new Error('The browser transport must export createTransport({ onUpdate }).');
      const configured = await module.createTransport({ onUpdate: () => transport ? refresh().catch((error) => { $('live').textContent = 'offline: ' + error.message; }) : Promise.resolve() });
      if (!configured || typeof configured.request !== 'function') throw new Error('The browser transport must provide request(path, body).');
      transport = configured;
    } catch (error) {
      transportLoadError = error;
      throw error;
    }
  }
  await refresh();
}
startPage().catch((error) => { document.body.classList.remove('loading'); $('live').textContent = 'cannot reach the view: ' + error.message; });
if (!snapshot) setInterval(() => { if (!document.hidden && (!transportModule || transport)) refresh().catch(() => { $('live').textContent = 'offline: is pullboard view still running?'; }); }, 3000);
setInterval(tickAges, 60000);
</script>
</body>
</html>`;
}
