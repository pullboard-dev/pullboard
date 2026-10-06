/**
 * The page `pullboard view` serves (N26): one self-contained file, no assets from anywhere, that
 * reads the board through the server's JSON and refreshes itself. The layout is the one the person
 * asked for: a sidebar listing every project on the machine with what needs them there, and a main
 * column with the tabs over two panes, a list and the selected thing's detail. Under 900px wide the
 * sidebar folds into a top bar. Forms post actions that the server runs as CLI commands (N27), so the
 * page never decides a rule itself, and every field a person types in sits outside what the refresh
 * rebuilds.
 *
 * @returns {string}
 */
export function cockpitPage() {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Pullboard</title>
<style>
:root {
  --ground: #e9eceb; --surface: #fdfefd; --surface-2: #f2f4f1; --line: #d3d9d5; --line-strong: #bcc5bf;
  --ink: #121a17; --ink-muted: #4c5852; --ink-faint: #7a887f;
  --accent: #08915f; --accent-strong: #067049; --accent-soft: #dcefe6; --on-accent: #f4fbf7;
  --warn: #a2660f; --warn-soft: #f2e6cf; --reject: #bd4437; --reject-soft: #f4e0dc;
  --blue: #3f6f9e; --blue-soft: #e1eaf3;
  --shadow: 0 1px 2px rgba(18,26,23,.05), 0 12px 34px -18px rgba(18,26,23,.28);
  --sans: system-ui, -apple-system, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
  --mono: ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, monospace;
  --top: 56px; --side-w: 236px; --agents-w: clamp(240px, 30%, 306px);
  color-scheme: light;
}
@media (max-width: 1100px) { :root { --side-w: 208px; } }
@media (prefers-color-scheme: dark) { :root {
  --ground: #0c110f; --surface: #121815; --surface-2: #171f1b; --line: #232e29; --line-strong: #34423b;
  --ink: #e7ece9; --ink-muted: #9caba3; --ink-faint: #6a776f;
  --accent: #34d89e; --accent-strong: #4ee3ac; --accent-soft: #10231c; --on-accent: #05201a;
  --warn: #e4b25a; --warn-soft: #241d10; --reject: #f0776b; --reject-soft: #271613;
  --blue: #6ba7d6; --blue-soft: #142231;
  --shadow: 0 1px 2px rgba(0,0,0,.4), 0 16px 40px -18px rgba(0,0,0,.7); color-scheme: dark; } }
* { box-sizing: border-box; }
body { margin: 0; background: var(--ground); color: var(--ink); font: 14px/1.5 var(--sans); }
button, input, select, textarea { font: inherit; color: inherit; }
[hidden] { display: none !important; }
:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }

.shell { display: grid; grid-template-columns: var(--side-w) minmax(0, 1fr); min-height: 100vh; }
.side { position: sticky; top: 0; height: 100vh; overflow-y: auto; padding: 0 10px 16px; background: var(--surface); border-right: 1px solid var(--line); }
.side-top { display: flex; align-items: center; gap: 10px; height: var(--top); margin: 0 -10px 6px; padding: 0 16px; border-bottom: 1px solid var(--line); }
.brand { display: flex; align-items: center; gap: 8px; font-weight: 700; font-size: 15px; white-space: nowrap; }
.brand svg { width: 22px; height: 22px; flex: none; }
.switch-btn { display: none; align-items: center; gap: 8px; min-width: 0; border: 1px solid var(--line); background: var(--surface-2); border-radius: 8px; padding: 6px 10px; cursor: pointer; font-weight: 600; }
.switch-btn span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.switch-btn small { color: var(--ink-faint); font-weight: 400; }
.side-body { display: grid; gap: 2px; align-content: start; }
.label { font: 600 11px/1 var(--mono); letter-spacing: .07em; text-transform: uppercase; color: var(--ink-faint); padding: 8px 8px 6px; }
.proj { display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: 1px 8px; align-items: center; width: 100%; text-align: left; border: 1px solid transparent; background: none; border-radius: 8px; padding: 7px 8px; cursor: pointer; }
.proj:hover { background: var(--surface-2); }
.proj.on { background: var(--accent-soft); border-color: color-mix(in srgb, var(--accent) 45%, var(--line)); }
.proj .pname { font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.proj small { grid-column: 1 / -1; color: var(--ink-faint); font-size: 12px; line-height: 1.35; overflow-wrap: anywhere; }
.proj small.bad { color: var(--reject); }
.need { min-width: 20px; padding: 1px 6px; border-radius: 999px; background: var(--warn-soft); color: var(--warn); font: 700 11.5px/1.5 var(--mono); text-align: center; }
.start { margin: 12px 4px 0; padding: 10px 4px 0; border-top: 1px solid var(--line); font-size: 13px; color: var(--ink-muted); }
.start summary { cursor: pointer; }
.start form { margin-top: 10px; }
.body { min-width: 0; }
.top { position: sticky; top: 0; z-index: 10; min-height: var(--top); display: flex; align-items: stretch; gap: 12px; padding: 0 18px; background: var(--surface); border-bottom: 1px solid var(--line); }
.tabs { display: flex; flex-wrap: wrap; gap: 2px; }
.tab { border: 0; background: none; padding: 0 12px; cursor: pointer; color: var(--ink-muted); border-bottom: 2px solid transparent; white-space: nowrap; }
.tab.on { color: var(--ink); border-bottom-color: var(--accent); font-weight: 600; }
.tab b { font: 600 11px var(--mono); color: var(--ink-faint); margin-left: 4px; }
.live { margin-left: auto; align-self: center; font-size: 12px; color: var(--ink-faint); white-space: nowrap; }
.switching main { opacity: .45; transition: opacity .12s; }

main { padding: 16px 18px 28px; }
.two { display: grid; grid-template-columns: minmax(0, 1fr) clamp(300px, 42%, 600px); gap: 16px; align-items: start; }
.two.narrow { grid-template-columns: minmax(0, 1fr) var(--agents-w); }
@media (max-width: 900px) {
  .shell { display: block; }
  .side { position: static; height: auto; overflow: visible; padding: 8px 12px; border-right: 0; border-bottom: 1px solid var(--line); }
  .side-top { height: auto; margin: 0; padding: 0; border: 0; }
  .brand span { display: none; }
  .switch-btn { display: flex; }
  .side-body { display: none; padding-top: 6px; }
  .side.open .side-body { display: grid; }
  .top { padding: 0 6px; }
  .tab { padding: 11px 6px; }
  .live { display: none; }
  main { padding: 12px 10px 24px; }
  .two, .two.narrow { grid-template-columns: minmax(0, 1fr); }
}
.primary { display: grid; gap: 12px; min-width: 0; }
.card-panel { background: var(--surface); border: 1px solid var(--line); border-radius: 14px; box-shadow: var(--shadow); min-width: 0; }
.toolbar { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; padding: 10px; }
.toolbar input { flex: 1 1 200px; }
input, select { border: 1px solid var(--line-strong); background: var(--surface); border-radius: 8px; padding: 7px 9px; min-width: 0; }
.go { border: 0; background: var(--ink); color: var(--surface); border-radius: 8px; padding: 8px 14px; cursor: pointer; font-weight: 600; white-space: nowrap; }
.go:hover { background: var(--accent-strong); color: var(--on-accent); }
.ghost { border: 1px solid var(--line-strong); background: var(--surface); border-radius: 8px; padding: 5px 10px; cursor: pointer; }

.needs-you { background: color-mix(in srgb, var(--warn) 8%, var(--surface)); border: 1px solid color-mix(in srgb, var(--warn) 38%, var(--line)); border-radius: 14px; box-shadow: var(--shadow); padding: 10px 12px; display: grid; gap: 4px; }
.needs-you .head { font-weight: 700; display: flex; gap: 8px; align-items: center; }
.needs-you .head i { width: 8px; height: 8px; border-radius: 50%; background: var(--warn); display: inline-block; }
.ny { display: grid; grid-template-columns: auto minmax(0, 1fr) auto; gap: 10px; align-items: baseline; text-align: left; border: 0; background: none; padding: 6px 4px; border-radius: 8px; cursor: pointer; width: 100%; }
.ny:hover { background: color-mix(in srgb, var(--warn) 10%, var(--surface)); }
.ny code { font: 600 12px var(--mono); }
.ny span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--ink-muted); }
.ny em { font-style: normal; color: var(--warn); font-size: 12px; white-space: nowrap; }

.chips { display: flex; flex-wrap: wrap; gap: 6px; padding: 0 2px; }
.chips button { border: 1px solid var(--line); background: var(--surface); border-radius: 999px; padding: 3px 9px; cursor: pointer; font-size: 13px; }
.chips button.on { border-color: var(--accent); background: var(--accent-soft); font-weight: 600; }
.chips button b { font: 600 11px var(--mono); color: var(--ink-faint); margin-left: 4px; }

.chain { list-style: none; margin: 0; padding: 6px; display: grid; gap: 2px; }
.row { display: grid; grid-template-columns: 12px minmax(0, 1fr) auto; gap: 10px; align-items: center; padding: 8px 9px; border-radius: 10px; border: 1px solid transparent; cursor: pointer; }
.row:hover { background: var(--surface-2); }
.row.on { background: var(--accent-soft); border-color: color-mix(in srgb, var(--accent) 50%, var(--line)); }
.dot { width: 9px; height: 9px; border-radius: 50%; background: var(--line-strong); }
.dot.building { background: var(--blue); } .dot.verify { background: var(--warn); } .dot.back { background: var(--reject); } .dot.verified { background: var(--accent); }
.row .t { font-weight: 600; overflow-wrap: anywhere; }
.row .t span { color: var(--ink-faint); font: 500 12px var(--mono); margin-right: 5px; }
.meta { display: flex; flex-wrap: wrap; gap: 4px 8px; color: var(--ink-muted); font-size: 12px; margin-top: 2px; }
.chip { font: 600 10.5px/1 var(--mono); letter-spacing: .03em; padding: 4px 6px; border-radius: 5px; background: var(--surface-2); color: var(--ink-muted); white-space: nowrap; }
.chip.ok { background: var(--accent-soft); color: var(--accent-strong); }
.chip.warn { background: var(--warn-soft); color: var(--warn); }
.chip.no { background: var(--reject-soft); color: var(--reject); }
.chip.busy { background: var(--blue-soft); color: var(--blue); }
.empty { color: var(--ink-faint); padding: 14px 10px; }

.detail { position: sticky; top: calc(var(--top) + 16px); max-height: calc(100vh - var(--top) - 32px); overflow-y: auto; padding: 16px; display: grid; gap: 14px; align-content: start; }
@media (max-width: 900px) { .detail { position: static; max-height: none; } }
.detail h2 { margin: 0; font-size: 18px; line-height: 1.3; overflow-wrap: anywhere; }
.detail h2 span { color: var(--ink-faint); font: 600 13px var(--mono); margin-right: 6px; }
.detail h3 { margin: 0 0 6px; font: 600 11px/1 var(--mono); letter-spacing: .07em; text-transform: uppercase; color: var(--ink-faint); }
.detail .text { white-space: pre-wrap; overflow-wrap: anywhere; }
.detail .muted, .muted { color: var(--ink-muted); }
.kv { display: grid; grid-template-columns: 6.5em minmax(0, 1fr); gap: 4px 10px; font-size: 13px; margin: 0; }
.kv dt { color: var(--ink-faint); } .kv dd { margin: 0; overflow-wrap: anywhere; }
.kv code, .detail code { font: 12px var(--mono); }
.verdict { border-left: 3px solid var(--line-strong); padding: 2px 0 2px 10px; display: grid; gap: 3px; margin-bottom: 8px; }
.verdict.yes { border-left-color: var(--accent); } .verdict.no { border-left-color: var(--reject); }
.verdict .by { font-size: 12px; color: var(--ink-faint); }
.verdict .note { white-space: pre-wrap; overflow-wrap: anywhere; font-size: 13px; }
.sentback { border: 1px solid color-mix(in srgb, var(--reject) 40%, var(--line)); background: color-mix(in srgb, var(--reject) 6%, var(--surface)); border-radius: 10px; padding: 10px 12px; }
.sentback h3 { color: var(--reject); }
.sentback .verdict { border-left: 0; padding: 0; margin: 0; }
.meta .why { flex-basis: 100%; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--reject); }
.hist { display: grid; gap: 2px; font-size: 12.5px; }
.hist div { display: grid; grid-template-columns: 4.2em minmax(0, 1fr); gap: 8px; }
.hist time, .feed time { color: var(--ink-faint); font: 12px var(--mono); }
.rowref { display: grid; grid-template-columns: auto minmax(0, 1fr); gap: 8px; font-size: 13px; padding: 3px 0; }
.rowref code { font-weight: 600; }
.links { display: flex; flex-wrap: wrap; gap: 6px; }
.links button { border: 1px solid var(--line); background: var(--surface-2); border-radius: 6px; padding: 3px 9px; cursor: pointer; font-size: 12.5px; }

.panel-form { display: grid; gap: 10px; }
.panel-form label, .inline label { display: grid; gap: 4px; font-size: 12px; color: var(--ink-muted); }
.panel-form input, .panel-form select, .inline input, .inline select { width: 100%; }
.inline { display: flex; flex-wrap: wrap; gap: 8px; align-items: end; padding: 10px; }
.inline label { flex: 1 1 150px; min-width: 0; }
.feed { padding: 6px 10px 10px; display: grid; }
.feed > div { display: grid; grid-template-columns: 4.6em minmax(0, 1fr); gap: 10px; padding: 7px 0; border-top: 1px solid var(--line); overflow-wrap: anywhere; }
.feed > div:first-child { border-top: 0; }
.feed button.ref { border: 0; background: none; padding: 0; color: var(--accent-strong); cursor: pointer; text-decoration: underline; text-underline-offset: 2px; }
.agent { display: grid; gap: 2px; padding: 7px 0; border-top: 1px solid var(--line); font-size: 13px; }
.agent:first-child { border-top: 0; }
.agent small { color: var(--ink-faint); font: 11.5px var(--mono); overflow-wrap: anywhere; }
.lane { display: flex; justify-content: space-between; gap: 8px; align-items: center; padding: 6px 0; border-top: 1px solid var(--line); font-size: 13px; }
.lane:first-child { border-top: 0; }
.rows { padding: 4px 10px 10px; }
.rows h4 { margin: 12px 0 4px; font-size: 12.5px; color: var(--ink-muted); }
.srow { display: grid; grid-template-columns: 4.4em 6.2em minmax(0, 1fr); gap: 8px; padding: 6px 4px; border-top: 1px solid var(--line); align-items: baseline; cursor: pointer; border-radius: 6px; }
.srow:hover { background: var(--surface-2); }
.srow.on { background: var(--accent-soft); }
.srow code { font: 600 12px var(--mono); }
.metrics { display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); gap: 10px; margin-bottom: 12px; }
.metric { background: var(--surface); border: 1px solid var(--line); border-radius: 12px; padding: 12px 14px; }
.metric b { display: block; font: 800 24px/1.1 var(--sans); font-variant-numeric: tabular-nums; }
.metric span { color: var(--ink-muted); font-size: 12.5px; }
.console { position: fixed; right: 16px; bottom: 16px; width: min(560px, calc(100vw - 32px)); background: var(--surface); border: 1px solid var(--line-strong); border-radius: 12px; box-shadow: var(--shadow); padding: 10px 12px; font: 12px/1.5 var(--mono); white-space: pre-wrap; overflow-wrap: anywhere; max-height: 38vh; overflow: auto; z-index: 20; cursor: pointer; }
.console.ok { border-color: var(--accent); } .console.no { border-color: var(--reject); }
</style>
</head>
<body>
<div class="shell">
<aside class="side" id="side" aria-label="Projects">
  <div class="side-top">
    <div class="brand"><svg viewBox="0 0 64 64" aria-hidden="true"><path fill="currentColor" d="M8 7h35a6 6 0 0 1 6 6v7H8a5 5 0 0 1-5-5v-3a5 5 0 0 1 5-5Z"/><rect width="56" height="14" x="3" y="25" fill="var(--accent)" rx="5"/><path fill="currentColor" d="M8 43h35a6 6 0 0 1 6 6v8H8a5 5 0 0 1-5-5v-4a5 5 0 0 1 5-5Z"/></svg><span>Pullboard</span></div>
    <button class="switch-btn" id="proj-switch" type="button" aria-expanded="false" aria-controls="side-body"><span id="proj-name">Projects</span><b class="need" id="proj-elsewhere" title="Needs you in other projects" hidden></b><small>▾</small></button>
  </div>
  <div class="side-body" id="side-body">
    <div class="label">Projects</div>
    <nav id="proj-list" aria-label="Projects on this machine"></nav>
    <details class="start"><summary>Start a board</summary><form id="init-form" class="panel-form"><label>Folder of a git repo<input id="init-path" required placeholder="/path/to/repo"></label><button class="go" type="submit">Init</button></form></details>
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
  <section data-pane="items" class="two">
    <div class="primary">
      <div class="card-panel toolbar"><input id="q" type="search" placeholder="Search items, ids or spec rows" aria-label="Search items"><select id="lane-filter" aria-label="Lane"><option value="">All lanes</option></select><button class="go" id="new-item" type="button">New item</button></div>
      <section class="needs-you" id="needs" aria-label="What needs you" hidden></section>
      <div class="chips" id="state-chips" aria-label="Filter by state"></div>
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
        <button class="go" type="submit">Add item</button>
      </form>
    </aside>
  </section>
  <section data-pane="shouts" class="two narrow">
    <div class="primary">
      <form id="shout-form" class="card-panel inline"><label>To<input id="shout-to" list="shout-targets" required placeholder="all, a lane or an agent"></label><datalist id="shout-targets"></datalist><label style="flex:4 1 260px">Message<input id="shout-text" required></label><button class="go" type="submit">Shout</button></form>
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
    <div class="metrics" id="metrics"></div>
    <div class="card-panel feed" id="activity"></div>
  </section>
</main>
</div>
</div>
<div class="console" id="console" title="Click to close" hidden></div>
<script>
const key = new URLSearchParams(location.search).get('k') || '';
const keep = (name, value) => { try { if (value === undefined) return localStorage.getItem(name); localStorage.setItem(name, value); } catch { return null; } return value; };
const view = { root: keep('pb.project'), tab: keep('pb.tab') || 'items', item: null, adding: false, state: 'active', rows: { spec: 'decide', doctrine: 'all' }, row: { spec: null, doctrine: null } };
let data = null;
let seen = '';
const $ = (id) => document.getElementById(id);
const esc = (text) => String(text ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const ago = (iso) => { const m = Math.round((Date.now() - Date.parse(iso)) / 60000); return m < 1 ? 'now' : m < 60 ? m + 'm' : m < 2880 ? Math.round(m / 60) + 'h' : Math.round(m / 1440) + 'd'; };
const clock = (iso) => new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
const when = (iso) => (new Date(iso).toDateString() === new Date().toDateString() ? '' : new Date(iso).toLocaleDateString([], { month: 'short', day: 'numeric' }) + ' ') + clock(iso);
const firstLine = (text) => String(text ?? '').split('\\n').map((line) => line.trim()).find(Boolean) || '';
// The latest verdict is a reject and no accept followed: open again, being reworked, resubmitted, or
// withdrawn after it.
const rejected = (i) => i.status !== 'verified' && !!i.verdict && i.verdict.decision === 'REJECT';
const verdictHtml = (v) => '<div class="verdict ' + (v.decision === 'ACCEPT' ? 'yes' : 'no') + '"><b>' + esc(v.decision) + ' ' + esc(v.reason) + '</b><span class="by">' + esc(v.by) + ' · ' + when(v.at) + ' · at ' + esc(String(v.commit || '').slice(0, 12)) + '</span><div class="note">' + esc(v.note) + '</div></div>';
const stateOf = (i) => i.status === 'claimed' ? 'building' : i.status === 'submitted' ? 'verify' : i.status === 'verified' ? 'verified' : i.status === 'withdrawn' ? 'withdrawn' : i.verdict && i.verdict.decision === 'REJECT' ? 'back' : 'open';
const STATES = { building: ['building', 'busy'], verify: ['to verify', 'warn'], back: ['sent back', 'no'], verified: ['verified', 'ok'], open: ['open', ''], withdrawn: ['withdrawn', ''] };
const chip = (s) => '<span class="chip ' + STATES[s][1] + '">' + STATES[s][0] + '</span>';
const tone = (s) => s === 'approved' ? 'ok' : s === 'pending' ? 'no' : s === 'draft' ? 'warn' : '';
const count = (n, one, many = one) => n + ' ' + (n === 1 ? one : many);
// What needs the person in a project, as its Needs-you list counts it: work sent back or waiting for a
// verdict, open questions, held lanes.
const needCount = (x) => x.ok ? x.sentBack + x.awaiting + x.pending + x.holds : 0;
const doing = (x) => [x.sentBack && count(x.sentBack, 'sent back'), x.awaiting && count(x.awaiting, 'to verify'), x.pending && count(x.pending, 'question', 'questions'), x.holds && count(x.holds, 'lane held', 'lanes held'), x.building && count(x.building, 'building')].filter(Boolean).join(' · ') || (x.open ? count(x.open, 'item open', 'items open') : 'nothing open');

async function api(path, body) {
  const res = await fetch(path, { method: body ? 'POST' : 'GET', headers: { 'x-pullboard-key': key, ...(body ? { 'content-type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const json = await res.json();
  if (!res.ok) throw new Error(json.error || res.status);
  return json;
}

async function refresh() {
  const root = view.root;
  const next = await api('/api/state' + (root ? '?root=' + encodeURIComponent(root) : ''));
  // The person switched projects while this answer was on its way: the switch's own refresh shows it.
  if (root !== view.root) return;
  if (!next.project && next.projects.some((p) => p.ok)) {
    view.root = next.projects.find((p) => p.ok).root;
    keep('pb.project', view.root);
    return refresh();
  }
  // Rebuild only when the board changed: a list rebuilt under the pointer can swallow a click.
  const text = JSON.stringify(next);
  if (text !== seen) {
    seen = text;
    data = next;
    render();
  }
  $('live').textContent = 'live · ' + new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' });
}

function render() {
  const p = data.project;
  // Every project stays in view with what needs the person there, so one look covers them all.
  $('proj-list').innerHTML = data.projects.length ? data.projects.map((x) => {
    const on = x.root === view.root;
    return '<button class="proj' + (on ? ' on' : '') + '"' + (on ? ' aria-current="true"' : '') + ' data-root="' + esc(x.root) + '" title="' + esc(x.root) + '" type="button"><span class="pname">' + esc(x.name) + '</span>' + (needCount(x) ? '<b class="need" title="needs you">' + needCount(x) + '</b>' : '') + (x.ok ? '<small>' + esc(doing(x)) : '<small class="bad">' + esc(x.error)) + '</small></button>';
  }).join('') : '<div class="empty">No projects yet: run pullboard init in a repo, or start one below.</div>';
  const elsewhere = data.projects.filter((x) => x.root !== view.root).reduce((n, x) => n + needCount(x), 0);
  $('proj-elsewhere').textContent = elsewhere ? elsewhere + ' elsewhere' : '';
  $('proj-elsewhere').hidden = !elsewhere;
  if (!p) { $('proj-name').textContent = 'No project'; return; }
  $('proj-name').textContent = (data.projects.find((x) => x.root === view.root) || { name: p.root.split('/').pop() }).name;
  const items = p.items.filter((i) => i.status !== 'withdrawn');
  const by = (s) => items.filter((i) => stateOf(i) === s);
  const active = items.filter((i) => stateOf(i) !== 'verified');
  $('count-items').textContent = active.length || '';
  $('count-shouts').textContent = p.shouts.length || '';
  $('count-spec').textContent = p.spec.filter((r) => ['pending', 'draft'].includes(r.status)).length || '';
  $('count-doctrine').textContent = p.practice.filter((r) => ['pending', 'draft'].includes(r.status)).length || '';

  // What needs the person, first: questions, work sent back, work waiting for a verdict, held lanes.
  const needs = [
    ...p.spec.filter((r) => r.status === 'pending').map((r) => ['spec:' + r.id, r.id, r.text, 'answer in SPEC.md']),
    ...by('back').map((i) => ['item:' + i.id, '#' + i.id, i.title, 'sent back: ' + i.verdict.reason]),
    ...by('verify').map((i) => ['item:' + i.id, '#' + i.id, i.title, (rejected(i) ? 'resubmitted after ' + i.verdict.reason : 'to verify') + ', ' + ago(i.updatedAt)]),
    ...p.holds.map((h) => ['tab:shouts', h.hold_lane, h.hold_reason, 'lane held']),
  ];
  const drafts = p.spec.filter((r) => r.status === 'draft').length;
  $('needs').hidden = !needs.length && !drafts;
  $('needs').innerHTML = '<div class="head"><i></i>Needs you</div>' + needs.slice(0, 6).map(([target, ref, text, what]) => '<button class="ny" data-go="' + esc(target) + '" type="button"><code>' + esc(ref) + '</code><span>' + esc(text) + '</span><em>' + esc(what) + ' →</em></button>').join('') + (needs.length > 6 ? '<div class="muted" style="padding:2px 4px">and ' + (needs.length - 6) + ' more</div>' : '') + (drafts ? '<button class="ny" data-go="tab:spec" type="button"><code>' + drafts + '</code><span>draft spec rows to approve or drop</span><em>review →</em></button>' : '');

  const lanes = p.lanes;
  const working = lanes.filter((l) => l !== 'coordinator');
  if ($('lane-filter').dataset.lanes !== lanes.join()) {
    const current = $('lane-filter').value;
    $('lane-filter').innerHTML = '<option value="">All lanes</option>' + lanes.map((l) => '<option>' + esc(l) + '</option>').join('');
    $('lane-filter').value = lanes.includes(current) ? current : '';
    $('lane-filter').dataset.lanes = lanes.join();
    $('add-lane').innerHTML = [...working, 'coordinator'].map((l) => '<option>' + esc(l) + '</option>').join('');
    $('hold-lane').innerHTML = working.map((l) => '<option>' + esc(l) + '</option>').join('');
  }
  const counts = { active: active.length, open: by('open').length, building: by('building').length, verify: by('verify').length, back: by('back').length, verified: by('verified').length, all: items.length };
  const names = { active: 'Active', open: 'Open', building: 'Building', verify: 'To verify', back: 'Sent back', verified: 'Verified', all: 'All' };
  $('state-chips').innerHTML = Object.keys(names).map((s) => '<button data-state="' + s + '" class="' + (view.state === s ? 'on' : '') + '" type="button">' + names[s] + '<b>' + counts[s] + '</b></button>').join('');
  const q = $('q').value.trim().toLowerCase();
  const lane = $('lane-filter').value;
  const shown = items
    .filter((i) => view.state === 'all' || (view.state === 'active' ? stateOf(i) !== 'verified' : stateOf(i) === view.state))
    .filter((i) => !lane || i.lane === lane)
    .filter((i) => !q || ('#' + i.id + ' ' + i.title + ' ' + i.specs.join(' ') + ' ' + (i.criterion || '')).toLowerCase().includes(q))
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  $('chain').innerHTML = shown.length ? shown.map((i) => {
    const s = stateOf(i);
    const who = s === 'building' ? i.owner : [i.builtBy, i.verifiedBy].filter(Boolean).join(' → ');
    return '<li class="row' + (view.item === i.id ? ' on' : '') + '" data-item="' + i.id + '"><span class="dot ' + s + '"></span><div><div class="t"><span>#' + i.id + '</span>' + esc(i.title) + '</div><div class="meta"><span>' + esc(i.lane) + '</span>' + (i.specs.length ? '<span>' + esc(i.specs.join(', ')) + '</span>' : '') + (who ? '<span>' + esc(who) + '</span>' : '') + (i.blockedBy.length && s === 'open' ? '<span>waits on #' + i.blockedBy.join(', #') + '</span>' : '') + '<span>' + ago(i.updatedAt) + '</span>' + (rejected(i) ? '<span class="why">' + esc(i.verdict.reason + ': ' + firstLine(i.verdict.note)) + '</span>' : '') + '</div></div>' + chip(s) + '</li>';
  }).join('') : '<li class="empty">' + (items.length ? 'No items match.' : 'No items yet. Add the first one with New item.') + '</li>';

  const item = p.items.find((i) => i.id === view.item);
  $('add-form').hidden = !(view.adding || !item);
  $('detail').hidden = !item || view.adding;
  if (item && !view.adding) {
    const s = stateOf(item);
    const cited = item.specs.map((id) => p.spec.find((r) => r.id === id) || { id, status: 'missing', text: '(not in SPEC.md)' });
    // Why it came back is the first thing the person reads; the verdicts before it stay below.
    const back = rejected(item);
    const earlier = back ? item.verdicts.slice(0, -1) : item.verdicts;
    $('detail').innerHTML = '<div style="display:grid;gap:14px"><div><h2><span>#' + item.id + '</span>' + esc(item.title) + '</h2><div class="meta" style="margin-top:6px">' + chip(s) + '<span class="chip">' + esc(item.lane) + '</span><span class="chip">' + esc(item.route) + '</span></div></div>'
      + (back ? '<div class="sentback"><h3>Sent back' + (s === 'building' ? ', being reworked' : s === 'verify' ? ', resubmitted' : s === 'withdrawn' ? ', then withdrawn' : '') + '</h3>' + verdictHtml(item.verdict) + '</div>' : '')
      + (item.criterion ? '<div><h3>Criterion</h3><div class="text">' + esc(item.criterion) + '</div></div>' : '')
      + (cited.length ? '<div><h3>Spec rows it serves</h3>' + cited.map((r) => '<div class="rowref"><code>' + esc(r.id) + '</code><div>' + esc(r.text) + ' <span class="chip ' + tone(r.status) + '">' + esc(r.status) + '</span></div></div>').join('') + '</div>' : '')
      + (item.brief ? '<div><h3>Brief</h3><div class="text muted">' + esc(item.brief) + '</div></div>' : '')
      + '<div><h3>People and commits</h3><dl class="kv">' + (item.owner && s === 'building' ? '<dt>holding</dt><dd>' + esc(item.owner) + '</dd>' : '') + (item.builtBy ? '<dt>built by</dt><dd>' + esc(item.builtBy) + '</dd>' : '') + (item.verifiedBy ? '<dt>verified by</dt><dd>' + esc(item.verifiedBy) + '</dd>' : '') + (item.commit ? '<dt>commit</dt><dd><code>' + esc(item.commit.slice(0, 12)) + '</code></dd>' : '') + (item.merged ? '<dt>merged</dt><dd><code>' + esc(item.merged.slice(0, 12)) + '</code></dd>' : '') + (item.blockedBy.length ? '<dt>waits on</dt><dd>' + item.blockedBy.map((id) => '#' + id).join(', ') + '</dd>' : '') + '</dl></div>'
      + (back && !earlier.length ? '' : '<div><h3>' + (back ? 'Earlier verdicts' : 'Verdicts') + '</h3>' + (earlier.length ? earlier.map(verdictHtml).join('') : '<div class="muted">None yet.</div>') + '</div>')
      + '<div><h3>History</h3><div class="hist">' + item.history.map((e) => '<div><time>' + clock(e.at) + '</time><span>' + esc(e.by) + ' ' + esc(e.kind) + '</span></div>').join('') + '</div></div>'
      + '<div class="links"><button data-shout="' + esc(item.lane) + '" data-about="' + item.id + '" type="button">Shout the ' + esc(item.lane) + ' lane about #' + item.id + '</button><button data-new type="button">New item</button></div></div>';
  }

  $('feed').innerHTML = p.shouts.length ? p.shouts.map((x) => '<div><time>' + clock(x.shout_at) + '</time><div><b>' + esc(x.shout_from) + ' → ' + esc(x.shout_to) + '</b> ' + esc(x.shout_text) + '</div></div>').join('') : '<div class="empty">No shouts yet.</div>';
  $('shout-targets').innerHTML = ['all', ...lanes, ...p.agents.map((a) => a.agent_id)].map((t) => '<option value="' + esc(t) + '">').join('');
  $('agents').innerHTML = p.agents.length ? p.agents.map((a) => '<div class="agent"><b>' + esc(a.agent_id) + '</b><span class="muted">' + esc(a.agent_lane) + ' lane · ' + esc(a.agent_route) + '</span><small>' + esc(a.agent_path) + '</small></div>').join('') : '<div class="empty">No agents yet.</div>';
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
    }).join('') : '<div class="empty">No rows match.</div>';
    const row = rows.find((r) => r.id === view.row[kind]);
    const citing = row ? p.items.filter((i) => i.specs.includes(row.id)) : [];
    $(kind + '-detail').innerHTML = row ? '<div style="display:grid;gap:12px"><h2><span>' + esc(row.id) + '</span>' + esc(row.text) + '</h2><div class="meta"><span class="chip ' + tone(row.status) + '">' + esc(row.status) + '</span>' + (row.tier ? '<span class="chip">' + esc(row.tier) + '</span>' : '') + '</div><dl class="kv"><dt>section</dt><dd>' + esc(row.section) + '</dd>' + (row.gate ? '<dt>gate</dt><dd>' + esc(row.gate) + '</dd>' : '') + (row.serves && row.serves.length ? '<dt>serves</dt><dd>' + esc(row.serves.join(', ')) + '</dd>' : '') + '</dl><div><h3>Items that cite it</h3>' + (citing.length ? '<div class="links">' + citing.map((i) => '<button data-go="item:' + i.id + '" type="button">#' + i.id + ' ' + esc(i.title) + '</button>').join('') + '</div>' : '<div class="muted">None yet.</div>') + '</div><div class="muted">Rows change in ' + (kind === 'spec' ? 'SPEC.md' : 'PRACTICE.md') + ', and only you approve them.</div></div>' : '<div class="empty">Pick a row to see it, and the items that cite it.</div>';
  }

  const verdicts = p.items.flatMap((i) => i.verdicts);
  $('metrics').innerHTML = [['verified by a second agent', by('verified').length], ['to verify', by('verify').length], ['building', by('building').length], ['rejections recorded', verdicts.filter((v) => v.decision === 'REJECT').length], ['agents', p.agents.length]].map(([label, value]) => '<div class="metric"><b>' + value + '</b><span>' + label + '</span></div>').join('');
  $('activity').innerHTML = p.events.length ? p.events.map((e) => '<div><time>' + clock(e.event_at) + '</time><div><b>' + esc(e.event_by) + '</b> ' + esc(e.event_kind) + (e.item_id ? ' <button class="ref" data-go="item:' + e.item_id + '" type="button">#' + e.item_id + '</button>' : '') + '</div></div>').join('') : '<div class="empty">No activity yet.</div>';
  showTab();
}

function showTab() {
  document.querySelectorAll('[data-pane]').forEach((pane) => { pane.hidden = pane.dataset.pane !== view.tab; });
  document.querySelectorAll('.tab').forEach((button) => button.classList.toggle('on', button.dataset.tab === view.tab));
}

function go(target) {
  const [kind, id] = target.split(':');
  if (kind === 'item') { view.tab = 'items'; view.item = Number(id); view.adding = false; view.state = 'all'; }
  else if (kind === 'spec') { view.tab = 'spec'; view.row.spec = id; view.rows.spec = 'all'; }
  else if (kind === 'tab') view.tab = id;
  keep('pb.tab', view.tab);
  render();
}

async function act(command, args, root = view.root) {
  const out = $('console');
  out.hidden = false;
  out.className = 'console';
  out.textContent = 'running…';
  try {
    const result = await api('/api/act', { root, command, args });
    out.className = 'console ' + (result.code === 0 ? 'ok' : 'no');
    out.textContent = '$ ' + result.command + '\\n' + (result.out + result.err).trim();
    await refresh();
    return result.code === 0;
  } catch (error) {
    out.className = 'console no';
    out.textContent = String(error.message || error);
    return false;
  }
}

/** Open or close the project list where the sidebar is folded into a top bar (under 900px). */
function fold(open) {
  $('side').classList.toggle('open', open);
  $('proj-switch').setAttribute('aria-expanded', String(open));
}

/** Show another project: mark it at once, dim the old one's panes until its board arrives. */
function switchTo(root) {
  view.root = root;
  view.item = null;
  view.adding = false;
  keep('pb.project', root);
  fold(false);
  if (data) render();
  document.body.classList.add('switching');
  refresh().catch(() => { $('live').textContent = 'offline: is pullboard view still running?'; }).finally(() => document.body.classList.remove('switching'));
}

document.addEventListener('click', (event) => {
  const t = event.target.closest('[data-root],[data-tab],[data-go],[data-item],[data-state],[data-rows],[data-row],[data-release],[data-shout],[data-new],#proj-switch,#console');
  if (!event.target.closest('.side')) fold(false);
  if (!t) return;
  if (t.id === 'proj-switch') { fold(!$('side').classList.contains('open')); return; }
  if (t.id === 'console') { t.hidden = true; return; }
  if (t.dataset.root) switchTo(t.dataset.root);
  else if (t.dataset.tab) { view.tab = t.dataset.tab; keep('pb.tab', view.tab); showTab(); }
  else if (t.dataset.go) go(t.dataset.go);
  else if (t.dataset.item) { view.item = Number(t.dataset.item); view.adding = false; render(); }
  else if (t.dataset.state) { view.state = t.dataset.state; render(); }
  else if (t.dataset.rows) { const [kind, f] = t.dataset.rows.split(':'); view.rows[kind] = f; render(); }
  else if (t.dataset.row) { const [kind, id] = t.dataset.row.split(':'); view.row[kind] = id; render(); }
  else if (t.dataset.release) act('release', { lane: t.dataset.release });
  else if (t.dataset.shout) { $('shout-to').value = t.dataset.shout; $('shout-text').value = '#' + t.dataset.about + ': '; view.tab = 'shouts'; showTab(); $('shout-text').focus(); }
  else if (t.dataset.new !== undefined) { view.adding = true; render(); $('add-title').focus(); }
});
$('new-item').addEventListener('click', () => { view.adding = true; view.item = null; render(); $('add-title').focus(); });
$('q').addEventListener('input', () => render());
$('lane-filter').addEventListener('change', () => render());
$('add-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  if (await act('add', { lane: $('add-lane').value, title: $('add-title').value, criterion: $('add-criterion').value, specs: $('add-specs').value })) {
    $('add-title').value = '';
    $('add-criterion').value = '';
    $('add-specs').value = '';
  }
});
$('shout-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  if (await act('shout', { to: $('shout-to').value, text: $('shout-text').value })) $('shout-text').value = '';
});
$('hold-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  if (await act('hold', { lane: $('hold-lane').value, reason: $('hold-reason').value })) $('hold-reason').value = '';
});
$('init-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  if (await act('init', { path: $('init-path').value }, null)) $('init-path').value = '';
});
showTab();
refresh().catch((error) => { $('live').textContent = 'cannot reach the view: ' + error.message; });
setInterval(() => { if (!document.hidden) refresh().catch(() => { $('live').textContent = 'offline: is pullboard view still running?'; }); }, 3000);
</script>
</body>
</html>`;
}
