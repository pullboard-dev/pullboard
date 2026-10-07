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
 * the page itself holds none, so its policy can refuse inline styles.
 *
 * @param {string} [key] - The session's secret.
 * @returns {string}
 */
export function cockpitPage(key = '') {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Pullboard</title>
<link rel="stylesheet" href="/view.css?k=${encodeURIComponent(key)}">
</head>
<body class="loading">
<div class="shell">
<aside class="side" id="side" aria-label="Projects">
  <div class="side-top">
    <div class="brand"><svg viewBox="0 0 64 64" aria-hidden="true"><path fill="currentColor" d="M8 7h35a6 6 0 0 1 6 6v7H8a5 5 0 0 1-5-5v-3a5 5 0 0 1 5-5Z"/><rect width="56" height="14" x="3" y="25" fill="var(--accent)" rx="5"/><path fill="currentColor" d="M8 43h35a6 6 0 0 1 6 6v8H8a5 5 0 0 1-5-5v-4a5 5 0 0 1 5-5Z"/></svg><span>Pullboard</span></div>
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
  </nav>
  <span class="live" id="live"></span>
</header>
<main>
  <section class="card-panel first">
    <h2>No boards yet</h2>
    <p>Run <code>pullboard init</code> in a git repo, or ask an agent to. Its board shows up here by itself.</p>
  </section>
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
    <figure class="card-panel flow"><div id="flow"></div><figcaption>The lifecycle every item follows, as pullboard declares it. Boxes count the items in each state now, arrows the moves made so far; hover over one for what it means and checks.</figcaption></figure>
    <div class="card-panel feed" id="activity"></div>
  </section>
</main>
</div>
</div>
<div class="console" id="console" title="Click to close" hidden></div>
<script>
const key = new URLSearchParams(location.search).get('k') || '';
const keep = (name, value) => { try { if (value === undefined) return localStorage.getItem(name); localStorage.setItem(name, value); } catch { return null; } return value; };
const view = { root: keep('pb.project'), tab: keep('pb.tab') || 'items', seen: {}, code: {}, item: null, adding: false, state: 'active', rows: { spec: 'decide', doctrine: 'all' }, row: { spec: null, doctrine: null } };
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
const verdictHtml = (v) => '<div class="verdict ' + (v.decision === 'ACCEPT' ? 'yes' : 'no') + '"><b>' + esc(v.decision) + ' ' + esc(v.reason) + '</b><span class="by">' + esc(v.by) + ' · ' + when(v.at) + ' · at ' + esc(String(v.commit || '').slice(0, 12)) + '</span><div class="note">' + esc(v.note) + '</div></div>';
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
const tone = (s) => s === 'approved' ? 'ok' : s === 'pending' ? 'no' : s === 'draft' ? 'warn' : '';
const count = (n, one, many = one) => n + ' ' + (n === 1 ? one : many);
// What needs the person in a project, as its Needs-you list counts it: work sent back or waiting for a
// verdict, open questions, held lanes.
const needCount = (x) => x.ok ? x.decisions + x.sentBack + x.awaiting + x.pending + x.holds : 0;
const doing = (x) => [x.decisions && count(x.decisions, 'decision', 'decisions'), x.sentBack && count(x.sentBack, 'sent back'), x.awaiting && count(x.awaiting, 'to verify'), x.pending && count(x.pending, 'question', 'questions'), x.holds && count(x.holds, 'lane held', 'lanes held'), x.building && count(x.building, 'building')].filter(Boolean).join(' · ') || (x.open ? count(x.open, 'item open', 'items open') : 'nothing open');
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
  const steps = replay(item);
  return '<ol class="tl">' + steps.map((s, i) => {
    const enters = s.move ? s.move.to : s.kind === 'add' ? FLOW.initial : null;
    const state = enters || s.from;
    const final = FLOW.states.some((f) => f.id === state && f.final);
    const next = steps.slice(i + 1).find((n) => n.move);
    const named = s.kind === 'reject' ? 'sent back' : state;
    const stay = !enters || final ? ''
      : !s.at ? esc(named + (next ? ' after the ' : ' so far since the ') + s.kind + ', length not logged')
      : !next ? esc(named) + ' for ' + age(s.at) + ' so far'
      : !next.at ? esc(named + ' until the ' + next.kind + ', length not logged')
      : esc(named + ' for ' + span(Date.parse(next.at) - Date.parse(s.at)));
    return '<li class="tl-' + esc(state) + (s.kind === 'reject' ? ' tl-back' : '') + (enters ? '' : ' tl-quiet') + '"><time>' + (s.at ? when(s.at) : '') + '</time><span><b>' + esc(s.kind) + '</b> ' + esc(s.by) + '</span>' + (stay ? '<small>' + stay + '</small>' : '') + '</li>';
  }).join('') + '</ol>';
}

/**
 * The lifecycle drawn as SVG with this board's counts. The longest way from the start to a final
 * state runs along a row, the first-declared final winning a tie, and any other state sits below,
 * under the states that lead to it. One arrow joins each pair of states some move joins: forward
 * along the row, arcing above it back to an earlier state, down to a state below, or looping at the
 * corner of a box it stays in. Boxes count the items there now; arrows count the moves made along them.
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
  const W = 800, L = 44, BW = 116, BH = 56, Y = 136;
  const step = (W - 2 * L - BW) / Math.max(row.length - 1, 1);
  const pos = new Map(row.map((s, i) => [s, { x: L + BW / 2 + i * step, y: Y }]));
  for (const s of FLOW.states.filter((s) => !pos.has(s.id))) {
    const from = row.filter((r) => leads(r).includes(s.id));
    pos.set(s.id, { x: from.length ? from.reduce((n, r) => n + pos.get(r).x, 0) / from.length : W / 2, y: Y + 150 });
  }
  const H = Math.max(...[...pos.values()].map((q) => q.y)) + BH / 2 + 20;
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
  const text = (x, y, words, cls, anchor = 'middle') => '<text class="' + cls + '" x="' + f(x) + '" y="' + f(y) + '" text-anchor="' + anchor + '">' + esc(words) + '</text>';
  const arrows = pairs.map((pair) => {
    const a = pos.get(pair.from), b = pos.get(pair.to);
    const done = pair.moves.filter((m) => made(pair, m));
    const words = (done.length ? done.map((m) => m.verb + ' ' + made(pair, m)) : pair.moves.map((m) => m.verb)).join(' · ');
    const tone = pair.moves.some((m) => m.verb === 'reject') ? ' no' : '';
    const cls = 'tag' + (done.length ? '' : ' idle') + tone;
    let d, label = '';
    if (pair.from === pair.to) {
      // A move that stays: a loop out of the box's bottom edge and back into its left side.
      const sx = a.x - BW / 2 + 26, sy = a.y + BH / 2, ex = a.x - BW / 2, ey = a.y + BH / 2 - 16;
      d = 'M' + f(sx) + ' ' + f(sy) + 'C' + f(sx) + ' ' + f(sy + 28) + ' ' + f(ex - 28) + ' ' + f(ey) + ' ' + f(ex) + ' ' + f(ey);
      label = text(a.x - BW / 2 - 18, a.y + BH / 2 + 34, words, cls, 'start');
    } else if (col(pair.from) >= 0 && col(pair.to) > col(pair.from)) {
      d = 'M' + f(a.x + BW / 2) + ' ' + f(a.y) + 'L' + f(b.x - BW / 2) + ' ' + f(b.y);
      label = text((a.x + b.x) / 2, a.y - 9, words, cls);
    } else if (col(pair.from) >= 0 && col(pair.to) >= 0) {
      // Back along the row: an arc above it, higher the further back it goes.
      const span = col(pair.from) - col(pair.to), sx = a.x - 16 * span, ex = b.x + 16 * span, top = a.y - BH / 2, cy = top - 36 * span - 8;
      d = 'M' + f(sx) + ' ' + f(top) + 'C' + f(sx) + ' ' + f(cy) + ' ' + f(ex) + ' ' + f(cy) + ' ' + f(ex) + ' ' + f(top);
      label = text((sx + ex) / 2, (top + 3 * cy) / 4 - 7, words, cls);
    } else {
      // Down to a state off the row: the arrows spread across its top, each labelled along its way,
      // on the side away from the others.
      const sy = a.y + BH / 2, ex = b.x + (a.x - b.x) * 0.3, ey = b.y - BH / 2;
      d = 'M' + f(a.x) + ' ' + f(sy) + 'L' + f(ex) + ' ' + f(ey);
      const lx = a.x + (ex - a.x) * 0.6, ly = sy + (ey - sy) * 0.6 + 4;
      // A straight drop, its ends equal but for rounding, keeps its label on the right.
      label = a.x < b.x - 0.5 ? text(lx - 6, ly, words, cls, 'end') : text(lx + 6, ly, words, cls, 'start');
    }
    return '<g><title>' + esc(says(pair)) + '</title><path class="edge' + tone + '" d="' + d + '" marker-end="url(#pb-head' + (tone ? '-no' : '') + ')"/>' + label + '</g>';
  });
  const back = p.items.filter((i) => stateOf(i) === 'back').length;
  const boxes = FLOW.states.map((s) => {
    const { x, y } = pos.get(s.id);
    const tip = s.id + ': ' + s.means + (s.entry.length ? '.\\nEvery way in checks:\\n' + s.entry.map((r) => '  ' + r).join('\\n') : '.');
    return '<g class="s-' + esc(s.id) + '"><title>' + esc(tip) + '</title><rect class="box" x="' + f(x - BW / 2) + '" y="' + f(y - BH / 2) + '" width="' + BW + '" height="' + BH + '" rx="10"/>'
      + text(x - BW / 2 + 12, y - 9, s.id, 'name', 'start') + text(x - BW / 2 + 12, y + 18, String(p.items.filter((i) => i.status === s.id).length), 'n', 'start')
      + (s.id === FLOW.initial && back ? text(x + BW / 2 - 10, y + 17, back + ' sent back', 'sub', 'end') : '') + '</g>';
  });
  const head = (id, cls) => '<marker id="' + id + '" class="' + cls + '" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0 0L10 5L0 10z"/></marker>';
  return '<svg viewBox="0 0 ' + W + ' ' + f(H) + '" role="img" aria-label="The item lifecycle, with counts from this board"><defs>' + head('pb-head', '') + head('pb-head-no', 'no') + '</defs>' + arrows.join('') + boxes.join('') + '</svg>';
}

async function api(path, body) {
  const res = await fetch(path, { method: body ? 'POST' : 'GET', headers: { 'x-pullboard-key': key, ...(body ? { 'content-type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const json = await res.json();
  if (!res.ok) throw new Error(json.error || res.status);
  return json;
}

async function refresh() {
  const root = view.root;
  const mark = root ? view.seen['pb.seen.' + root] ?? keep('pb.seen.' + root) : null;
  const next = await api('/api/state' + (root ? '?root=' + encodeURIComponent(root) + (mark === null || mark === undefined ? '' : '&seen=' + encodeURIComponent(mark)) : ''));
  // The person switched projects while this answer was on its way: the switch's own refresh shows it.
  if (root !== view.root) return;
  if (!next.project && next.projects.some((p) => p.ok)) {
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
  $('live').textContent = 'live · ' + new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' });
}

/**
 * The sidebar: every project, the one shown, and what needs the person elsewhere. A switch draws only
 * this until the new board arrives, so the main column never mixes the old board with the new pick.
 */
function renderSide() {
  // Every project stays in view with what needs the person there, so one look covers them all.
  $('proj-list').innerHTML = data.projects.length ? data.projects.map((x) => {
    const on = x.root === view.root;
    return '<button class="proj' + (on ? ' on' : '') + '"' + (on ? ' aria-current="true"' : '') + ' data-root="' + esc(x.root) + '" title="' + esc(x.root) + '" type="button"><span class="pname">' + esc(x.name) + '</span>' + (needCount(x) ? '<b class="need" title="needs you">' + needCount(x) + '</b>' : '') + (x.ok ? '<small>' + esc(doing(x)) : '<small class="bad">' + esc(x.error)) + '</small></button>';
  }).join('') : '<div class="empty">None yet.</div>';
  const elsewhere = data.projects.filter((x) => x.root !== view.root).reduce((n, x) => n + needCount(x), 0);
  $('proj-elsewhere').textContent = elsewhere ? elsewhere + ' elsewhere' : '';
  $('proj-elsewhere').hidden = !elsewhere;
  const p = data.project;
  $('proj-name').textContent = p ? (data.projects.find((x) => x.root === view.root) || { name: p.root.split('/').pop() }).name : 'No project';
  // The browser tab says it too, for when the view sits behind other tabs.
  const needs = data.projects.reduce((n, x) => n + needCount(x), 0);
  document.title = p ? (needs ? '(' + needs + ') ' : '') + $('proj-name').textContent + ' · Pullboard' : 'Pullboard';
}

/** Draw the board shown: the sidebar, then every tab's panes from the project's board. */
function render() {
  const p = data.project;
  renderSide();
  if (view.answering && view.answering.root !== view.root) answer(null);
  // Until the first board arrives the page shows no tabs or panes, so a machine with none never
  // flashes them; with no board to show, one message says how a board starts, in their place.
  document.body.classList.remove('loading');
  document.body.classList.toggle('boardless', !p);
  $('products').hidden = !p || !p.products.length;
  if (!p) return;
  // Each product's progress (N28): the rows an accepted item cites, and its items by state.
  $('prod-list').innerHTML = p.products.map((x) => {
    const states = [['open', '', x.items.open], ['building', 'building', x.items.claimed], ['to verify', 'verify', x.items.submitted], ['verified', 'verified', x.items.verified]].filter(([, , n]) => n);
    return '<div class="prod" title="' + x.rows + ' rows in force, ' + x.approved + ' approved, ' + x.proven + ' cited by accepted items"><p><b>' + esc(x.name) + '</b><span>' + x.proven + '/' + x.rows + ' rows met</span></p><svg class="bar" viewBox="0 0 100 1" preserveAspectRatio="none" aria-hidden="true"><rect width="' + (x.rows ? Math.round((100 * x.proven) / x.rows) : 0) + '" height="1"/></svg>'
      + (states.length ? '<small>' + states.map(([label, dot, n]) => '<span><i class="dot ' + dot + '"></i>' + n + ' ' + label + '</span>').join('') + '</small>' : '') + '</div>';
  }).join('');
  const items = p.items.filter((i) => i.status !== 'withdrawn');
  const by = (s) => items.filter((i) => stateOf(i) === s);
  const active = items.filter((i) => stateOf(i) !== 'verified');
  $('count-items').textContent = active.length || '';
  $('count-spec').textContent = p.spec.filter((r) => ['pending', 'draft'].includes(r.status)).length || '';
  $('count-doctrine').textContent = p.practice.filter((r) => ['pending', 'draft'].includes(r.status)).length || '';

  // What needs the person, first: decisions asked, questions, work sent back, work waiting for a
  // verdict, held lanes.
  const needs = [
    ...p.decisions.map((d) => ['decide:' + d.shout_id, d.shout_from, d.shout_text, 'decide', d.shout_at]),
    ...p.spec.filter((r) => r.status === 'pending').map((r) => ['spec:' + r.id, r.id, r.text, 'answer in SPEC.md']),
    ...by('back').map((i) => ['item:' + i.id, '#' + i.id, i.title, 'sent back: ' + i.verdict.reason]),
    ...by('verify').map((i) => ['item:' + i.id, '#' + i.id, i.title, (i.reviewer ? 'being reviewed by ' + i.reviewer : rejected(i) ? 'resubmitted after ' + i.verdict.reason : 'to verify'), i.updatedAt]),
    ...p.holds.map((h) => ['tab:shouts', h.hold_lane, h.hold_reason, 'lane held']),
  ];
  const drafts = p.spec.filter((r) => r.status === 'draft').length;
  $('needs').hidden = !needs.length && !drafts;
  $('needs').innerHTML = '<div class="head"><i></i>Needs you</div>' + needs.slice(0, 6).map(([target, ref, text, what, at]) => '<button class="ny" data-go="' + esc(target) + '" type="button"><code>' + esc(ref) + '</code><span>' + esc(text) + '</span><em>' + esc(what) + (at ? ', ' + age(at) : '') + ' →</em></button>').join('') + (needs.length > 6 ? '<div class="muted more">and ' + (needs.length - 6) + ' more</div>' : '') + (drafts ? '<button class="ny" data-go="tab:spec" type="button"><code>' + drafts + '</code><span>draft spec rows to approve or drop</span><em>review →</em></button>' : '');

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
  if (!view.adding && !p.items.some((i) => i.id === view.item)) view.item = shown.length ? shown[0].id : null;
  const heldLanes = new Map(p.holds.map((h) => [h.hold_lane, h]));
  $('chain').innerHTML = shown.length ? shown.map((i) => {
    const s = stateOf(i);
    const who = s === 'building' ? i.owner : [i.builtBy, i.verifiedBy].filter(Boolean).join(' → ');
    // What an open item waits on, if anything: items not yet verified, or a hold on its lane.
    const hold = s === 'open' ? heldLanes.get(i.lane) : null;
    const waits = s === 'open' && i.blockedBy.length ? i.blockedBy : [];
    const gated = waits.length > 0 || !!hold;
    const pills = (waits.length ? '<span class="gate">waits on ' + waits.map((id) => '<button class="ref" data-go="item:' + id + '" type="button">#' + id + '</button>').join(', ') + '</span>' : '') + (hold ? '<span class="gate">lane held: ' + esc(hold.hold_reason) + '</span>' : '');
    const tag = s === 'building' && i.owner ? '<span class="chip busy" title="building, held by ' + esc(i.owner) + '">' + esc(i.owner) + '</span>'
      : s === 'verify' && i.reviewer ? '<span class="chip warn" title="reviewing until ' + esc(when(i.reviewUntil)) + '">' + esc(i.reviewer) + ' reviewing</span>'
      : s === 'open' ? (gated ? '<span class="chip gate">' + (waits.length ? 'gated' : 'lane held') + '</span>' : '<span class="chip free">unclaimed</span>') : chip(s);
    return '<li class="row' + (view.item === i.id ? ' on' : '') + (gated ? ' gated' : '') + '" data-item="' + i.id + '"><span class="dot ' + s + '"></span><div><div class="t"><span>#' + i.id + '</span>' + esc(i.title) + '</div><div class="meta"><span>' + esc(i.lane) + '</span>' + (i.specs.length ? '<span>' + esc(i.specs.join(', ')) + '</span>' : '') + (who ? '<span>' + esc(who) + '</span>' : '') + pills + '<span>' + age(i.updatedAt) + '</span>' + (rejected(i) ? '<span class="why">' + esc(i.verdict.reason + ': ' + firstLine(i.verdict.note)) + '</span>' : '') + '</div></div>' + tag + '</li>';
  }).join('') : '<li class="empty">' + (items.length ? 'No items match.' : 'No items yet. Add the first one with New item.') + '</li>';

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
    $('detail').innerHTML = '<div class="stack"><div><h2><span>#' + item.id + '</span>' + esc(item.title) + '</h2><div class="meta spaced">' + chip(s) + '<span class="chip">' + esc(item.lane) + '</span><span class="chip">' + esc(item.route) + '</span></div></div>'
      + (back ? '<div class="sentback"><h3>Sent back' + (s === 'building' ? ', being reworked' : s === 'verify' ? ', resubmitted' : s === 'withdrawn' ? ', then withdrawn' : '') + '</h3>' + verdictHtml(item.verdict) + '</div>' : '')
      + (item.criterion ? '<div><h3>Criterion</h3><div class="text">' + esc(item.criterion) + '</div></div>' : '')
      + (cited.length ? '<div><h3>Spec rows it serves</h3>' + cited.map((r) => '<div class="rowref"><code>' + esc(r.id) + '</code><div>' + esc(r.text) + ' <span class="chip ' + tone(r.status) + '">' + esc(r.status) + '</span></div></div>').join('') + '</div>' : '')
      + (item.brief ? '<div><h3>Brief</h3><div class="text muted">' + esc(item.brief) + '</div></div>' : '')
      + '<div><h3>People and commits</h3><dl class="kv">' + (item.owner && s === 'building' ? '<dt>holding</dt><dd>' + esc(item.owner) + '</dd>' : '') + (item.builtBy ? '<dt>built by</dt><dd>' + esc(item.builtBy) + '</dd>' : '') + (item.verifiedBy ? '<dt>verified by</dt><dd>' + esc(item.verifiedBy) + '</dd>' : '') + (item.commit ? '<dt>commit</dt><dd><code>' + esc(item.commit.slice(0, 12)) + '</code></dd>' : '') + (item.merged ? '<dt>merged</dt><dd><code>' + esc(item.merged.slice(0, 12)) + '</code></dd>' : '') + (item.blockedBy.length ? '<dt>waits on</dt><dd>' + item.blockedBy.map((id) => '#' + id).join(', ') + '</dd>' : '') + '</dl></div>'
      + (back && !earlier.length ? '' : '<div><h3>' + (back ? 'Earlier verdicts' : 'Verdicts') + '</h3>' + (earlier.length ? earlier.map(verdictHtml).join('') : '<div class="muted">None yet.</div>') + '</div>')
      + '<div><h3>History</h3>' + timeline(item) + '</div>'
      + '<div class="links"><button data-shout="' + esc(item.lane) + '" data-about="' + item.id + '" type="button">Shout the ' + esc(item.lane) + ' lane about #' + item.id + '</button><button data-new type="button">New item</button></div></div>';
  }

  // Every #id in a shout that names an item opens it, whatever stands next to it. The ids are found in
  // the raw text and each piece is escaped on its own, so an apostrophe's &#39; is never read as one;
  // a number that names no item stays text. A path:lines@commit reference opens that code (B23). It
  // counts only as a whole word, never as the tail of one, so what it opens is what it says, and the
  // view refuses what is no path in the repo.
  const titles = new Map(p.items.map((i) => [String(i.id), i.title]));
  const linked = (text) => String(text ?? '').split(/(#\\d+|(?<![^\\s([{"'\`])[^\\s:@()[\\]{}"'\`]+:\\d+(?:-\\d+)?@[0-9a-f]{7,40}(?![^\\s)\\]}"'\`.,;:!?]))/).map((part, n, parts) => {
    if (n % 2 && part[0] !== '#') return codeRef(part, parts.slice(0, n).join('').split('\\n').pop().slice(-2000));
    const id = /^#\\d+$/.test(part) ? String(Number(part.slice(1))) : '';
    return titles.has(id) ? '<button class="ref" data-go="item:' + id + '" title="' + esc(titles.get(id)) + '" type="button">' + esc(part) + '</button>' : esc(part);
  }).join('');
  const mark = (x) => (x.shout_decision ? '<span class="mark ask">decision</span> ' : x.shout_answers ? '<span class="mark">answer</span> ' : '');
  // Evidence a shout carries (B22), as the fields it is: its kind and outcome, the item, who sent it,
  // and the commit, shortened, with the full SHA on hover.
  const evidence = (x) => (x.shout_evidence_kind ? '<span class="ev"><b>' + esc(x.shout_evidence_kind) + '</b> ' + esc(x.shout_evidence_outcome) + ' · ' + linked('#' + x.shout_evidence_item) + ' · ' + esc(x.shout_from) + ' · <code title="' + esc(x.shout_evidence_commit) + '">' + esc(String(x.shout_evidence_commit).slice(0, 12)) + '</code></span>' : '');
  $('feed').innerHTML = p.shouts.length ? byDay(p.shouts, (x) => x.shout_at, (x) => '<div><time>' + clock(x.shout_at) + '</time><div><b>' + esc(x.shout_from) + ' → ' + esc(x.shout_to) + '</b> ' + mark(x) + linked(x.shout_text) + evidence(x) + '</div></div>') : '<div class="empty">No shouts yet.</div>';
  // Each ask waits here until it is answered (B21); the answer itself is typed in the form below.
  $('decisions').hidden = !p.decisions.length;
  $('decisions').innerHTML = '<div class="head"><i></i>Decision needed</div>' + p.decisions.map((d) => '<div class="ask"><p><small><b>' + esc(d.shout_from) + '</b> asks, ' + age(d.shout_at) + '</small></p><p>' + linked(d.shout_text) + '</p><button class="ghost" data-go="decide:' + d.shout_id + '" type="button">Answer</button></div>').join('');
  $('shout-targets').innerHTML = ['all', ...lanes, ...p.agents.map((a) => a.agent_id)].map((t) => '<option value="' + esc(t) + '">').join('');
  // Each agent with what it holds: its claim, then its work sent back, then its work waiting for a
  // verdict. The worktree path is there on hover; what the person reads is who is doing what.
  // A review an agent holds (V15) comes right after its claim.
  const rank = (a, i) => i.status === 'claimed' ? 0 : i.reviewer === a.agent_id ? 1 : stateOf(i) === 'back' ? 2 : 3;
  const holding = (a) => items.filter((i) => i.status === 'claimed' ? i.owner === a.agent_id : i.reviewer === a.agent_id || (i.builtBy === a.agent_id && ['back', 'verify'].includes(stateOf(i)))).sort((x, y) => rank(a, x) - rank(a, y));
  $('agents').innerHTML = p.agents.length ? p.agents.map((a) => {
    const mine = holding(a);
    return '<div class="agent"><div><b title="' + esc(a.agent_path) + '">' + esc(a.agent_id) + '</b><span class="muted">' + esc(a.agent_lane) + ' · ' + esc(a.agent_route) + '</span>' + (a.lastMoveAt ? '<time data-ago="' + esc(a.lastMoveAt) + '" title="last moved ' + when(a.lastMoveAt) + '">' + ago(a.lastMoveAt) + '</time>' : '') + '</div>'
      + (mine.length ? mine.map((i) => '<button data-go="item:' + i.id + '" type="button"><span>#' + i.id + ' ' + esc(i.title) + '</span>' + (i.reviewer === a.agent_id ? '<span class="chip warn">reviewing</span>' : chip(stateOf(i))) + '</button>').join('') : '<small>idle</small>') + '</div>';
  }).join('') : '<div class="empty">No agents yet.</div>';
  const held = new Map(p.holds.map((h) => [h.hold_lane, h]));
  $('lanes').innerHTML = working.map((l) => '<div class="lane"><span><b>' + esc(l) + '</b> ' + (held.has(l) ? '<span class="chip no">held</span> <span class="muted">' + esc(held.get(l).hold_reason) + '</span>' : '<span class="chip ok">open</span>') + '</span>' + (held.has(l) ? '<button class="ghost" data-release="' + esc(l) + '" type="button">Release</button>' : '') + '</div>').join('');

  for (const kind of ['spec', 'doctrine']) {
    const rows = kind === 'spec' ? p.spec : p.practice;
    const filter = view.rows[kind];
    const labels = { decide: 'Needs your decision', all: 'All rows', approved: 'Approved' };
    const n = { decide: rows.filter((r) => ['pending', 'draft'].includes(r.status)).length, all: rows.length, approved: rows.filter((r) => r.status === 'approved').length };
    $(kind + '-chips').innerHTML = Object.keys(labels).map((f) => '<button data-rows="' + kind + ':' + f + '" class="' + (filter === f ? 'on' : '') + '" type="button">' + labels[f] + '<b>' + n[f] + '</b></button>').join('');
    const shownRows = rows.filter((r) => filter === 'all' || (filter === 'decide' ? ['pending', 'draft'].includes(r.status) : r.status === 'approved'));
    let section = null;
    $(kind + '-list').innerHTML = shownRows.length ? shownRows.map((r) => {
      const head = r.section !== section ? '<h4>' + esc(r.section) + '</h4>' : '';
      section = r.section;
      return head + '<div class="srow' + (view.row[kind] === r.id ? ' on' : '') + '" data-row="' + kind + ':' + esc(r.id) + '"><code>' + esc(r.id) + '</code><span><span class="chip ' + tone(r.status) + '">' + esc(r.status) + '</span></span><span>' + esc(r.text) + '</span></div>';
    }).join('') : '<div class="empty">' + (rows.length ? 'No rows match.' : kind === 'spec' ? 'No spec rows yet. Each requirement is one row in SPEC.md, such as G1 [draft, must] and a line; write them, or ask an agent to, and they show up here.' : 'No practice rows yet: they live in PRACTICE.md.') + '</div>';
    const row = rows.find((r) => r.id === view.row[kind]);
    const citing = row ? p.items.filter((i) => i.specs.includes(row.id)) : [];
    $(kind + '-detail').innerHTML = row ? '<div class="stack tight"><h2><span>' + esc(row.id) + '</span>' + esc(row.text) + '</h2><div class="meta"><span class="chip ' + tone(row.status) + '">' + esc(row.status) + '</span>' + (row.tier ? '<span class="chip">' + esc(row.tier) + '</span>' : '') + '</div><dl class="kv"><dt>section</dt><dd>' + esc(row.section) + '</dd>' + (row.gate ? '<dt>gate</dt><dd>' + esc(row.gate) + '</dd>' : '') + (row.serves && row.serves.length ? '<dt>serves</dt><dd>' + esc(row.serves.join(', ')) + '</dd>' : '') + '</dl><div><h3>Items that cite it</h3>' + (citing.length ? '<div class="links">' + citing.map((i) => '<button data-go="item:' + i.id + '" type="button">#' + i.id + ' ' + esc(i.title) + '</button>').join('') + '</div>' : '<div class="muted">None yet.</div>') + '</div><div class="muted">Rows change in ' + (kind === 'spec' ? 'SPEC.md' : 'PRACTICE.md') + ', and only you approve them.</div></div>' : '<div class="empty">Pick a row to see it, and the items that cite it.</div>';
  }

  $('flow').innerHTML = flowSvg(p);
  $('activity').innerHTML = p.events.length ? byDay(p.events, (e) => e.event_at, (e) => '<div><time>' + clock(e.event_at) + '</time><div class="act"><b>' + esc(e.event_by) + '</b> ' + esc(e.event_kind) + (e.item_id ? ' <button class="ref" data-go="item:' + e.item_id + '" type="button">#' + e.item_id + '</button>' + (titles.has(String(e.item_id)) ? ' <span class="what">' + esc(titles.get(String(e.item_id))) + '</span>' : '') : '') + '</div></div>') : '<div class="empty">No activity yet.</div>';
  showTab();
}

function showTab() {
  document.querySelectorAll('[data-pane]').forEach((pane) => { pane.hidden = pane.dataset.pane !== view.tab; });
  document.querySelectorAll('.tab').forEach((button) => button.classList.toggle('on', button.dataset.tab === view.tab));
  countUnseen();
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
  $('answering-q').textContent = ask ? ask.shout_text : '';
  if (ask) $('shout-to').value = ask.shout_from;
  $('shout-to').disabled = Boolean(ask);
  $('shout-send').textContent = ask ? 'Answer' : 'Shout';
  if (ask) $('shout-text').focus();
}

function go(target) {
  const [kind, id] = target.split(':');
  if (kind === 'item') { view.tab = 'items'; view.state = 'all'; view.before = null; }
  else if (kind === 'spec') { view.tab = 'spec'; view.row.spec = id; view.rows.spec = 'all'; }
  else if (kind === 'tab') view.tab = id;
  else if (kind === 'decide') { view.tab = 'shouts'; answer(Number(id)); }
  keep('pb.tab', view.tab);
  if (kind === 'item') pick(Number(id));
  else render();
}

/** Show an item's detail. Where the list and the detail stack (under 900px), bring the detail into view. */
function pick(id) {
  view.item = id;
  view.adding = false;
  render();
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
    Object.assign(c, await api('/api/code?root=' + encodeURIComponent(view.root) + '&ref=' + encodeURIComponent(ref) + '&before=' + encodeURIComponent(before)));
  } catch (error) {
    c.error = String(error.message || error);
  }
  render();
}

/**
 * Run an action as its CLI command on the server, show what the command said, and redraw from the
 * board. The console belongs to the latest action: one that answers after a later one has started
 * writes nothing there and sets no close, and a close fires only while its action is still the
 * latest, so a success can never hide a refusal that came after it.
 */
async function act(command, args) {
  const out = $('console');
  const run = (view.acting = (view.acting || 0) + 1);
  const latest = () => run === view.acting;
  clearTimeout(view.closing);
  out.hidden = false;
  out.className = 'console';
  out.textContent = 'running…';
  try {
    const result = await api('/api/act', { root: view.root, command, args });
    if (latest()) {
      out.className = 'console ' + (result.code === 0 ? 'ok' : 'no');
      out.textContent = '$ ' + result.command + '\\n' + (result.out + result.err).trim();
      // What went through says so and then steps aside; a refusal stays until the person closes it.
      if (result.code === 0) view.closing = setTimeout(() => { if (latest()) out.hidden = true; }, 6000);
    }
    await refresh();
    return result.code === 0;
  } catch (error) {
    if (latest()) {
      out.className = 'console no';
      out.textContent = String(error.message || error);
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

/** Show another project: mark it at once, dim the old one's panes until its board arrives. */
function switchTo(root) {
  answer(null);
  view.root = root;
  view.item = null;
  view.adding = false;
  keep('pb.project', root);
  fold(false);
  // The board that arrives is drawn even if it matches the last one seen, so the pick is made from it.
  seen = '';
  if (data) renderSide();
  document.body.classList.add('switching');
  refresh().catch(() => { $('live').textContent = 'offline: is pullboard view still running?'; }).finally(() => document.body.classList.remove('switching'));
}

document.addEventListener('click', (event) => {
  const t = event.target.closest('[data-root],[data-tab],[data-go],[data-item],[data-state],[data-rows],[data-row],[data-release],[data-shout],[data-new],[data-code],#proj-switch,#console');
  if (!event.target.closest('.side')) fold(false);
  if (!t) return;
  if (t.id === 'proj-switch') { fold(!$('side').classList.contains('open')); return; }
  if (t.id === 'console') { t.hidden = true; return; }
  if (t.dataset.root) switchTo(t.dataset.root);
  else if (t.dataset.tab) { view.tab = t.dataset.tab; keep('pb.tab', view.tab); showTab(); }
  else if (t.dataset.go) go(t.dataset.go);
  else if (t.dataset.item) pick(Number(t.dataset.item));
  else if (t.dataset.state) { view.state = t.dataset.state; render(); }
  else if (t.dataset.rows) { const [kind, f] = t.dataset.rows.split(':'); view.rows[kind] = f; render(); }
  else if (t.dataset.row) { const [kind, id] = t.dataset.row.split(':'); view.row[kind] = id; render(); }
  else if (t.dataset.code) code(t.dataset.code, t.dataset.before || '');
  else if (t.dataset.release) act('release', { lane: t.dataset.release });
  else if (t.dataset.shout) { answer(null); $('shout-to').value = t.dataset.shout; $('shout-text').value = '#' + t.dataset.about + ': '; view.tab = 'shouts'; showTab(); $('shout-text').focus(); }
  else if (t.dataset.new !== undefined) { view.adding = true; render(); $('add-title').focus(); }
});
// The form covers the picked item rather than dropping it, so Cancel brings it back.
$('new-item').addEventListener('click', () => { view.adding = true; render(); $('add-title').focus(); });
$('add-cancel').addEventListener('click', () => { view.adding = false; render(); });
$('answer-cancel').addEventListener('click', () => answer(null));
// Each press moves on one, from the system's theme to light, then dark, and back; this browser keeps it.
$('theme').addEventListener('click', () => {
  const next = { light: 'dark', dark: 'system' }[document.documentElement.dataset.theme] || 'light';
  keep('pb.theme', next);
  theme(next);
});
$('q').addEventListener('input', search);
$('add-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  if (await act('add', { lane: $('add-lane').value, title: $('add-title').value, criterion: $('add-criterion').value, specs: $('add-specs').value, brief: $('add-brief').value })) {
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
  if (!(await (ask ? act('answer', { id: ask.id, text }) : act('shout', { to: $('shout-to').value, text })))) return;
  $('shout-text').value = '';
  answer(null);
});
$('hold-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  if (await act('hold', { lane: $('hold-lane').value, reason: $('hold-reason').value })) $('hold-reason').value = '';
});
showTab();
refresh().catch((error) => { document.body.classList.remove('loading'); $('live').textContent = 'cannot reach the view: ' + error.message; });
setInterval(() => { if (!document.hidden) refresh().catch(() => { $('live').textContent = 'offline: is pullboard view still running?'; }); }, 3000);
setInterval(tickAges, 60000);
</script>
</body>
</html>`;
}
