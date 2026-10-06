/**
 * The page `pullboard view` serves (N26): one self-contained file, no assets from anywhere, that
 * reads the board through the server's JSON and refreshes itself. Forms post actions that the server
 * runs as CLI commands (N27), so the page never decides a rule itself.
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
  --sans: system-ui, -apple-system, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
  --mono: ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, monospace;
  color-scheme: light;
}
@media (prefers-color-scheme: dark) { :root {
  --ground: #0c110f; --surface: #121815; --surface-2: #171f1b; --line: #232e29; --line-strong: #34423b;
  --ink: #e7ece9; --ink-muted: #9caba3; --ink-faint: #6a776f;
  --accent: #34d89e; --accent-strong: #4ee3ac; --accent-soft: #10231c; --on-accent: #05201a;
  --warn: #e4b25a; --warn-soft: #241d10; --reject: #f0776b; --reject-soft: #271613;
  --blue: #6ba7d6; --blue-soft: #142231; color-scheme: dark; } }
* { box-sizing: border-box; }
body { margin: 0; background: var(--ground); color: var(--ink); font: 14px/1.5 var(--sans); }
button, input, select, textarea { font: inherit; color: inherit; }
.app { display: grid; grid-template-columns: 250px minmax(0, 1fr); min-height: 100vh; }
@media (max-width: 760px) { .app { grid-template-columns: minmax(0, 1fr); } }
aside { background: var(--surface); border-right: 1px solid var(--line); padding: 16px; display: grid; gap: 14px; align-content: start; }
.brand { display: flex; align-items: center; gap: 9px; font-weight: 700; font-size: 16px; }
.brand svg { width: 22px; height: 22px; }
.label { font: 600 11px/1 var(--mono); letter-spacing: .07em; text-transform: uppercase; color: var(--ink-faint); }
.projects { display: grid; gap: 4px; }
.project { text-align: left; border: 1px solid transparent; background: none; border-radius: 8px; padding: 8px 10px; cursor: pointer; display: grid; gap: 3px; }
.project:hover { background: var(--surface-2); }
.project.on { background: var(--accent-soft); border-color: var(--accent); }
.project b { font-size: 14px; overflow-wrap: anywhere; }
.project small { color: var(--ink-faint); font-size: 12px; }
.project .bad { color: var(--reject); }
main { padding: 18px clamp(14px, 3vw, 28px) 40px; min-width: 0; display: grid; gap: 16px; align-content: start; }
header.head { display: flex; flex-wrap: wrap; gap: 8px 16px; align-items: baseline; }
header.head h1 { margin: 0; font-size: 22px; letter-spacing: -.01em; }
header.head code { color: var(--ink-faint); font: 12px var(--mono); overflow-wrap: anywhere; }
header.head .live { margin-left: auto; font-size: 12px; color: var(--ink-faint); }
.tabs { display: flex; gap: 4px; flex-wrap: wrap; border-bottom: 1px solid var(--line); }
.tab { border: 0; background: none; padding: 8px 12px; cursor: pointer; color: var(--ink-muted); border-bottom: 2px solid transparent; margin-bottom: -1px; }
.tab.on { color: var(--ink); border-bottom-color: var(--accent); font-weight: 600; }
.needs { display: flex; flex-wrap: wrap; gap: 8px; }
.need { border: 1px solid var(--line); background: var(--surface); border-radius: 999px; padding: 6px 12px; cursor: pointer; }
.need b { margin-right: 4px; }
.need.hot { border-color: var(--warn); background: var(--warn-soft); }
.columns { display: grid; grid-template-columns: repeat(5, minmax(0, 1fr)); gap: 10px; align-items: start; }
@media (max-width: 1100px) { .columns { grid-template-columns: repeat(2, minmax(0, 1fr)); } }
@media (max-width: 560px) { .columns { grid-template-columns: minmax(0, 1fr); } }
.col { background: var(--surface-2); border: 1px solid var(--line); border-radius: 10px; padding: 8px; display: grid; gap: 8px; align-content: start; min-width: 0; }
.col h3 { margin: 2px 4px; font: 600 11.5px/1 var(--mono); letter-spacing: .06em; text-transform: uppercase; color: var(--ink-faint); display: flex; justify-content: space-between; }
.card { background: var(--surface); border: 1px solid var(--line); border-radius: 8px; padding: 9px 10px; display: grid; gap: 5px; cursor: pointer; min-width: 0; }
.card:hover { border-color: var(--line-strong); }
.card .t { font-weight: 600; line-height: 1.3; overflow-wrap: anywhere; }
.card .t span { color: var(--ink-faint); font: 500 12px var(--mono); margin-right: 4px; }
.meta { display: flex; flex-wrap: wrap; gap: 4px 6px; align-items: center; color: var(--ink-muted); font-size: 12px; }
.chip { font: 600 10.5px/1 var(--mono); letter-spacing: .03em; padding: 3px 5px; border-radius: 4px; background: var(--surface-2); color: var(--ink-muted); white-space: nowrap; }
.chip.ok { background: var(--accent-soft); color: var(--accent-strong); }
.chip.warn { background: var(--warn-soft); color: var(--warn); }
.chip.no { background: var(--reject-soft); color: var(--reject); }
.chip.busy { background: var(--blue-soft); color: var(--blue); }
.more { display: none; border-top: 1px dashed var(--line); padding-top: 6px; color: var(--ink-muted); font-size: 12.5px; overflow-wrap: anywhere; white-space: pre-wrap; }
.card.open .more { display: grid; gap: 6px; }
.panel { background: var(--surface); border: 1px solid var(--line); border-radius: 10px; padding: 14px; min-width: 0; }
.list { display: grid; gap: 0; }
.list .row { display: grid; grid-template-columns: 7.5em minmax(0, 1fr); gap: 10px; padding: 7px 0; border-top: 1px solid var(--line); overflow-wrap: anywhere; }
.list .row:first-child { border-top: 0; }
.list time { color: var(--ink-faint); font: 12px var(--mono); }
.rows h4 { margin: 14px 0 6px; font-size: 13px; color: var(--ink-muted); }
.rows .r { display: grid; grid-template-columns: 4.5em 5.5em minmax(0, 1fr); gap: 8px; padding: 5px 0; border-top: 1px solid var(--line); align-items: baseline; }
.rows .r code { font: 600 12px var(--mono); }
.rows .r small { display: block; color: var(--ink-faint); font: 11.5px var(--mono); }
.filters { display: flex; gap: 6px; flex-wrap: wrap; }
.filters button { border: 1px solid var(--line); background: var(--surface); border-radius: 999px; padding: 4px 10px; cursor: pointer; }
.filters button.on { border-color: var(--accent); background: var(--accent-soft); }
form { display: flex; flex-wrap: wrap; gap: 8px; align-items: end; }
form label { display: grid; gap: 3px; font-size: 12px; color: var(--ink-muted); flex: 1 1 140px; min-width: 0; }
input, select { border: 1px solid var(--line-strong); background: var(--surface); border-radius: 7px; padding: 7px 9px; min-width: 0; width: 100%; }
.go { border: 0; background: var(--ink); color: var(--surface); border-radius: 7px; padding: 8px 14px; cursor: pointer; font-weight: 600; }
.go:hover { background: var(--accent-strong); color: var(--on-accent); }
.small { border: 1px solid var(--line-strong); background: var(--surface); border-radius: 7px; padding: 4px 9px; cursor: pointer; }
table { border-collapse: collapse; width: 100%; font-size: 13px; }
td, th { text-align: left; padding: 7px 8px; border-top: 1px solid var(--line); vertical-align: top; overflow-wrap: anywhere; }
th { font: 600 11px var(--mono); text-transform: uppercase; letter-spacing: .05em; color: var(--ink-faint); border-top: 0; }
.scroll { overflow-x: auto; }
.console { position: sticky; bottom: 0; background: var(--surface); border: 1px solid var(--line-strong); border-radius: 10px; padding: 10px 12px; font: 12px/1.5 var(--mono); white-space: pre-wrap; overflow-wrap: anywhere; max-height: 30vh; overflow: auto; }
.console.ok { border-color: var(--accent); }
.console.no { border-color: var(--reject); }
.empty { color: var(--ink-faint); padding: 8px 4px; }
:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
</style>
</head>
<body>
<div class="app">
  <aside>
    <div class="brand"><svg viewBox="0 0 64 64" aria-hidden="true"><path fill="currentColor" d="M8 7h35a6 6 0 0 1 6 6v7H8a5 5 0 0 1-5-5v-3a5 5 0 0 1 5-5Z"/><rect width="56" height="14" x="3" y="25" fill="var(--accent)" rx="5"/><path fill="currentColor" d="M8 43h35a6 6 0 0 1 6 6v8H8a5 5 0 0 1-5-5v-4a5 5 0 0 1 5-5Z"/></svg>Pullboard</div>
    <div class="label">Projects on this machine</div>
    <div class="projects" id="projects"><div class="empty">Loading…</div></div>
    <div class="label">Start a board</div>
    <form id="init-form"><label>Folder of a git repo<input id="init-path" placeholder="/path/to/repo" required></label><button class="go" type="submit">Init</button></form>
  </aside>
  <main>
    <header class="head"><h1 id="name">Pullboard</h1><code id="root"></code><span class="live" id="live"></span></header>
    <div class="needs" id="needs"></div>
    <nav class="tabs" id="tabs">
      <button class="tab" data-tab="board">Board</button><button class="tab" data-tab="doctrine">Doctrine</button><button class="tab" data-tab="shouts">Shouts</button><button class="tab" data-tab="fleet">Agents</button><button class="tab" data-tab="activity">Activity</button>
    </nav>
    <section data-pane="board">
      <div class="panel"><form id="add-form"><label>Lane<select id="add-lane"></select></label><label style="flex:3 1 220px">Title<input id="add-title" required placeholder="What to build"></label><label style="flex:3 1 220px">Criterion<input id="add-criterion" placeholder="How a verifier knows it's done"></label><label>Spec rows<input id="add-specs" placeholder="G1,G2"></label><button class="go" type="submit">Add item</button></form></div>
      <div class="columns" id="columns" style="margin-top:12px"></div>
    </section>
    <section data-pane="doctrine" class="panel"><div class="filters" id="row-filters"><button data-f="all">All rows</button><button data-f="decide">Needs your decision</button><button data-f="approved">Approved</button></div><div class="rows" id="rows"></div></section>
    <section data-pane="shouts" class="panel"><form id="shout-form"><label>To<input id="shout-to" list="shout-targets" required placeholder="all, a lane or an agent"></label><datalist id="shout-targets"></datalist><label style="flex:4 1 280px">Message<input id="shout-text" required></label><button class="go" type="submit">Shout</button></form><div class="list" id="shouts" style="margin-top:10px"></div></section>
    <section data-pane="fleet" class="panel"><form id="hold-form"><label>Lane<select id="hold-lane"></select></label><label style="flex:4 1 260px">Why hold it<input id="hold-reason" required placeholder="What the agents in it should wait for"></label><button class="go" type="submit">Hold lane</button></form><div class="scroll" style="margin-top:12px"><table><thead><tr><th>Lane</th><th>State</th><th></th></tr></thead><tbody id="lanes"></tbody></table></div><div class="scroll" style="margin-top:14px"><table><thead><tr><th>Agent</th><th>Lane</th><th>Route</th><th>Worktree</th></tr></thead><tbody id="agents"></tbody></table></div></section>
    <section data-pane="activity" class="panel"><div class="list" id="events"></div></section>
    <div class="console" id="console" hidden></div>
  </main>
</div>
<script>
const key = new URLSearchParams(location.search).get('k') || '';
const keep = (name, value) => { try { if (value === undefined) return localStorage.getItem(name); localStorage.setItem(name, value); } catch { return null; } return value; };
let selected = keep('pb.project');
let tab = keep('pb.tab') || 'board';
let rowFilter = 'decide';
let state = null;
const opened = new Set();
const $ = (id) => document.getElementById(id);
const esc = (text) => String(text ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const ago = (iso) => { const m = Math.round((Date.now() - Date.parse(iso)) / 60000); return m < 1 ? 'now' : m < 60 ? m + 'm' : m < 2880 ? Math.round(m / 60) + 'h' : Math.round(m / 1440) + 'd'; };
const clock = (iso) => new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

async function api(path, body) {
  const res = await fetch(path, { method: body ? 'POST' : 'GET', headers: { 'x-pullboard-key': key, ...(body ? { 'content-type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || res.status);
  return data;
}

async function refresh() {
  const data = await api('/api/state' + (selected ? '?root=' + encodeURIComponent(selected) : ''));
  if ((!selected || !data.project) && data.projects.some((p) => p.ok)) {
    const first = data.projects.find((p) => p.ok && (!selected || p.root === selected)) || data.projects.find((p) => p.ok);
    if (first.root !== selected || !data.project) { selected = first.root; keep('pb.project', selected); return refresh(); }
  }
  state = data;
  render();
  $('live').textContent = 'live · updated ' + new Date().toLocaleTimeString();
}

function render() {
  $('projects').innerHTML = state.projects.length ? state.projects.map((p) => '<button class="project' + (p.root === selected ? ' on' : '') + '" data-root="' + esc(p.root) + '"><b>' + esc(p.name) + '</b>' + (p.ok
    ? '<small>' + p.building + ' building · ' + p.awaiting + ' to verify · ' + p.verified + ' verified' + (p.pending ? ' · ' + p.pending + ' questions' : '') + '</small>'
    : '<small class="bad">' + esc(p.error) + '</small>') + '</button>').join('') : '<div class="empty">No projects yet. Run pullboard init in a repo, or start one below.</div>';
  const project = state.project;
  if (!project) { $('name').textContent = 'Pullboard'; return; }
  $('name').textContent = project.root.split('/').pop();
  $('root').textContent = project.root;
  const items = project.items;
  const sentBack = items.filter((i) => i.status === 'open' && i.verdict && i.verdict.decision === 'REJECT');
  const awaiting = items.filter((i) => i.status === 'submitted');
  const questions = project.spec.filter((r) => r.status === 'pending');
  const drafts = project.spec.filter((r) => r.status === 'draft');
  $('needs').innerHTML = [
    questions.length ? '<button class="need hot" data-go="doctrine"><b>' + questions.length + '</b>questions for you</button>' : '',
    drafts.length ? '<button class="need" data-go="doctrine"><b>' + drafts.length + '</b>draft rows to approve</button>' : '',
    awaiting.length ? '<button class="need" data-go="board"><b>' + awaiting.length + '</b>awaiting a verdict</button>' : '',
    sentBack.length ? '<button class="need" data-go="board"><b>' + sentBack.length + '</b>sent back for rework</button>' : '',
    project.holds.length ? '<button class="need hot" data-go="fleet"><b>' + project.holds.length + '</b>lanes held</button>' : '',
  ].join('');
  const lanes = project.lanes;
  if ($('add-lane').dataset.lanes !== lanes.join()) {
    $('add-lane').innerHTML = lanes.map((l) => '<option>' + esc(l) + '</option>').join('');
    $('add-lane').dataset.lanes = lanes.join();
  }
  $('shout-targets').innerHTML = ['all', ...lanes, ...project.agents.map((a) => a.agent_id)].map((t) => '<option value="' + esc(t) + '">').join('');
  const holdable = lanes.filter((l) => l !== 'coordinator');
  if ($('hold-lane').dataset.lanes !== holdable.join()) {
    $('hold-lane').innerHTML = holdable.map((l) => '<option>' + esc(l) + '</option>').join('');
    $('hold-lane').dataset.lanes = holdable.join();
  }
  const card = (i) => {
    const v = i.verdict;
    const chip = i.status === 'verified' ? '<span class="chip ok">verified</span>' : i.status === 'submitted' ? '<span class="chip warn">to verify</span>' : i.status === 'claimed' ? '<span class="chip busy">building</span>' : v && v.decision === 'REJECT' ? '<span class="chip no">sent back</span>' : i.blockedBy.length ? '<span class="chip">waits on #' + i.blockedBy.join(', #') + '</span>' : '<span class="chip">ready</span>';
    const who = i.status === 'claimed' ? i.owner : [i.builtBy, i.verifiedBy].filter(Boolean).join(' → ');
    return '<div class="card' + (opened.has(i.id) ? ' open' : '') + '" data-item="' + i.id + '"><div class="t"><span>#' + i.id + '</span>' + esc(i.title) + '</div><div class="meta">' + chip + '<span class="chip">' + esc(i.lane) + '</span>' + i.specs.map((s) => '<span class="chip">' + esc(s) + '</span>').join('') + (who ? '<span>' + esc(who) + '</span>' : '') + '<span>' + ago(i.updatedAt) + '</span></div><div class="more">' + (i.criterion ? '<div><b>Criterion.</b> ' + esc(i.criterion) + '</div>' : '') + (v ? '<div><b>' + esc(v.decision) + ' ' + esc(v.reason) + '</b> by ' + esc(v.by) + ', ' + clock(v.at) + ': ' + esc(v.note) + '</div>' : '') + (i.commit ? '<div>commit ' + esc(i.commit.slice(0, 12)) + (i.merged ? ' · merged ' + esc(i.merged.slice(0, 12)) : '') + '</div>' : '') + '</div></div>';
  };
  const col = (title, list) => '<div class="col"><h3><span>' + title + '</span><span>' + list.length + '</span></h3>' + (list.length ? list.map(card).join('') : '<div class="empty">Nothing here.</div>') + '</div>';
  const open = items.filter((i) => i.status === 'open' && !(i.verdict && i.verdict.decision === 'REJECT'));
  const verified = items.filter((i) => i.status === 'verified').sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).slice(0, 15);
  $('columns').innerHTML = col('Open', open) + col('Building', items.filter((i) => i.status === 'claimed')) + col('To verify', awaiting) + col('Sent back', sentBack) + col('Verified', verified);
  const rowList = (title, rows) => {
    const shown = rows.filter((r) => rowFilter === 'all' || (rowFilter === 'decide' ? ['pending', 'draft'].includes(r.status) : r.status === 'approved'));
    if (!shown.length) return '<h4>' + title + '</h4><div class="empty">No rows match.</div>';
    const tone = (s) => s === 'approved' ? 'ok' : s === 'pending' ? 'no' : s === 'draft' ? 'warn' : '';
    return '<h4>' + title + '</h4>' + shown.map((r) => '<div class="r"><code>' + esc(r.id) + '</code><span><span class="chip ' + tone(r.status) + '">' + esc(r.status) + '</span></span><div>' + esc(r.text) + '<small>' + esc(r.section) + (r.gate ? ' · gate: ' + esc(r.gate) : '') + '</small></div></div>').join('');
  };
  $('rows').innerHTML = rowList('Spec: what to build', project.spec) + rowList('Practice: how it is built', project.practice);
  $('shouts').innerHTML = project.shouts.length ? project.shouts.map((s) => '<div class="row"><time>' + clock(s.shout_at) + '</time><div><b>' + esc(s.shout_from) + ' → ' + esc(s.shout_to) + '</b> ' + esc(s.shout_text) + '</div></div>').join('') : '<div class="empty">No shouts yet.</div>';
  const held = new Map(project.holds.map((h) => [h.hold_lane, h]));
  $('lanes').innerHTML = lanes.filter((l) => l !== 'coordinator').map((l) => '<tr><td><b>' + esc(l) + '</b></td><td>' + (held.has(l) ? '<span class="chip no">held</span> ' + esc(held.get(l).hold_reason) : '<span class="chip ok">open</span>') + '</td><td>' + (held.has(l) ? '<button class="small" data-release="' + esc(l) + '">Release</button>' : '') + '</td></tr>').join('');
  $('agents').innerHTML = project.agents.map((a) => '<tr><td><b>' + esc(a.agent_id) + '</b></td><td>' + esc(a.agent_lane) + '</td><td>' + esc(a.agent_route) + '</td><td><code>' + esc(a.agent_path) + '</code></td></tr>').join('');
  $('events').innerHTML = project.events.map((e) => '<div class="row"><time>' + clock(e.event_at) + '</time><div><b>' + esc(e.event_by) + '</b> ' + esc(e.event_kind) + (e.item_id ? ' #' + e.item_id : '') + '</div></div>').join('') || '<div class="empty">No activity yet.</div>';
  showTab();
}

function showTab() {
  document.querySelectorAll('[data-pane]').forEach((pane) => { pane.hidden = pane.dataset.pane !== tab; });
  document.querySelectorAll('.tab').forEach((button) => button.classList.toggle('on', button.dataset.tab === tab));
  document.querySelectorAll('#row-filters button').forEach((button) => button.classList.toggle('on', button.dataset.f === rowFilter));
}

async function act(command, args, root = selected) {
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

document.addEventListener('click', (event) => {
  const target = event.target.closest('[data-root],[data-tab],[data-go],[data-item],[data-f],[data-release]');
  if (!target) return;
  if (target.dataset.root) { selected = target.dataset.root; keep('pb.project', selected); refresh(); }
  else if (target.dataset.tab || target.dataset.go) { tab = target.dataset.tab || target.dataset.go; keep('pb.tab', tab); showTab(); }
  else if (target.dataset.item) { const id = Number(target.dataset.item); opened.has(id) ? opened.delete(id) : opened.add(id); target.classList.toggle('open'); }
  else if (target.dataset.f) { rowFilter = target.dataset.f; render(); }
  else if (target.dataset.release) act('release', { lane: target.dataset.release });
});
$('add-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  if (await act('add', { lane: $('add-lane').value, title: $('add-title').value, criterion: $('add-criterion').value, specs: $('add-specs').value })) { $('add-title').value = ''; $('add-criterion').value = ''; }
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
