import { sharingPresentation } from './view/sharing-invitation.js';
import {
  hostedReleaseDistance,
  hostedReleaseInfo,
  hostedReleaseNote,
} from './view/hosted-release.js';
import {
  effectiveGuards,
  IN_STATE,
  MACHINE,
} from './machine.js';
import {
  STAR_KEY,
  starMarkup,
} from './view/star.js';
import { commandPhrases } from './help.js';
import { personNeeds } from './needs.js';
import { homeRules } from './view/home.js';
import {
  drawHosted,
  hostedBrowser,
  hostedMarkup,
  hostedState,
} from './view/hosted.js';
import { staleChip } from './view/stale.js';
import {
  pageStartup,
  tabValue,
} from './view/page-startup.js';
import {
  roadmapHeaders,
  roadmapSummary,
} from './view/roadmap-summary.js';
import { roadmapBlock } from './view/roadmap-block.js';
import { openPageDialog } from './view/page-dialog.js';
import { closePageDialog } from './view/page-dialog.js';
import { applyStateDelta } from './api-http.js';
import { pageScriptPart1 } from './view/page-script-1.js';
import { pageScriptPart2 } from './view/page-script-2.js';
import { pageScriptPart3 } from './view/page-script-3.js';
import { pageScriptPart4 } from './view/page-script-4.js';
import { settingsMarkup } from './view/settings-page.js';
import { settingsPageScript } from './view/settings-page.js';
import { agentApprovalScript } from './view/agent-approval.js';
import { historyLoadingScript } from './view/history-loading.js';
/** The CLI's default phrases, ordered by depth for the existing prose inventory guard. */
export const PULLBOARD_COMMANDS = Object.freeze(commandPhrases().sort((left, right) => right.split(' ').length - left.split(' ').length));
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
 * reads the board through the server's JSON and follows its events. The layout is the one the person
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
 * The hosted page at https://app.pullboard.dev passes hostedLocal (N26, #513): on this machine it reads the local view
 * and any linked relay boards through their own transports; local boards are writable, relay boards remain read-only.
 * On another device it uses the relay when relaySession says the request has a session, and otherwise explains how to
 * connect or sign in.
 *
 * @param {string} [key] - The session's secret.
 * @param {{snapshot?: boolean, readOnly?: boolean, requests?: boolean, transportModule?: string|null, apiBase?: string, apiHeaders?: Record<string, string>, stylesheet?: string, paths?: boolean, hostedLocal?: boolean, relaySession?: boolean, signIn?: string|null, hostedReleaseVersion?: string, hostedReleaseVersions?: string[]|null}} [options] - Served connection and assets, optional person requests over a read-only transport, host routes, a static page with event replay, or the hosted page that reads this machine's view first.
 * @returns {string}
 */
export function cockpitPage(key = '', { snapshot = false, readOnly = false, requests = false, transportModule = null, apiBase = '', apiHeaders = { 'x-pullboard-key': key }, stylesheet = null, paths = false, hostedLocal = false, relaySession = false, signIn = null, hostedReleaseVersion, hostedReleaseVersions = null } = {}) {
  // Derive the current CLI inventory for every served, relay or exported page.
  const COMMAND_SOURCE = 'pullboard (?:' + commandPhrases().join('|') + ')(?![\\w-])(?: (?:--?[\\w-]+|\\d+|#\\d+|"[^"\\n]*"|[A-Z][A-Z0-9_]*|[\\w-]*[\\/.:@][^\\s"]*|[a-z]+-\\d+)(?![\\w-]))*';

  if (transportModule !== null && (typeof transportModule !== 'string' || !transportModule.trim())) throw new TypeError('transportModule must be a non-empty module URL or null');
  const connection = JSON.stringify(transportModule ? { base: '', headers: {} } : { base: apiBase.replace(/\/$/, ''), headers: apiHeaders }).replace(/</g, '\\u003c');
  const moduleOption = JSON.stringify(transportModule).replace(/</g, '\\u003c');
  const requestMode = Boolean(readOnly && requests && !snapshot && transportModule);
  if (signIn !== null && (typeof signIn !== 'string' || !signIn.startsWith('/') || signIn.startsWith('//'))) throw new TypeError('signIn must be a path on the hosting site, or null');
  const hostedOptions = JSON.stringify({ local: Boolean(hostedLocal) && !snapshot, relaySession: Boolean(relaySession), signIn }).replace(/</g, '\\u003c');
  const releaseHosted = Boolean(hostedLocal) && !snapshot;
  const releaseInfo = hostedReleaseInfo(hostedReleaseVersion, hostedReleaseVersions, releaseHosted);
  const css = stylesheet ?? (snapshot ? 'view.css' : transportModule ? '/view.css' : '/view.css?k=' + encodeURIComponent(key));
  const cssAttribute = css.replace(/[&<>"']/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]);
  const pageScope = { STAR_KEY, applyStateDelta, closePageDialog, connection, drawHosted, hostedBrowser, hostedOptions, hostedReleaseDistance, hostedReleaseNote, homeRules, hostedState, lifecycle, moduleOption, openPageDialog, pageStartup, paths, personNeeds, readOnly, releaseHosted, releaseInfo, requestMode, roadmapBlock, roadmapHeaders, roadmapSummary, sharingPresentation, snapshot, staleChip, tabValue, transportModule };
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Pullboard</title>
<link rel="stylesheet" href="${cssAttribute}">
<link rel="icon" href="data:,">
</head>
<body class="loading${hostedLocal && !snapshot ? ' hosted-page open-board' : ''}${snapshot ? ' snapshot' : ''}${readOnly ? ' read-only' : ''}${requestMode ? ' requests' : ''}">
${hostedLocal && !snapshot ? '<div class="hosted-mark" aria-hidden="true"><svg viewBox="0 0 64 64" aria-hidden="true"><path fill="currentColor" d="M8 7h35a6 6 0 0 1 6 6v7H8a5 5 0 0 1-5-5v-3a5 5 0 0 1 5-5Z"/><rect width="56" height="14" x="3" y="25" fill="var(--accent)" rx="5"/><path fill="currentColor" d="M8 43h35a6 6 0 0 1 6 6v8H8a5 5 0 0 1-5-5v-4a5 5 0 0 1 5-5Z"/></svg></div>' : ''}
<div class="shell">
<aside class="side" id="side" aria-label="Projects">
  <div class="side-top">
    <button class="brand" id="side-toggle" type="button" aria-pressed="false" aria-controls="side-body" aria-label="Collapse the project list" title="Collapse the project list"><svg viewBox="0 0 64 64" aria-hidden="true"><path fill="currentColor" d="M8 7h35a6 6 0 0 1 6 6v7H8a5 5 0 0 1-5-5v-3a5 5 0 0 1 5-5Z"/><rect width="56" height="14" x="3" y="25" fill="var(--accent)" rx="5"/><path fill="currentColor" d="M8 43h35a6 6 0 0 1 6 6v8H8a5 5 0 0 1-5-5v-4a5 5 0 0 1 5-5Z"/></svg><span>Pullboard</span></button>
    <button class="switch-btn" id="proj-switch" type="button" aria-expanded="false" aria-controls="side-body"><span id="proj-name">Projects</span><small aria-hidden="true"><svg viewBox="0 0 16 16"><path d="M4 6l4 4 4-4" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"/></svg></small></button>
    <button class="theme-btn" id="theme" type="button" title="Theme: system"><svg class="sys" viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="8" r="6" fill="none" stroke="currentColor" stroke-width="1.5"/><path fill="currentColor" d="M8 2a6 6 0 0 1 0 12Z"/></svg><svg class="sun" viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="8" r="3" fill="none" stroke="currentColor" stroke-width="1.5"/><path fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" d="M8 1.5v1.2M8 13.3v1.2M1.5 8h1.2M13.3 8h1.2M3.4 3.4l.85.85M11.75 11.75l.85.85M3.4 12.6l.85-.85M11.75 4.25l.85-.85"/></svg><svg class="moon" viewBox="0 0 16 16" aria-hidden="true"><path fill="none" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round" d="M13.6 9.6A6 6 0 1 1 6.4 2.4a5.2 5.2 0 0 0 7.2 7.2Z"/></svg></button>
  </div>
  <div class="side-body" id="side-body">
    <button class="ghost" data-tab="settings" type="button">Settings</button>
    <div class="label">Projects</div>
    <nav id="proj-list" aria-label="Projects on this machine"></nav>
    <button class="share-again" id="share-again" type="button" hidden>Link boards to pullboard.dev&hellip;</button>
    <section class="products" id="products" aria-label="Products" hidden><div class="label">Products</div><div id="prod-list"></div></section>
  </div>
</aside>
<div class="body">
<header class="top">
  <nav class="tabs" id="tabs" aria-label="Board">
    <button class="tab" data-tab="home" type="button">Home</button>
    <button class="tab" data-tab="items" type="button">Items</button>
    <button class="tab" data-tab="shouts" type="button">Shouts</button>
    <button class="tab" data-tab="spec" type="button">Spec</button>
    <button class="tab" data-tab="doctrine" type="button">Doctrine</button>
    <button class="tab" data-tab="activity" type="button">Activity</button>
    <button class="tab" data-tab="roadmap" type="button">Roadmap</button>
  </nav>
  <div class="top-find"><input id="q" type="search" placeholder="Search" aria-label="Search items, Spec, Doctrine and shouts" autocomplete="off"><div class="find-results" id="find-results" role="listbox" aria-label="Search results" hidden></div></div>
</header>
<main>
  <section class="card-panel first">
    <h2>No boards yet</h2>
    <p>Run <code>pullboard init</code> in a git repo, or ask an agent to. Its board shows up here by itself.</p>
  </section>
  <p class="machine-settings-entry"><button class="ghost" data-settings-open type="button">Settings for this machine</button></p>
  <p class="empty" id="project-loading" role="status" hidden>Loading project…</p>
  ${hostedMarkup('http://127.0.0.1:4890', { looking: Boolean(hostedLocal) && !snapshot, signIn })}
  <div class="share-card" id="share-note" hidden><span class="share-ic" aria-hidden="true"><svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="13" height="10" rx="1.5"/><path d="M7 18h5M9.5 14v4"/><rect x="17" y="9" width="5" height="10" rx="1"/></svg></span><span class="share-txt"><b>Open your boards on any device</b><span>Sign in to use pullboard.dev while on the go.</span> <a href="https://pullboard.dev/relay/" target="_blank" rel="noopener">How the relay works</a></span><button class="ob-gh share-gh" id="share-start" type="button"><svg viewBox="0 0 16 16" width="15" height="15" aria-hidden="true" fill="currentColor"><path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z"/></svg>Sign in with GitHub</button><button class="share-x" id="share-hide" type="button" aria-label="Hide this; bring it back from the projects list" title="Hide this; bring it back from the projects list">&times;</button></div>
  <section class="card-panel" id="share-panel" aria-label="Link these boards" hidden>
    <p id="share-status" role="status" aria-live="polite"></p>
    <button class="ghost" id="share-pair" type="button" hidden>Pair a device</button>
    <button class="ghost" id="share-close" type="button">Cancel sign-in</button>
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
  <section data-pane="home" class="home" aria-label="Home"><section class="card-panel home-card" id="home-rules" aria-label="Your rules"></section><section class="card-panel home-card" aria-label="Needs you"><h2>Needs you</h2><ol class="needs home-needs" id="home-needs"></ol><p class="empty" id="home-calm" hidden>Nothing needs you.</p></section></section>
  <section data-pane="items" class="two">
    <div class="primary">
      <section class="card-panel proof-stats" id="proof-stats" aria-label="Board proof stats" hidden></section>
      <div class="card-panel toolbar" id="items-toolbar">
        <div class="items-view-switch seg" id="items-view-switch" role="group" aria-label="Items view"></div>
        <div class="filter-control"><button class="filter-toggle" id="filter-toggle" data-filter-toggle type="button" aria-haspopup="menu" aria-expanded="false" aria-controls="filter-menu"><span class="filter-label" id="filter-label">Filter</span><svg viewBox="0 0 16 16" aria-hidden="true"><path d="M4 6l4 4 4-4" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"/></svg></button><div class="filter-menu" id="filter-menu" role="menu" aria-label="Filter" hidden></div></div>
        <button class="go" id="new-item" type="button" aria-label="New item"><span class="new-item-wide">New item</span><span class="new-item-narrow" aria-hidden="true">New</span></button>
      </div>
      <section class="card-panel upgrade-note" id="upgrade-note" aria-label="What is new" hidden></section>
      <div class="card-panel list-card" id="item-list"><ol class="needs" id="needs" aria-label="What needs you" hidden></ol><ol class="chain" id="chain" aria-label="Items"></ol></div>
      <ol class="pipeline" id="pipeline" aria-label="Item pipeline" hidden></ol>
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
  <section data-pane="shouts" class="two narrow" id="shouts-pane">
    <div class="primary">
      <div class="card-panel shouts-card"><form id="shout-form" class="shout-form"><p class="answering" id="answering" hidden><span>Answering <b id="answering-who"></b>: <span id="answering-q"></span></span><button class="ghost" id="answer-cancel" type="button">Cancel</button></p><div class="composer"><input id="shout-to" type="hidden" value="coordinator"><span class="to-chip" id="shout-to-chip" hidden></span><textarea id="shout-text" required rows="1" placeholder="Shout to the coordinator" aria-label="Message"></textarea><button class="send" id="shout-send" type="submit" aria-label="Shout" title="Shout (Enter; Shift+Enter for a new line)"><svg viewBox="0 0 16 16" aria-hidden="true"><path fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" d="M8 13V3M3.5 7.5 8 3l4.5 4.5"/></svg></button></div><span class="asks-slot" id="asks-slot"></span></form><section class="needs-you" id="coordinator-decisions" aria-label="Coordinator decision queue" hidden></section><section class="needs-you" id="decisions" aria-label="Decisions needed" hidden></section><div class="feed" id="feed"></div></div>
    </div>
    <aside class="card-panel detail" aria-label="Agents and lanes">
      <div><h3 class="panel-head">Agents<button class="link" data-agents-toggle type="button">hide</button></h3><div id="agents"></div><section id="credentials" aria-label="Agent credentials"></section></div>
      <div><h3>Lanes</h3><div id="lanes"></div></div>
      <form id="hold-form" class="panel-form"><label>Hold a lane<select id="hold-lane"></select></label><label>Why<input id="hold-reason" required placeholder="What its agents should wait for"></label><button class="go" type="submit">Hold lane</button></form>
    </aside>
  </section>
  <section data-pane="spec" class="two">
    <div class="primary"><div class="card-panel rows-card"><div id="spec-fit" class="fit"></div><div class="rows-filter"><div class="seg" id="spec-chips" role="group" aria-label="Show"></div></div><div class="rows" id="spec-list" tabindex="0" aria-label="Spec rows"></div></div></div>
    <aside class="card-panel detail" aria-label="Spec row"><div id="spec-detail"></div></aside>
  </section>
  <section data-pane="doctrine" class="two">
    <div class="primary"><div class="card-panel rows-card"><div class="rows-filter"><div class="seg" id="doctrine-chips" role="group" aria-label="Show"></div></div><div class="rows" id="doctrine-list" tabindex="0" aria-label="Doctrine rows"></div></div></div>
    <aside class="card-panel detail" aria-label="Practice row"><div id="doctrine-detail"></div></aside>
  </section>
  <section data-pane="activity">
    <figure class="card-panel flow" id="flow-panel"><button class="flow-hide" id="flow-hide" type="button" title="Hide the lifecycle" aria-label="Hide the lifecycle">×</button><div id="flow"></div><figcaption>The lifecycle every item follows, as pullboard declares it. Boxes count the items in each state now, labels the moves made along each route, and ↻ the moves that keep an item where it is; hover over one for what it means and checks.</figcaption></figure>
    <button class="ghost flow-show" id="flow-show" type="button" hidden>Show the lifecycle</button>
    <div class="card-panel feed" id="activity"></div>
  </section>
  ${settingsMarkup()}
  <section data-pane="roadmap" class="roadmap-layout" id="roadmap" aria-label="Roadmap"></section>
  ${hostedLocal && !snapshot ? starMarkup() : ''}
</main>
</div>
</div>
<footer class="status${snapshot ? ' snap' : ''}" aria-label="Board status"><span class="live" id="live"></span><span class="status-board" id="status-board"></span></footer>
<div class="spec-reason-backdrop" id="spec-decline-dialog" hidden>
  <form class="spec-reason-dialog" id="spec-decline-form" aria-labelledby="spec-decline-title">
    <h2 id="spec-decline-title">Decline spec row</h2>
    <label>Reason<input id="spec-decline-reason" required maxlength="240" placeholder="Why this row needs changes"></label>
    <div class="actions"><button class="go" id="spec-decline-submit" type="submit">Decline row</button><button class="ghost" id="spec-decline-cancel" type="button">Cancel</button></div>
  </form>
</div>
<div class="spec-reason-backdrop" id="spec-approve-dialog" hidden>
  <form class="spec-reason-dialog" id="spec-approve-form" aria-labelledby="spec-approve-title">
    <h2 id="spec-approve-title">Approve rows</h2>
    <div class="muted" id="spec-approve-rows"></div>
    <div class="actions"><button class="go" id="spec-approve-submit" type="submit">Approve rows</button><button class="ghost" id="spec-approve-cancel" type="button">Cancel</button></div>
  </form>
</div>
<div class="console" id="console" title="Click to close" hidden></div>
<script>
${pageScriptPart1(pageScope)}const itemSearches = new Map();
${pageScriptPart2(pageScope)}function syncBoardMode(root) {
  if (snapshot) return;
  const board = data?.projects.find((entry) => entry.root === root && entry.ok);
  const source = board && boardSources.get(board.id);
  const relay = source?.kind === 'relay';
  readOnly = hosted.local ? relay || (transportModule !== null && !source) : pageReadOnly;
  requests = hosted.local ? Boolean(relay && relayRequestsEnabled) : pageRequests;
  document.body.classList.toggle('read-only', readOnly);
  document.body.classList.toggle('requests', requests);
}

${pageScriptPart3(pageScope)}async function refresh(fresh = null, attempt = 1) {
  const generation = ++refreshStarted;
  const root = view.root;
  const mark = root ? view.seen['pb.seen.' + root] ?? keep('pb.seen.' + root) : null;
  const next = await boardState(root, mark, fresh);
  // The person switched projects while this answer was on its way: the switch's own refresh shows it.
  if (root !== view.root) return;
  // A board left and opened again: an answer that started before one already drawn is older than it, so it is not
  // drawn over it. When it read every board and the newer one read only some, the rest are read once more.
  if (generation < refreshDrawn.generation) {
    if (!fresh && !refreshDrawn.full) { catchEvery = true; catchUp(); }
    return;
  }
  // Only a read of every board can say the shown project is gone and choose another. A catch-up that could not read
  // the shown board, as while the view restarts, failed; it keeps the board and the page says it is offline.
  if (fresh && !next.project && !next.group) throw new Error('the board did not answer; is pullboard view still running?');
  // The shown board is listed but its read failed, as one dropped under load: read it again rather than hand the page
  // to another board; only a board gone from the list does that (#889).
  const failed = !next.project && !next.group && next.projects.find((p) => p.root === root && !p.ok);
  if (failed) {
    if (attempt < 3) { await new Promise((later) => { setTimeout(later, 300 * attempt); }); return refresh(fresh, attempt + 1); }
    throw new Error(failed.error);
  }
  refreshDrawn = { generation, full: !fresh };
  if (!next.project && !next.group && next.projects.some((p) => p.ok)) {
    view.root = next.projects.find((p) => p.ok).root;
    keep('pb.project', view.root);
    return refresh();
  }
  // The project this board is, so a switch still loading never reads it as the next one's.
  next.root = root;
  // Rebuild only when the board changed: a list rebuilt under the pointer can swallow a click.
  if (!addressReady) {
    data = next;
    const place = placeAtAddress(next);
    if (place?.root && place.root !== view.root) {
      view.root = place.root;
      keep('pb.project', view.root);
      return refresh();
    }
    if (place) applyPlace(place, globalThis.history?.state);
    addressReady = true;
  }
  const text = boardText(next);
  const changed = text !== seen;
  if (text !== seen) {
    seen = text;
    data = next;
    syncBoardMode(view.root);
    itemSearches.clear();
    const reading = detailRead;
    render();
    if (detailRead !== reading) await detailRead;
  } else if (data !== next) {
    // The same board read again: keep its newest clock readings and show them in place, with no redraw (#644).
    data = next;
    showFlowAges();
    tickAges();
  }
  if (changed) {
    address(false);
    void loadAddressedShout();
  }
  if (snapshot && !snapshotReplay.final && data.project) {
    snapshotReplay.final = structuredClone(data.project);
    snapshotReplay.events = (await api(boardPath(view.root) + '/events')).events;
    snapshotReplay.index = snapshotReplay.events.length;
    replayControls();
  }
  if (!snapshot) follow();
  $('live').textContent = snapshot ? 'read-only snapshot' : liveLine();
  sharingReady ??= sharingInvitation();
  transport?.didRender?.(); // The board drew: a transport holding a phone's shell may clear it; today's has no such call (#900).
}

// The local view follows the shown boards' events instead of a timer (#545): it reads the board once, waits on its
// events after that read's latest one, and reads again only when an event or the stream's changed signal (#554)
// arrives, so a page whose boards are quiet makes no requests. The relay transport keeps its own stream.
// A page holds at most one stream: Chrome allows six connections per host, a held stream keeps one for good, and the
// catch-up read needs the rest. Six held streams, one per repo of a group, left none, and the page waited forever for
// its own read. So a group follows every repo it shows through one multiplexed stream (#600).
let stream = null;
let catching = null;
let catchAgain = false;
let catchWhenShown = false;
// The boards whose events arrived since the last catch-up, or every board when a message names none.
const catchRoots = new Set();
let catchEvery = false;
/** How often a page with no live stream reads its board instead, until the stream is back. */
const FALLBACK_MS = 15000;

/** Whether this browser reads a response as it arrives; one that cannot keeps only the fallback refresh. */
const canStream = () => typeof AbortController === 'function' && typeof ReadableStream === 'function' && typeof TextDecoderStream === 'function';

/** The latest event a board state already shows; its events are newest first. */
const latestEvent = (state) => Number(state?.events?.[0]?.event_id ?? 0);

/** Whether the page's stream is up or opening, so nothing needs a timed read. */
const connected = () => Boolean(stream) && stream.status !== 'down';

/** Say nothing while the page's stream is up, and why the page is not live while it is down. */
function liveLine() {
  if (!stream || stream.status !== 'down') return '';
  if (stream.offline) return 'offline: is pullboard view still running?';
  return (canStream() ? 'reconnecting' : 'no live stream in this browser') + ': refreshing every ' + FALLBACK_MS / 1000 + 's';
}

/** Stop following a board: close its stream and any retry waiting to reopen it. */
function unfollow() {
  if (!stream) return;
  stream.controller?.abort();
  clearTimeout(stream.retry);
  stream = null;
}

/**
 * Follow every board the page shows, the board or each repo of a group, on one stream that starts each board after
 * the state just read. Every catch-up reads every board, so the sidebar's boards update with it and on a project
 * switch, without a stream of their own.
 */
function follow() {
  const repos = data.group ? data.group.repos.map((repo) => [repo.root, repo.board]) : data.project ? [[view.root, data.project]] : [];
  const boards = repos.flatMap(([root, state]) => {
    const board = data.projects.find((entry) => entry.root === root && entry.ok);
    return board && localBoardIds.has(board.id) ? [{ root, id: board.id, shown: latestEvent(state) }] : [];
  });
  const key = boards.map((board) => board.id).join(',');
  // A board's events after the latest one this page shows are what changed it since.
  if (stream && boards.length && stream.key === key) {
    for (const board of boards) { const kept = stream.boards.find((entry) => entry.id === board.id); kept.shown = Math.max(kept.shown, board.shown); }
    return;
  }
  unfollow();
  if (!boards.length) return;
  // One board's cursor is its latest event; a group's names each board's latest event, as #600 resumes them.
  const cursor = boards.length === 1 ? String(boards[0].shown) : boards.map((board) => board.id + ':' + board.shown).join(',');
  stream = { key, boards, cursor, status: 'opening', offline: false, failures: 0, controller: null, retry: 0 };
  void listen(stream);
}

/** Read one server-sent message: its event name, its data and its id, as sent. */
function streamMessage(block) {
  const message = { event: 'message', data: '', id: null };
  for (const line of block.split('\\n')) {
    if (!line || line.startsWith(':')) continue;
    const colon = line.indexOf(':');
    const field = colon < 0 ? line : line.slice(0, colon);
    const value = colon < 0 ? '' : line.slice(colon + 1).replace(/^ /, '');
    if (field === 'event') message.event = value;
    else if (field === 'data') message.data += (message.data ? '\\n' : '') + value;
    else if (field === 'id' && !value.includes('\\0')) message.id = value;
  }
  return message;
}

/**
 * The board a message changed, by root: an event after the latest one that board shows, or its changed signal, sent
 * when the board changes without a move (#554). Undefined when the page already shows it, and null, for every board,
 * when a message names no board this stream follows, as a warning does. A group's stream names each event's board
 * (#600); a single board's stream is that board's.
 */
function streamChange(entry, message) {
  if (!message.data && message.event === 'message') return undefined;
  let body = null;
  try { body = JSON.parse(message.data); } catch { return null; }
  const board = entry.boards.length === 1 ? entry.boards[0] : entry.boards.find((candidate) => candidate.id === body?.board);
  if (!board || !body?.event) return null;
  const id = Number(body.event.event_id);
  if (!Number.isSafeInteger(id)) return board.root;
  return id > board.shown ? board.root : undefined;
}

/** The boards a shown board's milestones name, by root: its Roadmap reads their items, so its catch-up reads them. */
function namedBoards(root) {
  const state = data?.root === root ? data.project : data?.group?.repos.find((repo) => repo.root === root)?.board;
  const names = new Set((state?.milestones || []).flatMap((milestone) => milestone.items || []).map((entry) => /^(.+)#[1-9]\\d*$/.exec(String(entry.id))?.[1]).filter(Boolean));
  return (data?.projects || []).filter((row) => names.has(row.name) || names.has(String(row.root).split('/').pop())).map((row) => row.root);
}

/** The rule and next step a stream's refusal carries. */
function streamRefusal(data) {
  try {
    const refusal = JSON.parse(data).error;
    return refusal && typeof refusal === 'object' ? '[' + refusal.code + '] ' + refusal.message : String(refusal || 'the board stream refused this view');
  } catch { return 'the board stream refused this view'; }
}

/**
 * Hold one board's event stream open, and read the board when its events say it changed. When the stream ends or
 * fails, try again with Last-Event-ID, waiting longer after each failure; the fallback refresh covers the gap.
 */
async function listen(entry) {
  const controller = canStream() ? new AbortController() : null;
  entry.controller = controller;
  try {
    if (!controller) throw new Error('this browser cannot read a stream');
    // Local board streams use the local view's base and credential, separate from the relay client's own streams.
    // One board has its own events; a group's local repos share one multiplexed stream (#600).
    const single = entry.boards.length === 1;
    const path = localReadBase + (single ? '/api/v1/boards/' + encodeURIComponent(entry.boards[0].id) + '/events'
      : '/api/v1/events?boards=' + entry.boards.map((board) => encodeURIComponent(board.id)).join(','));
    const res = await fetch(path, {
      headers: { ...localReadHeaders, accept: 'text/event-stream', 'last-event-id': entry.cursor }, cache: 'no-store', signal: controller.signal,
    });
    // This machine's view refused the hosted page's secret, as after a restart with a new one: go round again (#513).
    if ((res.status === 401 || res.status === 403) && localSession && localReadBase === localSession.origin) { localExpired(); return; }
    if (!res.ok || !res.body) throw new Error('the board stream answered ' + res.status);
    entry.status = 'up';
    entry.offline = false;
    entry.failures = 0;
    $('live').textContent = liveLine();
    // A change with no event made before the stream opened, such as a SPEC.md edit after the snapshot was read or
    // while a dropped stream was down, is not replayed by Last-Event-ID, and the stream's changed signal starts after
    // it. So each time the stream opens, the page reads its boards once.
    for (const board of entry.boards) catchRoots.add(board.root);
    catchUp();
    const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
    let buffer = '';
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += value;
      let moved = false;
      for (let end = buffer.indexOf('\\n\\n'); end >= 0; end = buffer.indexOf('\\n\\n')) {
        const message = streamMessage(buffer.slice(0, end));
        buffer = buffer.slice(end + 2);
        if (message.event === 'error') throw new Error(streamRefusal(message.data));
        if (message.id !== null) entry.cursor = message.id;
        const change = streamChange(entry, message);
        if (change === undefined) continue;
        if (change === null) catchEvery = true; else catchRoots.add(change);
        moved = true;
      }
      // One read covers every event that arrived together.
      if (moved) catchUp();
    }
    throw new Error('the board stream ended');
  } catch (error) {
    if (controller?.signal.aborted || stream !== entry) return;
    entry.status = 'down';
    // A request that never reached the view is a TypeError; a refusal or an ended stream is not.
    entry.offline = error instanceof TypeError;
    entry.failures += 1;
    $('live').textContent = liveLine();
    if (controller) entry.retry = setTimeout(() => { if (stream === entry) void listen(entry); }, Math.min(FALLBACK_MS, 1000 * 2 ** Math.min(entry.failures - 1, 4)));
  }
}

/**
 * The one catch-up function: bring the page up to date after the events that arrived, one read at a time, by reading
 * what changed in each board they named since the state it holds (#555, through boardRead). A hidden page catches up
 * when it is shown.
 */
function catchUp() {
  if (document.hidden) { catchWhenShown = true; return; }
  if (catching) { catchAgain = true; return; }
  if (!catchEvery && !catchRoots.size) return;
  const fresh = catchEvery ? null : new Set(catchRoots);
  for (const root of catchEvery ? [] : catchRoots) for (const named of namedBoards(root)) fresh.add(named);
  catchEvery = false;
  catchRoots.clear();
  catching = refresh(fresh).catch(() => { $('live').textContent = 'offline: is pullboard view still running?'; }).finally(() => {
    catching = null;
    if (catchAgain) { catchAgain = false; catchUp(); }
  });
}
document.addEventListener('visibilitychange', () => { if (!document.hidden && catchWhenShown) { catchWhenShown = false; catchUp(); } });

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
  p.asked = p.asked.filter((shout) => shouted.has(shout.shout_id)); p.decisionQueue = (p.decisionQueue || []).filter((shout) => shouted.has(shout.shout_id));
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
  /** Render a repo button or a transient board-read error line. Registered unreadable boards are disclosed below. */
  const repoButton = (x) => {
    if (!x.ok) return '<p class="repo-error" role="status"><b>' + esc(x.name) + ':</b> ' + esc(x.error) + '</p>';
    const on = x.root === view.root;
    const parts = doing(x).split(' · '), asks = [x.decisions, x.pending, x.drafts, x.holds].filter(Boolean).length;
    const line = x.loading ? 'Loading…' : (asks ? '<span class="asks">' + esc(parts.slice(0, asks).join(' · ')) + '</span>' + (parts.length > asks ? ' · ' : '') : '') + esc(parts.slice(asks).join(' · '));
    return '<button class="proj repo' + (on ? ' on' : '') + '"' + (on ? ' aria-current="true"' : '') + ' data-root="' + esc(x.root) + '" title="' + esc(x.root) + '" type="button"><span class="pname">' + (x.owner ? '<span class="owner">' + esc(x.owner) + '/</span>' : '') + esc(x.name) + '</span><small>' + (hosted.local && x.source ? '<span class="src">' + (x.source === 'relay' ? 'shared' : 'this computer') + '</span> · ' : '') + line + '</small></button>';
  };
  const readableProjects = data.projects.filter((repo) => repo.ok);
  const unreadableProjects = data.projects.filter((repo) => !repo.ok && repo.warningCode === 'BOARD_UNAVAILABLE');
  const otherErrors = data.projects.filter((repo) => !repo.ok && repo.warningCode !== 'BOARD_UNAVAILABLE').map(repoButton).join('');
  const groups = projectGroups(readableProjects);
  const groupedRoots = new Set(groups.flatMap((group) => group.repos.map((repo) => repo.root)));
  const grouped = groups.map((group) => {
    const on = group.key === view.root;
    const needs = group.repos.reduce((total, repo) => total + needCount(repo), 0);
    const count = group.repos.length;
    return '<section class="repo-group"><button class="proj project-pick' + (on ? ' on' : '') + '"' + (on ? ' aria-current="true"' : '') + ' data-root="' + esc(group.key) + '" type="button"><span class="pname">' + esc(group.name) + '</span><small>' + (needs ? '<span class="asks">' + needs + ' need you</span> · ' : '') + count + ' ' + (count === 1 ? 'repo' : 'repos') + '</small></button><div class="repos">' + group.repos.map(repoButton).join('') + '</div></section>';
  }).join('');
  const loose = readableProjects.filter((repo) => !groupedRoots.has(repo.root)).map(repoButton).join('');
  const unreadable = unreadableProjects.length ? '<details class="unreadable-projects"><summary>' + unreadableProjects.length + ' ' + (unreadableProjects.length === 1 ? 'board can' : 'boards can') + ' no longer be found</summary><ul>' + unreadableProjects.map((repo) => '<li><b>' + esc(repo.name) + '</b> <code>' + esc(repo.root) + '</code></li>').join('') + '</ul>' + (snapshot || readOnly ? '' : '<button type="button" data-forget-unreadable>Forget all</button>') + '</details>' : '';
  $('proj-list').innerHTML = grouped || loose || otherErrors || unreadable ? grouped + loose + otherErrors + unreadable : '<div class="empty">None yet.</div>';
  const p = data.project;
  const selectedGroup = data.groups.find((group) => group.key === view.root);
  const selectedRepo = data.projects.find((x) => x.root === view.root);
  $('proj-name').textContent = selectedGroup?.name || selectedRepo?.name || (p ? p.root.split('/').pop() : 'No project');
  // The browser tab says it too, for when the view sits behind other tabs.
  const needs = data.projects.reduce((n, x) => n + needCount(x), 0);
  document.title = p || selectedGroup ? (needs ? '(' + needs + ') ' : '') + $('proj-name').textContent + ' · Pullboard' : 'Pullboard';
}

  /** Escape plain text while preserving safe item and code-preview links.
   * @param {string} text
   * @param {Map<string, string>} titles
   * @param {boolean|'in-place'} allowLinks
   * @returns {string}
   */
  function linked(text, titles, allowLinks = true, root = view.root) { return String(text ?? '').split(/(#\\d+|(?<![^\\s([{"'\`])[^\\s:@()[\\]{}"'\`]+:\\d+(?:-\\d+)?@[0-9a-f]{7,40}(?![^\\s)\\]}"'\`.,;:!?]))/).map((part, n, parts) => {
    if (n % 2 && part[0] !== '#') return allowLinks === true ? codeRef(part, parts.slice(0, n).join('').split('\\n').pop().slice(-2000)) : codeChip(part);
    const id = /^#\\d+$/.test(part) ? String(Number(part.slice(1))) : '';
    if (id && allowLinks === 'in-place') return '<span class="ref"' + (titles.has(id) ? ' title="' + esc(titles.get(id)) + '"' : '') + '>' + esc(part) + '</span>';
    return id && allowLinks ? '<a class="ref" href="' + esc(itemAddress(id, root)) + '" data-go="item:' + id + '"' + (root === view.root ? '' : ' data-board="' + esc(root) + '"') + (titles.has(id) ? ' title="' + esc(titles.get(id)) + '"' : '') + '>' + esc(part) + '</a>' : esc(part);
  }).join(''); }
  /** Format inline code and recognized command tokens without interpreting markup.
   * @param {string} text
   * @param {Map<string, string>} titles
   * @param {boolean|'in-place'} allowLinks
   * @returns {string}
   */
  function inline(text, titles, allowLinks = true, root = view.root) { return String(text ?? '').split(/(\`[^\`]*\`|(?:[^\\s:@()[\\]{}"'\`]+)?:\\d+(?:-\\d+)?@[0-9a-f]{0,40}|${COMMAND_SOURCE}|--[\\w-]+|(?:\\/|\\.\\.?\\/|[\\w.-]+\\/)\\w[\\w./-]*\\.[A-Za-z0-9]+|\\b[0-9a-fA-F]{7,40}\\b|#\\d+)/g).map((part, n, parts) => {
    if (part.startsWith('\`') && part.endsWith('\`')) return codeChip(part.slice(1, -1));
    if (part.includes('@') && part.includes(':')) {
      const textBefore = parts.slice(0, n).join('');
      const fullText = parts.join('');
      const after = fullText[textBefore.length + part.length] || '';
      const leftBoundary = !textBefore || [9, 10, 32, 40, 91, 123, 34, 39, 96].includes(textBefore.at(-1).charCodeAt(0));
      const rightBoundary = !after || [9, 10, 32, 41, 93, 125, 34, 39, 96, 46, 44, 59, 58, 33, 63].includes(after.charCodeAt(0));
      const validRef = leftBoundary && rightBoundary;
      const partial = /^(?:([^:@()[\\]{}"'\`]+))?:(\\d+)(?:-(\\d+))?@([0-9a-f]*)$/.exec(part);
      if (validRef && partial && (!partial[1] || partial[4].length < 7)) {
        const reason = !partial[1] ? 'missing the repository path' : 'missing a usable commit SHA';
        return '<span class="code no ref-missing" role="status">Code reference unavailable: ' + reason + '.</span>';
      }
      if (allowLinks === true && validRef) return codeRef(part, textBefore.slice(-2000));
      return codeChip(part);
    }
    if (/^(?:${COMMAND_SOURCE}|--[\\w-]+)$/.test(part)) return codeChip(part, 'cmd');
    if (/^(?:\\/|\\.\\.?\\/|[\\w.-]+\\/)\\w[\\w./-]*\\.[A-Za-z0-9]+$/.test(part)) return codeChip(part, 'path');
    if (/^[0-9a-fA-F]{7,40}$/.test(part)) return codeChip(part, 'sha');
    return linked(part, titles, allowLinks, root);
  }).join(''); }
  /** Render inline text and fenced or shell command blocks with escaped contents.
   * @param {string} text
   * @param {Map<string, string>} titles
   * @param {boolean} allowLinks
   * @returns {string}
   */
  /**
   * A run of '- ' lines as one bulleted list, indented lines nested under the bullet above them. A bullet
   * that is a whole command (npm, npx, pnpm, yarn, bun, git, node, python, pytest, pullboard) is one code
   * chip; any other bullet is prose, with its paths, flags and backticks as chips. A whole command is the
   * command alone: no sentence end, no comma outside quotes, and at most two plain words after it (spec
   * check, merge main); everything else in it is a path, flag, number or quoted string. A bullet that only
   * starts with a command is a sentence (#232: all nine such bullets on the board were).
   */
  function wholeCommand(text) {
    if (!/^(?:npm|npx|pnpm|yarn|bun|git|node|python(?:\\d+(?:\\.\\d+)?)?|pytest|pullboard)\\s+\\S/.test(text) || /[.!?:;,]$/.test(text.trim())) return false;
    const bare = text.replace(/"[^"]*"|'[^']*'|\`[^\`]*\`/g, ' ');
    return !/[,;]\\s/.test(bare) && bare.trim().split(/\\s+/).slice(1).filter((word) => /^[A-Za-z]+$/.test(word)).length <= 2;
  }

  /** Preserve repo scope while linking references inside a prose list. */
  function bullets(lines, titles, allowLinks, root = view.root) {
    const roots = [], open = [];
    for (const line of lines) {
      const [, indent, text] = /^(\\s*)- (.*)$/.exec(line);
      const node = { text, children: [] };
      while (open.length && indent.length <= open.at(-1).indent) open.pop();
      (open.length ? open.at(-1).node.children : roots).push(node);
      open.push({ indent: indent.length, node });
    }
    const list = (nodes) => '<ul class="text-list">' + nodes.map((node) => '<li>'
      + (wholeCommand(node.text) ? codeChip(node.text, 'cmd') : inline(node.text, titles, allowLinks, root))
      + (node.children.length ? list(node.children) : '') + '</li>').join('') + '</ul>';
    return list(roots);
  }

  // A line that is nothing but one path:lines@commit reference.
  const WHOLE_REF = /^\\s*[^\\s:@()[\\]{}"'\`]+:\\d+(?:-\\d+)?@[0-9a-f]{7,40}\\s*$/;
  function rich(text, titles, allowLinks = true, root = view.root) {
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
      } else if (allowLinks && WHOLE_REF.test(lines[i])) {
        output.push({ block: codeRef(lines[i++].trim(), '', true) });
      } else if (/^\\s*- /.test(lines[i])) {
        const run = [];
        while (i < lines.length && /^\\s*- /.test(lines[i])) run.push(lines[i++]);
        output.push({ list: bullets(run, titles, allowLinks, root) });
      } else {
        const block = [];
        while (i < lines.length && !lines[i].startsWith('\`\`\`') && !lines[i].startsWith('$ ') && !/^\\s*- /.test(lines[i]) && !(allowLinks && WHOLE_REF.test(lines[i]))) block.push(inline(lines[i++], titles, allowLinks, root));
        output.push(block.join('<br>'));
      }
    }
    // A list ends its own line, so no break goes beside one: a blank line in the text stays one blank line.
    return output.map((part, n) => (n && typeof part === 'string' && typeof output[n - 1] === 'string' ? '<br>' : '') + (typeof part === 'string' ? part : part.list ?? part.block)).join('');
  }

/** Draw a project's cross-repo Needs-you list and one activity feed. */
function renderGroup(group) {
  const needs = group.repos.flatMap((repo) => projectNeeds(repo.board).map((row) => ({ ...row, repo })));
  $('group-needs').innerHTML = needs.length ? needs.map((row) => {
    const titles = new Map(row.repo.board.items.map((item) => [String(item.id), item.title]));
    const text = rich(row.text, titles, true, row.repo.root);
    return '<div class="group-need"><b>' + esc(row.repo.name) + '</b><code>' + esc(row.ref) + '</code><span>' + text + '</span><button data-root="' + esc(row.repo.root) + '" type="button"><em>' + esc(row.kind === 'pending' ? 'answer ' + row.ref : row.what) + (row.at ? ', ' + age(row.at) : '') + ' →</em></button></div>';
  }).join('') : '<div class="empty">Nothing needs you across this project.</div>';
  const events = group.repos.flatMap((repo) => {
    const titles = new Map(repo.board.items.map((item) => [String(item.id), item.title]));
    return repo.board.events.map((event) => ({ ...event, repo, titles, title: event.item_id ? titles.get(String(event.item_id)) : null }));
  }).sort((a, b) => b.event_at.localeCompare(a.event_at)).slice(0, 80);
  $('group-activity').innerHTML = events.length ? byDay(events, (event) => event.event_at, (event) => '<div><time>' + clock(event.event_at) + '</time><div class="act"><b class="repo-label">' + esc(event.repo.name) + '</b> <span>' + esc(agentName(event.event_by, event.repo.board)) + ' ' + esc(event.event_kind) + (event.item_id ? ' <a class="ref" href="' + esc(itemAddress(event.item_id, event.repo.root)) + '" data-go="item:' + event.item_id + '"' + (event.repo.root === view.root ? '' : ' data-board="' + esc(event.repo.root) + '"') + '>#' + event.item_id + '</a>' + (event.title ? ' ' + rich(event.title, event.titles, true, event.repo.root) : '') : '') + '</span></div></div>') : '<div class="empty">No activity yet.</div>';
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
  const source = root === view.root ? p : root ? named[0] : null;
  const label = local ? '#' + entry.id : String(entry.id);
  const expanded = view.tab === 'roadmap' && view.roadmapOpen.get(JSON.stringify([view.root, 'i:' + label])) === true;
  // A folded row holds whatever detail is already kept, so it opens in place whole (#1039).
  const detail = item ? detailOf(source, item, expanded, root) : null;
  if (item && !expanded) roadmapAhead.set('i:' + label, () => detailOf(source, item, 'ahead', root));
  // A status the lifecycle declares; the roadmap says unavailable or missing for an item it could not read.
  const read = item || (FLOW.states.some((state) => state.id === entry.status) ? { status: entry.status, verdict: null } : null);
  return {
    label: local ? '#' + entry.id : String(entry.id),
    title: item ? item.title : read ? entry.title : '',
    root,
    titles: new Map((root === view.root ? p.items : root ? named[0].items : []).map((i) => [String(i.id), i.title])),
    state: read ? stateOf(read) : null,
    stale: item ? staleChip(item) : '', held: item ? heldNote(item, source, entry) : null,
    block: item ? roadmapBlock(detail?.item || item, {
      holds: root === view.root ? source.holds : source.laneHolds, itemHolds: source.itemHolds, items: source.items, agents: source.agents, state: stateOf,
      address: (id) => itemAddress(id, root), board: root === view.root ? null : root,
      releases: (p.milestones || []).filter((milestone) => milestone.items.some((ref) => ref.id === entry.id)).map((milestone) => milestone.name),
      error: expanded ? detail?.error : undefined,
    }) : null,
    // Until its omitted fields arrive, an expanded row paints what its summary holds and fills the rest in place (#1039).
    pending: expanded && Boolean(detail?.loading),
    stage: entry.state === 'landed' ? 'merged' : entry.state === 'accepted' ? 'accepted' : item ? pipelineStage(item) : entry.status,
    word: entry.status,
    open: item ? { root, id } : null,
    // Why an item does not open, short enough to read beside its id on a phone.
    why: item ? '' : local ? 'not on this board' : root ? 'not on that board' : snapshot ? 'not in this snapshot'
      : named.length > 1 ? 'board name not unique' : named.length ? 'board unreadable' : 'no such board',
  };
}

/** Mark the release nearest the top of the Roadmap in its companion panel. */
function updateRoadmapPanel() {
  const panel = $('roadmap-panel');
  if (!panel || view.tab !== 'roadmap') return;
  aheadRoadmapRows();
  const entries = [...panel.querySelectorAll('[data-roadmap-jump]')].map((button) => ({
    key: button.dataset.roadmapJump,
    target: $('roadmap-list').querySelector('[data-key="' + CSS.escape(button.dataset.roadmapJump) + '"]'),
  })).filter((entry) => entry.target);
  if (!entries.length) return;
  const threshold = (document.querySelector('.top')?.getBoundingClientRect().bottom ?? 0) + 8;
  const active = entries.find((entry) => entry.target.getBoundingClientRect().bottom > threshold)?.key || entries.at(-1).key;
  for (const entry of entries) {
    const button = panel.querySelector('[data-roadmap-jump="' + CSS.escape(entry.key) + '"]');
    if (button) {
      if (entry.key === active) button.setAttribute('aria-current', 'location');
      else button.removeAttribute('aria-current');
    }
  }
}

/** Open a selected release in the list and briefly mark it after the jump. */
function jumpToRoadmap(key) {
  if (key === 'shipped') {
    view.roadmapOpen.set(JSON.stringify([view.root, 'shipped']), true);
    render();
  }
  const target = $('roadmap-list')?.querySelector('[data-key="' + CSS.escape(key) + '"]');
  if (!target) return;
  const topbar = document.querySelector('.top');
  if (matchMedia('(max-width: 900px)').matches && topbar) {
    // The Roadmap scrolls in the document viewport; use the wrapped sticky bar's actual lower edge, not its minimum height.
    target.style.scrollMarginTop = Math.ceil(topbar.getBoundingClientRect().bottom + 16) + 'px';
  } else target.style.removeProperty('scroll-margin-top');
  target.scrollIntoView({ block: 'start', behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'instant' : 'smooth' });
  target.classList.remove('roadmap-arrival');
  void target.offsetWidth;
  target.classList.add('roadmap-arrival');
  setTimeout(() => target.classList.remove('roadmap-arrival'), 1300);
  updateRoadmapPanel();
}

/**
 * One item's row on the Roadmap, laid out as the Items list lays one out: the dot of its state, its
 * id and title on one line that ends in an ellipsis when cut, and the Items tab's chip. The whole
 * title is the row's tooltip. Every row expands in place; its compact detail alone links over to Items.
 */
function milestoneRow(row, titles, hidden = false) {
  const title = row.title ? inline(String(row.title).replace(/\\s+/g, ' '), row.titles || titles, 'in-place', row.root) : '<span class="muted">' + esc(row.why) + '</span>';
  const label = '<span class="id">' + esc(row.label) + '</span>' + title;
  const text = row.block?.dot ? '<span class="milestone-title">' + label + '</span>' + row.block.dot : label;
  const key = 'i:' + row.label, open = view.roadmapOpen.get(JSON.stringify([view.root, key])) === true;
  const status = (open && row.block?.dot ? '<span class="chip warn roadmap-blocked"><svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><rect x="5" y="10" width="14" height="11" rx="2"/><path d="M8 10V7a4 4 0 0 1 8 0v3"/></svg>blocked</span>' : '') + (row.stage === 'merged' ? '<span class="chip ok roadmap-landed">verified</span>' : row.stage === 'accepted' ? '<span class="chip ok">accepted</span>' : row.held ? heldChip(row.held) : row.state ? chip(row.state) : '<span class="chip">' + esc(row.word) + '</span>');
  const inner = '<span class="dot' + (row.state ? ' ' + row.state : '') + '"></span><span class="t">' + text + '</span>' + (row.stale || '') + '<span class="roadmap-status">' + status + '</span>';
  const board = row.open && row.open.root !== view.root ? ' data-board="' + esc(row.open.root) + '"' : '';
  const toggle = 'class="milestone-item' + (row.block?.dot ? ' blocked' : '') + '" data-roadmap-key="' + esc(key) + '" aria-expanded="' + open + '"' + board + ' title="' + esc(row.title ? row.title + (!row.open && row.why ? ' (' + row.why + ')' : '') : row.why) + '"';
  const detail = row.block ? row.block.detail : '<p>' + esc(row.why || row.word) + '</p>';
  // Every row stays on the Roadmap; only its explicit Open in Items link navigates (#605).
  return '<li' + (hidden ? ' hidden' : '') + '><div ' + toggle + ' role="button" tabindex="0">' + inner + '</div>'
    + '<div class="milestone-why"' + (open ? '' : ' hidden') + (row.pending ? ' aria-busy="true"' : '') + '>' + detail + '</div></li>';
}

/** Read supplied landed counts and explicit shipments; keep old exports readable and omit withdrawn rows. */
function readMilestone(milestone, p) {
  const visible = milestone.items.map((entry) => milestoneItem(entry, p)).filter((row) => row.state !== 'withdrawn');
  const verified = visible.filter((row) => row.state === 'verified');
  const rows = visible.filter((row) => row.state !== 'verified').concat(verified);
  // Current API milestones own their landed count and explicit shipment. Old exports retain their old count.
  /** Reject malformed snapshot counts before they reach numeric HTML attributes. */
  const numeric = value => Number.isInteger(value) && value >= 0 ? value : null;
  const done = numeric(milestone.summary?.landed) ?? numeric(milestone.landed) ?? verified.length;
  const total = numeric(milestone.summary?.total) ?? numeric(milestone.total) ?? rows.length;
  // Nothing left (every item landed or withdrawn) is finished and sits under Shipped, shipped or not.
  const left = numeric(milestone.summary?.left), finished = milestone.items.length > 0 && (left !== null ? left === 0 : rows.every((row) => row.stage === 'merged'));
  const shipped = finished || (milestone.shipped !== undefined ? Boolean(milestone.shipped) : rows.length > 0 && verified.length === rows.length);
  return { milestone, rows, done, total, shipped };
}

/** Pick the first release with remaining work in roadmap order; empty plans wait behind it. */
function nextMilestone(p) {
  const next = (p.milestones || []).find((milestone) => {
    const read = readMilestone(milestone, p);
    return read.rows.length > 0 && !read.shipped;
  });
  if (!next) return next;
  const read = readMilestone(next, p);
  return { ...next, done: read.done, total: read.total };
}

/**
 * The Roadmap (N26, N38) opens releases with work left in board order and folds shipped or finished ones into Shipped.
 * Headers show the backend's summary; accepted and landed rows stay distinct; shipped history carries its commit; old
 * exports keep their legacy completion rule; each part keeps the person's disclosure choice for this visit.
 */
function roadmapCards(p, titles) {
  // Opened from the status bar's release, the Roadmap is that release alone, with a way back to all of them.
  const only = view.roadmapOnly && (p.milestones || []).some((m) => m.name === view.roadmapOnly) ? view.roadmapOnly : null;
  const milestones = (p.milestones || []).filter((m) => !only || m.name === only);
  const lead = only ? '<div class="roadmap-only"><span>' + esc(only) + '</span><button class="link" data-roadmap-all type="button">show all</button></div>' : '';
  const read = milestones.map((milestone) => readMilestone(milestone, p));
  const coming = read.filter((m) => !m.shipped && m.rows.length).concat(read.filter((m) => !m.shipped && !m.rows.length)), shipped = read.filter((m) => m.shipped).reverse();
  /** Preserve each board's disclosure choices independently. */
  const isOpen = (key, first) => view.roadmapOpen.has(JSON.stringify([view.root, key])) ? view.roadmapOpen.get(JSON.stringify([view.root, key])) : first;
  const caret = '<svg class="caret" aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="m9 6 6 6-6 6"/></svg>'; // The view's stroke chevron, set inside the title to centre on its first line (#870).
  const next = coming.find((m) => m.rows.length) || null;
  const headerFor = roadmapHeaders(roadmapSummary, { time: when, address: itemAddress, root: view.root, held: view.roadmapHeld });
  const stages = [['open', 'Open'], ['claimed', 'Building'], ['submitted', 'In review'], ['accepted', 'Accepted'], ['merged', 'Landed']];
  const counts = headerFor(next) ? null : Object.fromEntries(stages.map(([stage]) => [stage, next ? next.rows.filter((row) => row.stage === stage).length : 0]));
  const shippingCounts = headerFor(next)
    ? '<dl class="roadmap-stage-counts">' + [['landed','Landed'],['landing','Accepted, landing'],['review','In review'],['building','Building'],['waiting','Waiting'],['held','Held']].map(([key,label]) => '<div data-shipping-stage="' + key + '"><dt>' + label + '</dt><dd>' + next.milestone.summary[key] + '</dd></div>').join('') + '</dl>'
    : '<dl class="roadmap-stage-counts">' + stages.map(([stage, label]) => '<div data-shipping-stage="' + stage + '"><dt>' + label + '</dt><dd>' + counts[stage] + '</dd></div>').join('') + '</dl>';
  const lastShipped = '<p class="roadmap-last-shipped"><span>Last shipped</span><b>' + esc(shipped[0]?.milestone.name || 'None yet') + '</b>'
    + (shipped[0]?.milestone.note ? '<small>' + esc(firstLine(shipped[0].milestone.note)) + '</small>' : '') + '</p>';
  const mobileShipping = '<section class="roadmap-shipping roadmap-mobile-shipping" aria-label="Shipping counts">' + shippingCounts + lastShipped + '</section>';
  const mobileHistory = '<section class="roadmap-shipping roadmap-mobile-shipping" aria-label="Last shipped release">' + lastShipped + '</section>';
  /** Keep supplied landed progress beside an upcoming release without a modern summary. */
  const count = (m) => m.total ? '<span class="milestone-count" aria-label="' + m.done + '/' + m.total + ' landed">' + m.done + '/' + m.total + ' landed</span>' : '';
  /** Show the backend's capacity independently of remaining-work headers, including empty and shipped plans [N26]. */
  const capacity = (m) => Number.isSafeInteger(m.milestone.limit) && m.milestone.limit >= 0 && Number.isSafeInteger(m.milestone.count) && m.milestone.count >= 0
    ? '<span class="milestone-limit">' + m.milestone.count + '/' + m.milestone.limit + ' items</span>' : '';
  /** Render the existing milestone items, progress and complete note when opened. */
  const body = (read) => {
    const { milestone, rows, done, total } = read;
    const progress = headerFor(read) ? '' : '<svg class="milestone-progress" viewBox="0 0 100 1" preserveAspectRatio="none" role="progressbar" aria-label="' + esc(milestone.name) + ': ' + done + ' of ' + total + ' landed" aria-valuemin="0" aria-valuemax="' + total + '" aria-valuenow="' + done + '"><rect width="' + (total ? (100 * done) / total : 0) + '" height="1"/></svg>';
    return (rows.length ? progress + '<ul>' + rows.map((row) => milestoneRow(row, titles, view.roadmapHeld === milestone.name && !row.held)).join('') + '</ul>' : '<p class="milestone-empty">No items yet.</p>')
      + (milestone.note ? '<p class="milestone-note">' + rich(milestone.note, titles) + '</p>' : '');
  };
  /** Keep folding consistent with the View's other keyboard-accessible disclosure controls. */
  const wrap = (tag, classes, key, first, heading, contents, afterHead = '') => {
    const open = isOpen(key, first);
    return '<' + tag + ' class="' + classes + '" data-key="' + esc(key) + '"><div class="milestone-head" data-roadmap-key="' + esc(key) + '" role="button" tabindex="0" aria-expanded="' + open + '">' + heading.replace('<h2>', '<h2>' + caret) + '</div>' + afterHead + '<div class="milestone-body"' + (open ? '' : ' hidden') + '>' + contents + '</div></' + tag + '>';
  };
  /** Open every upcoming milestone by default; the person's current-page fold remains in the view map. */
  const card = (m) => {
    const header = headerFor(m);
    const legacyTarget = m.milestone.target ? '<div class="milestone-targetline">Target <time datetime="' + esc(m.milestone.target) + '">' + when(m.milestone.target) + '</time>' + (m.milestone.pastTarget ? ' <span class="chip warn">past target</span>' : '') + '</div>' : '';
    return wrap('section', 'card-panel milestone' + (header ? ' roadmap-has-summary' : ''), 'm:' + m.milestone.name, true,
      '<h2>' + linked(m.milestone.name, titles) + '</h2>' + (header ? header.count : count(m)) + capacity(m), body(m), header ? header.detail + (m === next ? mobileHistory : '') : legacyTarget + (m === next ? mobileShipping : ''));
  };
  /** Summarize one shipped milestone with its first note line and total count. */
  const line = (m) => wrap('div', 'milestone shipped-one', 'm:' + m.milestone.name, false, '<h2>' + esc(m.milestone.name) + '</h2><small>' + esc(firstLine(m.milestone.note)) + '</small>' + (m.milestone.shipped?.commit ? '<code class="roadmap-shipped-commit" title="' + esc(m.milestone.shipped.commit) + '">' + esc(m.milestone.shipped.commit.slice(0, 12)) + '</code>' : '') + '<span class="milestone-count">' + m.total + (m.total === 1 ? ' item' : ' items') + '</span>' + capacity(m), body(m));
  const releaseButtons = coming.map((m) => {
    const key = 'm:' + m.milestone.name;
    return '<button class="roadmap-release" data-roadmap-jump="' + esc(key) + '" type="button"><span>' + esc(m.milestone.name) + '</span><b>' + m.done + '/' + m.total + '</b></button>';
  }).join('');
  const shippedButton = shipped.length
    ? '<button class="roadmap-release" data-roadmap-jump="shipped" type="button"><span>Shipped</span><b>' + shipped.length + '</b></button>' : '';
  const releasePanel = '<aside class="card-panel roadmap-panel" id="roadmap-panel" aria-label="Roadmap releases and shipping">'
    + '<section class="roadmap-release-index"><h2>Releases</h2><nav class="roadmap-releases" id="roadmap-releases" aria-label="Roadmap releases">' + releaseButtons + shippedButton + '</nav></section>'
    + '<section class="roadmap-shipping roadmap-desktop-shipping" aria-label="Shipping counts"><h2>Shipping</h2><h3 class="roadmap-next-release">' + esc(next?.milestone.name || 'No upcoming release') + '</h3>'
    + shippingCounts + lastShipped + '</section></aside>';
  const roadmapList = '<div class="roadmap-list" id="roadmap-list">' + lead + (milestones.length ? coming.map(card).join('') : '<div class="card-panel empty">No milestones yet. The coordinator adds one with <code class="inline">pullboard milestone add</code>.</div>')
    + (shipped.length ? wrap('section', 'card-panel shipped', 'shipped', false, '<h2>Shipped</h2><span class="milestone-count">' + shipped.length + (shipped.length === 1 ? ' release' : ' releases') + '</span>', shipped.map(line).join('')) : '') + '</div>';
  // With no releases there is nothing to jump to, so the Roadmap is its list alone, as before the panel.
  return (milestones.length ? releasePanel : '') + roadmapList;
}

/** Tags that flow inside a line of text, so a reference's line belongs to the nearest block around it. */
const INLINE_TAGS = new Set(['SPAN', 'B', 'I', 'EM', 'STRONG', 'CODE', 'S', 'SMALL', 'TIME', 'MARK', 'U', 'SUB', 'SUP', 'ABBR', 'KBD', 'Q', 'LABEL']);
const CONTROLS = 'button, a[href], select, input, textarea, [role=button]';

/**
 * Whether a reference sits in running text: words that are not another control's share its line, between line breaks,
 * in the nearest block around it. A reference standing alone is a target like any button.
 */
function inText(ref) {
  let block = ref.parentElement;
  while (block.parentElement && INLINE_TAGS.has(block.tagName)) block = block.parentElement;
  const worded = [];
  let line = 0, at = 0;
  const walk = document.createTreeWalker(block, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT);
  for (let n = walk.nextNode(); n; n = walk.nextNode()) {
    if (n === ref) at = line;
    else if (n.nodeName === 'BR') line += 1;
    else if (n.nodeType === 3 && n.data.trim()) {
      const owner = n.parentElement.closest(CONTROLS);
      if (!owner || owner === block || !block.contains(owner)) worded[line] = true;
    }
  }
  return Boolean(worded[at]);
}

// Wherever the page draws a reference, one standing alone is marked, and takes a 44px target where a finger taps. The
// tests' stand-in document, which is not a browser, has no observer, and there nothing is marked.
if (typeof MutationObserver === 'function') new MutationObserver((changes) => {
  for (const root of new Set(changes.map((change) => change.target))) {
    if (root.nodeType === 1) for (const ref of root.querySelectorAll('button.ref, a.ref[data-go]')) ref.classList.toggle('alone', !inText(ref));
  }
}).observe(document.body, { childList: true, subtree: true });

const releaseNotices = new Map();

/** Compare already parsed release versions without treating 0.8.10 as older than 0.8.9. */
function newerRelease(version, previous) {
  if (!/^[0-9]+[.][0-9]+[.][0-9]+$/.test(previous)) return false;
  const left = version.split('.').map(Number), right = previous.split('.').map(Number);
  for (let index = 0; index < 3; index += 1) if (left[index] !== right[index]) return left[index] > right[index];
  return false;
}

/** Remember one upgrade per board while retaining its card through this page's background refreshes. */
function renderReleaseNotes(project) {
  const region = $('upgrade-note');
  region.hidden = true;
  if (snapshot || !project?.releaseNotes) return;
  const info = project.releaseNotes;
  let notice = releaseNotices.get(project.root);
  if (notice?.version !== info.version) {
    const key = 'pb.release.' + project.root;
    const previous = keep(key);
    const releases = previous ? info.releases.filter((release) => newerRelease(release.version, previous)) : [];
    notice = { version: info.version, releases, notes: info.notes };
    releaseNotices.set(project.root, notice);
    keep(key, info.version);
  }
  if (!notice.releases.length) return;
  region.innerHTML = '<header><h2>New in ' + esc(notice.version) + '</h2><button class="ghost" type="button" data-upgrade-dismiss>Dismiss</button></header>'
    + notice.releases.slice(0, 3).map((release) => '<article><h3>' + esc(release.version) + ' · ' + esc(release.headline) + '</h3><p>' + esc(release.paragraph) + '</p></article>').join('')
    + '<footer>' + (notice.releases.length > 3 ? '<span>+' + (notice.releases.length - 3) + ' more</span> · ' : '')
    + '<a href="' + esc(notice.notes) + '" target="_blank" rel="noopener noreferrer">Full release notes</a></footer>';
  region.hidden = false;
}

/** Draw the board shown: the sidebar, then every tab's panes from the project's board. */
function render() {
  // A refresh that moved the page to another board closes a confirmation opened on the last one.
  closeIfLeft();
  if (heldClickPointer !== null || pageDialogs.size) { deferredClickRender = true; return; }
  deferredClickRender = false;
  const statsFocus = document.activeElement?.id === 'proof-stats-summary' ? document.activeElement.id : null;
  const p = data.project;
  const group = data.group;
  renderSide();
  // A list that names a board no read has answered yet is still loading, never a machine without boards (#1035).
  const listing = !p && !group && data.projects.some((entry) => entry.ok);
  $('project-loading').hidden = data.root === view.root && !listing;
  if (data.root !== view.root || listing) {
    // Keep the cached picker available, but never label the last board's counts as the new one.
    document.querySelectorAll('[data-pane]').forEach((pane) => { pane.hidden = true; });
    for (const id of ['products', 'group-view', 'proof-stats', 'upgrade-note', 'person-requests', 'credentials', 'find-results']) $(id).hidden = true;
    $('status-board').innerHTML = '';
    $('live').textContent = 'Loading project…';
    return;
  }
  $('proof-stats').hidden = true;
  $('proof-stats').innerHTML = '';
  if (view.answering && view.answering.root !== view.root) answer(null);
  // Until the first board arrives the page shows no tabs or panes, so a machine with none never
  // flashes them; with no board to show, one message says how a board starts, in their place.
  document.body.classList.remove('loading');
  document.body.classList.toggle('boardless', !p && !group);
  $('group-view').hidden = !group;
  $('tabs').hidden = Boolean(group);
  document.querySelectorAll('[data-pane]').forEach((pane) => { pane.hidden = Boolean(group) || pane.dataset.pane !== view.tab; });
  $('products').hidden = !p || !p.products.length;
  renderReleaseNotes(group ? null : p);
  renderHostedReleaseNote(p);
  renderPersonRequests(p);
  renderCredentials();
  if (view.tab === 'settings') { $('group-view').hidden = true; showTab(); return; }
  if (group) { renderGroup(group); return; }
  if (!p) return;
  $('proof-stats').hidden = false;
  $('proof-stats').innerHTML = proofStatsCard(p.proofStats, view.statsOpen);
  // Polling replaces this card's controls; keep the person's keyboard position through that redraw.
  if (statsFocus && view.tab === 'items') $(statsFocus)?.focus({ preventScroll: true });
  // Each product's progress (N28): the rows an accepted item cites, and its items by state.
  $('prod-list').innerHTML = p.products.map((x) => {
    const states = [['open', '', x.items.open], ['building', 'building', x.items.claimed], ['to verify', 'verify', x.items.submitted], ['verified', 'verified', x.items.verified]].filter(([, , n]) => n);
    return '<div class="prod" title="' + x.rows + ' rows in force, ' + x.approved + ' approved, ' + x.proven + ' cited by accepted items"><p><b>' + esc(x.name) + '</b><span>' + x.proven + '/' + x.rows + ' rows met</span></p><svg class="bar" viewBox="0 0 100 1" preserveAspectRatio="none" aria-hidden="true"><rect width="' + (x.rows ? Math.round((100 * x.proven) / x.rows) : 0) + '" height="1"/></svg>'
      + (states.length ? '<small>' + states.map(([label, dot, n]) => '<span><i class="dot ' + dot + '"></i>' + n + ' ' + label + '</span>').join('') + '</small>' : '') + '</div>';
  }).join('');
  const items = p.items.filter((i) => i.status !== 'withdrawn');
  const active = items.filter((i) => stateOf(i) !== 'verified');
  const titles = new Map(p.items.map((i) => [String(i.id), i.title]));
  // Every refresh redraws the Roadmap. Left alone, that would send the phone's release chips back to their start
  // and the panel back to its top under a person mid-scroll, so both keep where they were.
  const chipsAt = $('roadmap-releases')?.scrollLeft ?? 0, panelAt = $('roadmap-panel')?.scrollTop ?? 0;
  roadmapAhead.clear();
  $('roadmap').innerHTML = roadmapCards(p, titles);
  // The mark sets its chip in bold, which widens it, and the fresh row has no mark yet. Restored first, the scroll
  // would clamp to a row narrower by that bold and leave the chips short of where they were (#452).
  updateRoadmapPanel();
  if ($('roadmap-releases')) $('roadmap-releases').scrollLeft = chipsAt;
  if ($('roadmap-panel')) $('roadmap-panel').scrollTop = panelAt;

  // What needs the person, first, and only the person's calls (B26): the decisions passed up to them,
  // questions in the spec, held lanes, then draft rows. Work waiting for a verdict or sent back shows
  // on the board with who holds it; it is the agents' to move.
  const personalNeeds = personNeeds(p);
  // Adapt display targets and the existing hold age without reimplementing which calls belong here.
  const needs = personalNeeds.filter((row) => !['draft', 'rigor-draft', 'sentinel-draft', 'agent-approved'].includes(row.kind)).map((row) => row.kind === 'spec-revision' ? { revision: row } : row.kind === 'decision'
    ? ['decide:' + row.id, row.ref, row.text, 'decide', row.at]
    : row.kind === 'pending' ? ['spec:' + row.id, row.ref, row.text, 'answer ' + row.ref] // the person's words; agents get the command (#875)
      : row.kind === 'block' ? [null, row.ref, row.text, row.what, row.at, 'block']
        : ['tab:shouts', row.ref, row.text, row.what, p.holds.find((hold) => hold.hold_lane === row.id)?.hold_at]);
  const drafts = personalNeeds.find((row) => row.kind === 'draft')?.count ?? 0;
  const rigorDrafts = personalNeeds.filter((row) => row.kind === 'rigor-draft');
  const sentinelDrafts = personalNeeds.filter((row) => row.kind === 'sentinel-draft');
  const agentApprovals = personalNeeds.filter((row) => row.kind === 'agent-approved');
  // Each of the person's calls is a row at the head of Active, shaped like an item: what it is first, then NEEDS YOU and
  // its kind where an item has its lane, and what to do at the right. Every call is a row; the draft rows are one row
  // with their count. Read-only, a row is its words, opening nothing.
  $('needs').hidden = (!needs.length && !drafts && !rigorDrafts.length && !sentinelDrafts.length && !agentApprovals.length) || view.state !== 'active' || Boolean(view.lane);
  const needRow = ([target, ref, text, what, at], kind, action) => '<li class="row ask"' + (readOnly || !target ? '' : ' data-go="' + esc(target) + '"') + '><span class="dot ask"></span><div><div class="t">' + (ref ? '<span>' + esc(ref) + '</span>' : '') + rich(text, titles, !readOnly) + '</div>'
    + (at ? '<span class="row-age">' + age(at) + '</span>' : '') + '<div class="meta"><span class="why"><b>NEEDS YOU</b> ' + esc(kind) + '</span></div></div><span class="chip warn">' + esc(action) + '</span></li>';
  const needKind = (entry) => entry.revision ? specRevisionRow(entry.revision) : entry[5] === 'block' ? needRow(entry, entry[3], 'next step')
    : entry[3] === 'decide' ? needRow([entry[0], '', entry[2], entry[3], entry[4]], 'a decision, asked by ' + entry[1], 'decide')
      : entry[0].startsWith('spec:') ? needRow(entry, 'an open question in SPEC.md', 'answer') : needRow(entry, entry[3], 'release');
  const needsHtml = needs.map(needKind).join('')
    + rigorDrafts.map(row => needRow([row.unproved && !row.materialized ? null : row.target, row.ref,
      row.unproved && !row.materialized ? row.text + ' ' + row.what : row.text],
    row.unproved ? 'an unproved Rigor proposal' + (row.evidence?.occurrences ? ', repeated ' + row.evidence.occurrences + (row.evidence.occurrences === 1 ? ' time' : ' times') : '') : 'a proved Rigor draft',
    row.unproved && !row.materialized ? 'prepare review' : 'Approve or Decline')).join('')
    + sentinelDrafts.map(row => sentinelDraftRow(row)).join('')
    + agentApprovals.map(row => agentApprovalRow(row)).join('')
    + (drafts ? needRow(['tab:spec', String(drafts), 'draft spec rows to approve or drop'], 'Spec rows waiting on you', 'review') : '');
  $('needs').innerHTML = needsHtml;
  // Home reads the rules first, then the same calls (#967).
  $('home-rules').innerHTML = homeRules(p.spec);
  $('home-needs').innerHTML = needsHtml;
  $('home-calm').hidden = Boolean(needsHtml);

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
  const pipeline = view.itemsView === 'pipeline';
  $('items-view-switch').innerHTML = ['list', 'pipeline'].map((mode) => '<button type="button" data-items-view="' + mode + '" aria-pressed="' + (view.itemsView === mode) + '" class="' + (view.itemsView === mode ? 'on' : '') + '">' + (mode === 'list' ? 'List' : 'Pipeline') + '</button>').join('');
  $('item-list').hidden = pipeline;
  $('pipeline').hidden = !pipeline;
  // Each Show choice counts what it would show under the lane and the search. A search looks through every
  // state, withdrawn items included; browsing leaves those out.
  const found = searchIds(p, q);
  const matching = (q ? p.items : items).filter((item) => !q || found.has(item.id));
  // Gated is one test, shared by the rows, the Gated filter and the status bar: open and waiting on an item or a held lane.
  const heldLanes = new Map(p.holds.map((h) => [h.hold_lane, h]));
  const gatedOf = (i) => stateOf(i) === 'open' && (i.blockedBy.length > 0 || heldLanes.has(i.lane));
  const inState = (s) => (i) => s === 'all' || (s === 'active' ? !['verified', 'withdrawn'].includes(stateOf(i)) : s === 'gated' ? gatedOf(i) : stateOf(i) === s);
  const names = { active: 'Active', verified: 'Verified', all: 'All' };
  // The status bar can open a narrower list; it shows as a fourth choice until another is picked.
  if (view.state === 'verify') names.verify = 'To verify';
  if (view.state === 'gated') names.gated = 'Gated';
  // A lane narrows the list as a state does, and each counts within the other's choice.
  const inLane = (lane) => (i) => !lane || i.lane === lane;
  if (view.lane && !matching.some(inLane(view.lane))) view.lane = null;
  const stateOptions = Object.keys(names).map((s) => '<button class="filter-option" role="menuitemradio" aria-checked="' + (view.state === s) + '" data-filter-choice="state:' + s + '" data-filter-kind="state" data-filter-value="' + s + '" data-state="' + s + '" type="button"><span class="filter-option-label">' + names[s] + '</span><b>' + matching.filter(inLane(view.lane)).filter(inState(s)).length + '</b></button>');
  const inView = pipeline ? matching.filter((item) => item.status !== 'withdrawn') : matching.filter(inState(view.state));
  const laneCounts = [...inView.reduce((m, i) => m.set(i.lane, (m.get(i.lane) || 0) + 1), new Map())].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  if (view.lane && !laneCounts.some(([lane]) => lane === view.lane)) laneCounts.push([view.lane, 0]);
  const laneOptions = [['', 'All lanes', null], ...laneCounts.map(([lane, n]) => [lane, lane, n])].map(([lane, label, count]) => '<button class="filter-option" role="menuitemradio" aria-checked="' + ((view.lane || '') === lane) + '" data-filter-choice="lane:' + esc(lane) + '" data-filter-kind="lane" data-filter-value="' + esc(lane) + '" aria-label="' + esc(label) + (count === null ? '' : ' · ' + count) + '" title="' + esc(label) + (count === null ? '' : ' · ' + count) + '" type="button"><span class="filter-option-label">' + esc(label) + '</span>' + (count === null ? '' : '<b>' + count + '</b>') + '</button>');
  const activeChoice = document.activeElement?.dataset?.filterChoice;
  const menu = $('filter-menu');
  menu.innerHTML = (pipeline ? '' : '<section class="filter-group" role="group" aria-label="Show"><h3>Show</h3>' + stateOptions.join('') + '</section>')
    + '<section class="filter-group" role="group" aria-label="Lane"><h3>Lane</h3>' + laneOptions.join('') + '</section>';
  menu.hidden = !view.filterOpen;
  menu.style.left = '0px';
  menu.style.maxWidth = '';
  if (view.filterOpen) {
    // The open menu stays inside the toolbar, no wider than it and shifted left as far as it needs. The window's
    // width is no measure of that room: it counts a classic scrollbar, so on CI's runners a menu kept inside the
    // window still reached 10px past the toolbar (#442).
    const bar = $('items-toolbar'), box = bar.getBoundingClientRect(), left = box.left + bar.clientLeft, right = left + bar.clientWidth;
    menu.style.maxWidth = Math.min(320, bar.clientWidth) + 'px';
    const at = menu.getBoundingClientRect();
    menu.style.left = Math.max(left - at.left, Math.min(0, right - at.right)) + 'px';
  }
  $('filter-toggle').setAttribute('aria-expanded', String(view.filterOpen));
  const stateLabel = pipeline || view.state === 'active' ? '' : names[view.state] || '';
  const laneLabel = view.lane || '';
  const filterLabel = stateLabel || laneLabel ? 'Filter: ' + [stateLabel, laneLabel].filter(Boolean).join(' · ') : 'Filter';
  $('filter-label').textContent = filterLabel;
  $('filter-toggle').setAttribute('aria-label', filterLabel);
  $('filter-toggle').title = filterLabel;
  if (view.filterOpen && activeChoice) [...menu.querySelectorAll('[data-filter-choice]')].find((option) => option.dataset.filterChoice === activeChoice)?.focus({ preventScroll: true });
  const shown = inView.filter(inLane(view.lane)).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  const finishedUnderAll = !shown.length && p.items.length > 0 && p.items.every((item) => stateOf(item) === 'verified')
    && view.tab === 'items' && view.itemsView === 'list' && view.state === 'active' && !view.lane && !q && !snapshot;
  $('pipeline').innerHTML = pipeline ? pipelineCard(shown) : '';
  // With nothing picked, the detail shows the first row, and keeps it when a refresh reorders the list.
  // While another project loads, the item picked there waits for its own board.
  if (data.root === view.root && !view.adding && !(view.tab === 'items' && view.addressDetail !== null && view.addressDetail !== 'pipeline') && !p.items.some((i) => i.id === view.item)) view.item = shown.length ? shown[0].id : null;
  // An open item's chip, the same in its row and its detail: gated, its lane held, or unclaimed.
  const openChip = (i) => (p.itemHolds || []).some((h) => h.item === i.id) ? heldChip(heldNote(i, p)) : i.blockedBy.length || heldLanes.has(i.lane) ? '<span class="chip gate">' + (i.blockedBy.length ? 'gated' : 'lane held') + '</span>' : chip('open');
  $('chain').innerHTML = shown.length ? shown.map((i) => {
    const s = stateOf(i);
    // What an open item waits on, if anything: items not yet verified, or a hold on its lane.
    const hold = s === 'open' ? heldLanes.get(i.lane) : null;
    const waits = s === 'open' && i.blockedBy.length ? i.blockedBy : [];
    const gated = gatedOf(i);
    const pills = (waits.length ? '<span class="gate">' + waits.map((id, index) => '<span class="wait-unit">' + (index ? '' : 'waits on ') + '<a class="ref" href="' + esc(itemAddress(id)) + '" data-go="item:' + id + '">#' + id + '</a></span>').join(', ') + '</span>' : '') + (hold ? '<span class="gate">lane held: ' + linked(hold.hold_reason, titles) + '</span>' : '');
    const holder = holderOf(i), reviewer = reviewerOf(i);
    const tag = s === 'building' && holder ? '<span class="chip busy" title="building, held by ' + esc(agentName(holder)) + '">' + esc(agentName(holder)) + '</span>'
      : s === 'verify' && reviewer ? '<span class="chip warn" title="reviewing until ' + esc(when(i.claim?.until ?? i.reviewUntil)) + '">' + esc(agentName(reviewer)) + ' reviewing</span>'
      : s === 'open' ? openChip(i) : chip(s);
    return recordRow({ classes: (view.item === i.id ? 'on ' : '') + (gated ? 'gated ' : ''), attributes: 'data-item="' + i.id + '"', title: i.title, state: s,
      primary: '<span>#' + i.id + '</span>' + rich(i.title, titles), rightTop: age(i.updatedAt), rightBottom: tag,
      // A rejected row's second line is its verdict; any other row's is its lane and the spec ids it serves.
      secondary: (rejected(i) ? '<span class="why"><b>' + esc(i.verdict.reason) + '</b> ' + linked(firstLine(visibleVerdictNote(i.verdict.reason, i.verdict.note)), titles) + '</span>'
        : '<span>' + esc(i.lane) + '</span>' + (i.specs.length ? '<span class="specs" title="' + esc(i.specs.join(', ')) + '">' + esc(i.specs.slice(0, 3).join(', ') + (i.specs.length > 3 ? ' +' + (i.specs.length - 3) : '')) + '</span>' : '')) + pills + staleChip(i) });
  }).join('') : '<li class="empty">' + (finishedUnderAll
    ? 'Finished work is under All. <button class="link" data-filter-choice="state:all" data-filter-kind="state" data-filter-value="all" type="button">Show all</button>'
    : items.length ? 'No items match.' : snapshot ? 'No items at this event.' : 'No items yet. Add the first one with New item.') + '</li>';

  const selected = p.items.find((i) => i.id === view.item);
  // The form shows when asked for, or when the project has no item at all, withdrawn ones included.
  const adding = view.adding || (!p.items.length && !(view.tab === 'items' && view.addressDetail !== null && view.addressDetail !== 'pipeline'));
  $('add-form').hidden = !adding;
  $('add-cancel').hidden = !p.items.length;
  $('detail').hidden = adding;
  if (!selected) $('detail').innerHTML = '<div class="empty">' + (view.tab === 'items' && view.addressDetail !== null && view.addressDetail !== 'pipeline' ? 'No item #' + esc(view.addressDetail) + ' exists here.' : 'Pick an item to see its criterion, verdicts and history.') + '</div>';
  const opened = selected && !view.adding ? detailOf(p, selected, view.tab === 'items' && data.root === view.root) : null;
  /** An item's heading: its id, title, state, lane and route, all of which its summary holds. */
  const head = (item, s = stateOf(item)) => '<div><h2><span>#' + item.id + '</span>' + rich(item.title, titles) + '</h2><div class="meta spaced">' + (s === 'open' ? openChip(item) : chip(s)) + staleChip(item) + '<span class="chip">' + esc(item.lane) + '</span><span class="chip">' + esc(item.route) + '</span></div></div>';
  if (opened?.error) $('detail').innerHTML = '<div class="stack"><p class="detail-wait muted" role="status">Could not load #' + selected.id + ': ' + esc(opened.error) + '</p></div>';
  // Until its omitted fields arrive, an opened item paints its heading from its summary and fills the rest in place (#1039).
  else if (opened?.loading) $('detail').innerHTML = '<div class="stack" aria-busy="true">' + head(selected) + '</div>';
  const item = opened?.item;
  if (item) {
    const s = stateOf(item);
    const cited = item.specs.map((id) => p.spec.find((r) => r.id === id) || { id, status: 'missing', text: '(not in SPEC.md)' });
    const baseline = item.checkBaseline;
    const baselineClass = baseline?.result === 'green' ? 'ok' : baseline?.result === 'red' ? 'no' : baseline?.result === 'pending' ? 'warn' : '';
    const factRefs = (item.thread || []).filter((entry) => entry.type === 'fact' && entry.ref);
    const referencedCode = factRefs.length ? '<div><h3>Referenced code</h3>' + factRefs.map((fact) => {
      const ref = fact.ref;
      const path = typeof ref.path === 'string' ? ref.path : '';
      const start = ref.start;
      const end = ref.end;
      const commit = typeof ref.commit === 'string' ? ref.commit : '';
      const safePath = /^[\\w.-]+(?:\\/[\\w.-]+)*$/.test(path) && !path.split('/').some((part) => part === '.' || part === '..');
      const safeRange = Number.isSafeInteger(start) && start > 0 && Number.isSafeInteger(end) && end >= start;
      const safeCommit = /^[0-9a-f]{40}$/.test(commit);
      if (!safePath || !safeRange || !safeCommit) {
        const missing = [!safePath && 'repository path', !safeRange && 'line range', !safeCommit && 'full commit SHA'].filter(Boolean).join(', ');
        return '<div class="fact-code"><span class="chip">' + esc(fact.kind) + '</span> <span class="muted">' + esc(agentName(fact.by)) + ' · ' + age(fact.at) + '</span><div class="code no ref-missing" role="status">Code reference unavailable: missing or invalid ' + esc(missing) + '.</div></div>';
      }
      const range = path + ':' + start + (end === start ? '' : '-' + end) + '@' + commit;
      return '<div class="fact-code"><span class="chip">' + esc(fact.kind) + '</span> <span class="muted">' + esc(agentName(fact.by)) + ' · ' + age(fact.at) + '</span>' + codeRef(range, '', true) + '</div>';
    }).join('') + '</div>' : '';
    // Why it came back is the first thing the person reads; the verdicts before it stay below.
    const back = rejected(item);
    const earlier = back ? item.verdicts.slice(0, -1) : item.verdicts;
    $('detail').innerHTML = '<div class="stack">' + head(item, s)
      + (back ? '<div class="sentback"><h3>Sent back' + (s === 'building' ? ', being reworked' : s === 'verify' ? ', resubmitted' : s === 'withdrawn' ? ', then withdrawn' : '') + '</h3>' + verdictHtml(item.verdict, titles) + '</div>' : '')
      + (item.criterion ? '<div><h3>Criterion</h3><div class="text">' + rich(item.criterion, titles) + '</div></div>' : '')
      + (item.check ? '<div><h3>Check</h3><dl class="kv"><dt>command</dt><dd><code>' + esc(item.check) + '</code></dd><dt>baseline</dt><dd><span class="chip ' + baselineClass + '">' + esc(baseline?.result ?? 'not recorded') + '</span></dd></dl>'
        + (baseline?.warning === 'CRITERION_PROVES_NOTHING' ? '<p class="check-warning">This check already passed before the work, so it proves nothing.</p>' : '') + '</div>' : '')
      + referencedCode
      + (cited.length ? '<div><h3>Spec rows it serves</h3>' + cited.map((r) => '<div class="rowref"><code>' + esc(r.id) + '</code><div>' + linked(r.text, titles) + ' <span class="chip ' + tone(r.status) + '">' + esc(r.status) + '</span></div></div>').join('') + '</div>' : '')
      + (item.brief ? '<div><h3>Brief</h3><div class="text muted">' + rich(item.brief, titles) + '</div></div>' : '')
      + '<div><h3>People and commits</h3><dl class="kv">' + (item.owner && s === 'building' ? '<dt>holding</dt><dd>' + esc(agentName(item.owner)) + '</dd>' : '') + (item.builtBy ? '<dt>built by</dt><dd>' + esc(agentName(item.builtBy)) + '</dd>' : '') + (item.verifiedBy ? '<dt>verified by</dt><dd>' + esc(agentName(item.verifiedBy)) + '</dd>' : '') + (item.commit ? '<dt>commit</dt><dd><code>' + esc(item.commit.slice(0, 12)) + '</code></dd>' : '') + (item.merged ? '<dt>merged</dt><dd><code>' + esc(item.merged.slice(0, 12)) + '</code></dd>' : '') + (item.blockedBy.length ? '<dt>waits on</dt><dd class="waits-on">' + item.blockedBy.map((id) => '<span class="wait-unit"><a class="ref" href="' + esc(itemAddress(id)) + '" data-go="item:' + id + '">#' + id + '</a></span>').join(', ') + '</dd>' : '') + '</dl></div>'
      + (back && !earlier.length ? '' : '<div><h3>' + (back ? 'Earlier verdicts' : 'Verdicts') + '</h3>' + (earlier.length ? earlier.map((v) => verdictHtml(v, titles)).join('') : '<div class="muted">None yet.</div>') + '</div>')
      + '<div><h3>History</h3>' + timeline(item) + '</div>'
      + '<div class="links"><button class="ghost" data-shout="' + esc(item.lane) + '" data-about="' + item.id + '" type="button">Shout the ' + esc(item.lane) + ' lane about #' + item.id + '</button><button class="go" data-new type="button">New item</button></div></div>';
  }

  // Every #id in a shout that names an item opens it, whatever stands next to it. The ids are found in
  // the raw text and each piece is escaped on its own, so an apostrophe's &#39; is never read as one;
  // a number that names no item stays text. A path:lines@commit reference opens that code (B23). It
  // counts only as a whole word, never as the tail of one, so what it opens is what it says, and the
  // view refuses what is no path in the repo.
  const mark = (x) => (x.shout_decision ? '<span class="mark ask" role="group" title="decision" aria-label="decision">decision</span> ' : x.shout_answers ? '<span class="mark" role="group" title="answer" aria-label="answer">answer</span> ' : '');
  // Evidence a shout carries (B22), as the fields it is: its kind and outcome, the item, who sent it,
  // and the commit, shortened, with the full SHA on hover.
  const evidence = (x) => (x.shout_evidence_kind ? '<div class="receipt"><div><span class="badge">' + esc(x.shout_evidence_kind) + '</span> <span class="outcome">' + esc(x.shout_evidence_outcome) + '</span></div>'
    + '<div class="receipt-foot">' + linked('#' + x.shout_evidence_item, titles) + ' · ' + esc(agentName(x.shout_from)) + ' · ' + codeChip(String(x.shout_evidence_commit), 'sha') + '</div></div>' : '');
  // A shout as a card (#250): who, in a colour of their own, to whom, its item and when on top; what was said
  // below. An ask carries a band until it is answered; a long shout folds at six lines.
  const hue = (id) => [...String(id)].reduce((h, c) => (h * 31 + c.charCodeAt(0)) >>> 0, 7) % 8;
  const initials = (id) => { const [name, rest = ''] = String(id).split(/[-_ ]/); const digits = rest.replace(/\\D/g, ''); return (name.slice(0, digits ? 1 : 2) + digits.slice(0, 3)).toUpperCase(); };
  const open = new Set([...p.decisions, ...p.asked].map((d) => d.shout_id));
  const answerOf = new Map(p.shouts.filter((y) => y.shout_answers).map((y) => [y.shout_answers, y]));
  const band = (x) => !x.shout_decision ? '' : open.has(x.shout_id) ? '<div class="band">Decision needed</div>'
    : '<div class="band done">Answered' + (answerOf.has(x.shout_id) ? ' by ' + esc(agentName(answerOf.get(x.shout_id).shout_from)) + ': <a href="#shout-' + answerOf.get(x.shout_id).shout_id + '">see the answer</a>' : '') + '</div>';
  // The shout's item: the first #N in its text that names an item on this board, or else its evidence's.
  const itemOf = (x) => [...String(x.shout_text).matchAll(/#(\\d+)/g)].map((m) => String(Number(m[1]))).find((id) => titles.has(id)) || x.shout_evidence_item;
  // The coordinator's mark is the board's own: a square with the Pullboard logo, so it stands out from the agents.
  const LEAD = '<svg viewBox="0 0 64 64" aria-hidden="true"><path fill="currentColor" d="M8 7h35a6 6 0 0 1 6 6v7H8a5 5 0 0 1-5-5v-3a5 5 0 0 1 5-5Z"/><rect width="56" height="14" x="3" y="25" fill="var(--accent)" rx="5"/><path fill="currentColor" d="M8 43h35a6 6 0 0 1 6 6v8H8a5 5 0 0 1-5-5v-4a5 5 0 0 1 5-5Z"/></svg>';
  const lead = (from) => from === 'coordinator';
  // A shout's recipient in product words: the reserved coordinator+person address and item:<id> are internal.
  const shoutTo = (to) => {
    if (to === 'coordinator+person') return 'coordinator and you';
    const item = /^item:([1-9]\\d*)$/.exec(String(to));
    return item ? '<a class="ref" href="' + esc(itemAddress(item[1], view.root)) + '" data-go="item:' + item[1] + '">#' + item[1] + '</a>' : shoutAgentName(to);
  };
  // Opened from the status bar's unread, the feed is exactly those shouts, the ones after the mark the person had.
  const unread = view.unread?.root === view.root ? view.unread : null;
  const addressed = addressedShouts.get(JSON.stringify([view.root, view.shout]));
  const shownShouts = addressed?.shout && !p.shouts.some((entry) => entry.shout_id === view.shout) ? [...p.shouts, addressed.shout] : p.shouts;
  const feedShouts = [...shownShouts, ...olderShoutsOf(view.root, shownShouts)];
  const heard = unread ? feedShouts.filter((x) => x.shout_id > unread.after) : view.agent ? feedShouts.filter((x) => x.shout_from === view.agent || x.shout_to === view.agent) : feedShouts;
  const bar = !unread && !view.agent ? '' : '<div class="feed-bar">' + (unread ? '<span><b>' + heard.length + '</b> unread <button class="link" data-unread type="button">show all</button></span>'
    : '<span>Shouts with <b>' + esc(agentName(view.agent)) + '</b> <button class="link" data-agent="" type="button">show all</button></span>') + '</div>';
  $('shouts-pane').classList.toggle('bare', view.agentsHidden);
  // Who has heard a shout of the person's: the agents it reached whose inbox has read past it. Each agent's read
  // cursor is already on the board, so this is presentation only; reading is all it says, not acting on it.
  const reached = (x, a) => a.agent_id !== x.shout_from && ['all', a.agent_id, a.agent_lane].includes(x.shout_to);
  const dot = (a) => '<span class="heard-face h' + hue(a.agent_id) + (lead(a.agent_id) ? ' lead' : '') + '">' + (lead(a.agent_id) ? LEAD : esc(initials(a.agent_id))) + '</span>';
  const heardBy = (x) => {
    if (x.shout_from !== 'person') return '';
    const to = p.agents.filter((a) => reached(x, a)), by = to.filter((a) => (a.agent_last_shout_id ?? 0) >= x.shout_id);
    // A shout that reaches no agent at all, such as one to a lane nobody has joined, has not been heard either.
    if (!by.length) return '<div class="heard not">Not heard yet</div>';
    const first = by.find((a) => lead(a.agent_id)) || by[0], rest = by.length - 1;
    return '<div class="heard" title="Heard by ' + esc(by.map((a) => agentName(a.agent_id)).join(', ')) + '"><span class="heard-faces">' + [first, ...by.filter((a) => a !== first)].slice(0, 4).map(dot).join('') + '</span>Heard by ' + esc(agentName(first.agent_id)) + (rest ? ' and ' + rest + (rest === 1 ? ' agent' : ' agents') : '') + '</div>';
  };
  // One card for a shout, in the feed and among the asks; tail adds what the place needs, such as Answer. Only the
  // feed's copy carries the band and the id an answer's link lands on, so an ask shown twice never repeats an id.
  // The person's own shout is signed "you", plainly, never as the coordinator that ran it.
  const card = (x, tail = '', inFeed = true) => '<article class="shout h' + hue(x.shout_from) + (lead(x.shout_from) ? ' lead' : '') + (openShouts.has(x.shout_id) ? ' open' : '') + (inFeed && x.shout_id === view.shout ? ' found' : '') + '"' + (inFeed ? ' id="shout-' + x.shout_id + '"' : '') + ' data-shout-id="' + x.shout_id + '">'
    + (lead(x.shout_from) ? '<span class="avatar">' + LEAD + '</span>' : '<span class="avatar' + (initials(x.shout_from).length > 3 ? ' wide' : '') + '" aria-hidden="true">' + esc(initials(x.shout_from)) + '</span>') + '<div class="shout-main">' + (inFeed && x.shout_id === view.shout ? '<h2 class="visually-hidden">Shout #' + x.shout_id + '</h2>' : '') + '<header><b class="who">' + (x.shout_from === 'person' ? 'you' : shoutAgentName(x.shout_from)) + '</b><span class="to">→ ' + shoutTo(x.shout_to) + '</span>'
    + (itemOf(x) ? '<span class="item">#' + esc(itemOf(x)) + '</span>' : '') + mark(x) + '<time class="long" data-ago="' + esc(x.shout_at) + '" title="' + esc(when(x.shout_at)) + '">' + agoLong(x.shout_at) + '</time></header>'
    + '<div class="text">' + rich(x.shout_text, titles) + (x.options ? '<ol>' + x.options.map((option) => '<li>' + esc(option) + '</li>').join('') + '</ol>' : '') + '</div><button class="more" data-more type="button">' + (openShouts.has(x.shout_id) ? 'less' : 'more') + '</button>' + (inFeed ? band(x) + heardBy(x) : '') + evidence(x) + tail + '</div></article>';
  $('feed').innerHTML = (view.shout !== null && !feedShouts.some((entry) => entry.shout_id === view.shout) ? '<p class="empty" id="shout-address-status" role="status">' + esc(addressed?.error || 'Loading shout #' + view.shout + '…') + '</p>' : '') + bar + (heard.length ? dayRules(heard, (x) => x.shout_at, card) : '<div class="empty">' + (unread ? 'No unread shouts.' : view.agent ? 'No shouts with ' + esc(agentName(view.agent)) + ' among the last forty.' : 'No shouts yet.') + '</div>');
  foldShouts();
  // Each ask waits here until answered (B21), typed in the form below; the person answers those passed up, the rest wait on their holder (B26).
  const coordinatorQueue = p.decisionQueue || []; $('coordinator-decisions').hidden = !coordinatorQueue.length; $('coordinator-decisions').innerHTML = coordinatorQueue.length ? '<div class="head"><i></i>Coordinator decisions</div>' + coordinatorQueue.map((d) => card(d, !readOnly && !requests && !snapshot ? '<button class="ghost answer" data-go="coordinate:' + d.shout_id + '" type="button">Answer as coordinator</button>' : '', false)).join('') : '';
  $('decisions').hidden = !p.decisions.length && !(p.asked.length && view.open.waiting);
  // The asks waiting on others are a toggle at the end of the composer's line, beside Show agents while the panel is hidden.
  $('asks-slot').innerHTML = (p.asked.length ? '<button class="asks-toggle" data-fold="waiting" type="button" aria-expanded="' + Boolean(view.open.waiting) + '" title="' + esc('Asks between agents, waiting on others: ' + p.asked.map((d) => agentName(d.shout_from) + ' asks ' + agentName(d.shout_to)).join(', ')) + '">' + p.asked.length + (p.asked.length === 1 ? ' ask' : ' asks') + ' waiting <span aria-hidden="true">' + (view.open.waiting ? '▴' : '▾') + '</span></button>' : '')
    + (view.agentsHidden ? '<button class="asks-toggle" data-agents-toggle type="button">Show agents</button>' : '');
  // The asks as the feed's cards, folded to three lines: the person's to answer, then those waiting on others.
  $('decisions').innerHTML = (p.decisions.length ? '<div class="head"><i></i>Decision needed</div>' + p.decisions.map((d) => card(d, '<button class="ghost answer" data-go="decide:' + d.shout_id + '" type="button">Answer</button>', false)).join('') : '')
    // Asks waiting on someone else are not the person's to answer: they show only once the composer's toggle opens them.
    + (p.asked.length && view.open.waiting ? p.asked.map((d) => card(d, '', false)).join('') : '');
  foldShouts();
  // Each agent with what it holds: its claim, then its work sent back or with a stale verdict to redo, then its work waiting
  // for a verdict. The worktree path is there on hover; what the person reads is who is doing what.
  // A review an agent holds (V15) comes right after its claim.
  const rank = (a, i) => i.status === 'claimed' ? 0 : reviewerOf(i) === a.agent_id ? 1 : stateOf(i) === 'back' || staleChip(i) ? 2 : 3;
  const holding = (a) => items.filter((i) => i.status === 'claimed' ? holderOf(i) === a.agent_id : reviewerOf(i) === a.agent_id || (i.builtBy === a.agent_id && (['back', 'verify'].includes(stateOf(i)) || staleChip(i)))).sort((x, y) => rank(a, x) - rank(a, y));
  // The agents at work: holding a claim or a review now, or moved in the last hour. Every agent is one click away;
  // work an idle agent left sent back or waiting stays on the Items tab.
  const recent = (a) => p.items.some((i) => (i.status === 'claimed' && holderOf(i) === a.agent_id) || (i.status === 'submitted' && reviewerOf(i) === a.agent_id))
    || (a.lastMoveAt && Date.now() - Date.parse(a.lastMoveAt) < 36e5);
  const listed = view.allAgents ? p.agents : p.agents.filter(recent);
  // As little room as the panel can take: an agent holding work is one row, with its avatar and colour from the feed,
  // the age of its latest move and what it holds; an agent holding nothing is a pill. A row or a pill filters the feed
  // to that agent's shouts, its lane and route on hover, and the picked agent's row opens out to each thing it holds.
  const busy = listed.filter((a) => holding(a).length), idle = listed.filter((a) => !holding(a).length);
  const face = (a) => lead(a.agent_id) ? '<span class="avatar">' + LEAD + '</span>' : '<span class="avatar' + (initials(a.agent_id).length > 3 ? ' wide' : '') + '" aria-hidden="true">' + esc(initials(a.agent_id)) + '</span>';
  const tip = (a) => 'Shouts with ' + agentName(a.agent_id) + ' · ' + a.agent_lane + ' · ' + a.agent_route + ' (' + a.agent_path + ')';
  // Beside the name there is room for one word, so a stale verdict says stale there; the opened rows say verified and stale.
  const state = (a, i, brief = false) => reviewerOf(i) === a.agent_id ? '<span class="chip warn">reviewing</span>' : (brief && staleChip(i)) || chip(stateOf(i)) + staleChip(i);
  const marks = (a) => ' h' + hue(a.agent_id) + (lead(a.agent_id) ? ' lead' : '') + (view.agent === a.agent_id ? ' on' : '');
  const row = (a) => {
    const mine = holding(a), first = mine[0];
    return '<div class="agent-card' + marks(a) + '"><button class="agent-row" data-agent="' + esc(a.agent_id) + '" title="' + esc(tip(a)) + '" type="button">' + face(a)
      + '<span class="agent-who"><b>' + esc(agentName(a.agent_id)) + '</b>' + state(a, first, true) + (mine.length > 1 ? '<span class="agent-more">+' + (mine.length - 1) + '</span>' : '') + (a.lastMoveAt ? '<time data-ago="' + esc(a.lastMoveAt) + '">' + ago(a.lastMoveAt) + '</time>' : '') + '</span>'
      + '<span class="agent-doing"><span class="agent-what"><i>#' + first.id + '</i> ' + esc(first.title) + '</span></span></button>'
      + (view.agent === a.agent_id ? mine.map((i) => '<div class="agent-work" data-item="' + i.id + '" data-go="item:' + i.id + '"><span>#' + i.id + ' ' + rich(i.title, titles) + '</span>' + state(a, i) + '</div>').join('') : '') + '</div>';
  };
  // The panel is for who is doing what: agents holding nothing fold to one line that opens to each of them, and stays
  // open while one of them is picked.
  if (idle.some((a) => a.agent_id === view.agent)) view.open.idle = true;
  // Show all ends the open fold while some agents have not moved lately, or stands alone when none is idle.
  const allAgents = p.agents.length > p.agents.filter(recent).length ? '<button class="link all-agents" data-all-agents type="button">' + (view.allAgents ? 'show only agents at work' : 'show all ' + p.agents.length) + '</button>' : '';
  const idleBlock = () => !idle.length ? allAgents : '<div class="agents-idle">' + foldLine('idle', idle.length + ' idle', idle.map((a) => agentName(a.agent_id)).join(', '))
    + (view.open.idle ? '<div class="idle-list">' + idle.map(pill).join('') + '</div>' + allAgents : '') + '</div>';
  const pill = (a) => '<button class="agent-pill' + marks(a) + '" data-agent="' + esc(a.agent_id) + '" title="' + esc(tip(a)) + '" type="button"><span>' + face(a) + esc(agentName(a.agent_id)) + '</span></button>';
  $('agents').innerHTML = (listed.length ? busy.map(row).join('') + idleBlock()
    : '<div class="empty">' + (p.agents.length ? 'No agent has moved today.' : 'No agents yet.') + '</div>');
  // The status bar: what the board is doing, along the foot of the window. Each number is the length of the list its
  // click opens (the Active and To verify filters, the gated rows, the agents panel's rows), and a part with none hides.
  // countUnseen fills the unread shouts once the tab is drawn.
  const release = nextMilestone(p), last = p.events[0];
  const part = (to, n, words, title) => n ? '<button type="button" data-status="' + to + '" title="' + esc(title) + '"><b>' + n + '</b> ' + words + '</button>' : '';
  $('status-board').innerHTML = part('items', active.length, 'items', 'Show the active items') + '<button type="button" id="status-unread" data-status="unread" title="Show the shouts you have not read" hidden></button>'
    + part('agents', busy.length, busy.length === 1 ? 'agent' : 'agents', 'Show the agents holding work: ' + busy.map((a) => agentName(a.agent_id)).join(', '))
    + part('verify', active.filter((i) => stateOf(i) === 'verify').length, 'to verify', 'Show the items waiting on a verdict')
    + part('gated', active.filter(gatedOf).length, 'gated', 'Show the open items waiting on another item or a held lane')
    + (release ? '<button type="button" data-status="release" title="' + esc('Show this release on the Roadmap: ' + (release.note || release.name)) + '">' + esc(release.name) + ' <b>' + release.done + '/' + release.total + '</b></button>' : '')
    + (last ? '<button type="button" class="end" data-status="' + (last.item_id ? 'item:' + last.item_id : 'activity') + '" title="' + esc(last.event_at) + '">' + esc(agentName(last.event_by)) + ' ' + esc(last.event_kind) + (last.item_id ? ' #' + last.item_id : '') + ' · ' + age(last.event_at) + '</button>' : '');
  const held = new Map(p.holds.map((h) => [h.hold_lane, h]));
  $('lanes').innerHTML = working.map((l) => '<div class="lane"><span><b>' + esc(l) + '</b> ' + (held.has(l) ? '<span class="chip no" title="held by ' + esc(agentName(held.get(l).hold_by)) + '">held by ' + esc(agentName(held.get(l).hold_by)) + '</span> <span class="muted">' + linked(held.get(l).hold_reason, titles) + '</span>' : '<span class="chip ok">open</span>') + '</span>' + (held.has(l) ? '<button class="ghost" data-release="' + esc(l) + '" type="button">Release</button>' : '') + '</div>').join('');

  $('spec-fit').innerHTML = (p.fit || []).length ? '<h3>Blueprint fit: ' + p.fit.length + ' unverified ' + (p.fit.length === 1 ? 'proposal' : 'proposals') + ' waiting for you</h3>' + p.fit.map(fitRow).join('') : '';
  for (const kind of ['spec', 'doctrine']) {
    const rows = kind === 'spec' ? p.spec : p.practice;
    const filter = view.rows[kind];
    const defaults = kind === 'doctrine' ? rows.filter((r) => r.origin === 'standard') : [];
    const labels = { decide: 'Needs your decision', ...(defaults.length ? { defaults: 'Defaults to review' } : {}), all: 'All rows', approved: 'Approved' };
    /** Inherited defaults are reviewed in the repo's doctrine; only local proposals ask for a decision. */
    const undecided = (r) => (['pending', 'draft'].includes(r.status) && !r.decision || !!r.staleDecision) && !(kind === 'doctrine' && r.origin === 'standard');
    const n = { decide: rows.filter(undecided).length, defaults: defaults.length, all: rows.length, approved: rows.filter((r) => r.status === 'approved').length };
    $(kind + '-chips').innerHTML = Object.keys(labels).map((f) => '<button data-rows="' + kind + ':' + f + '" class="' + (filter === f ? 'on' : '') + '" type="button">' + labels[f] + '<b>' + n[f] + '</b></button>').join('');
    const shownRows = rows.filter((r) => filter === 'all' || (filter === 'decide' ? undecided(r) : filter === 'defaults' ? r.origin === 'standard' : r.status === 'approved'));
    // With no row picked, or the pick filtered out, the detail opens on the first row shown, as Items does.
    if (!(view.tab === kind && view.addressDetail !== null) && !shownRows.some((r) => r.id === view.row[kind])) view.row[kind] = shownRows[0]?.id ?? null;
    const feedback = view.specFeedback?.kind === kind && view.specFeedback.root === view.root && view.specFeedback.from === 'list' ? view.specFeedback : null;
    const feedbackId = feedback && (shownRows.some((r) => r.id === feedback.id) ? feedback.id : shownRows.some((r) => r.id === feedback.next) ? feedback.next : shownRows[0]?.id);
    let section = null;
    $(kind + '-list').innerHTML = shownRows.length ? shownRows.map((r) => {
      const sectionRows = !snapshot && (!readOnly || requests) && kind === 'spec' && r.section !== section ? rows.filter((entry) => entry.section === r.section && undecided(entry)) : [];
      const sectionCount = shownRows.filter((entry) => entry.section === r.section).length;
      const head = r.section !== section ? '<div class="spec-section-head"><h4>' + esc(r.section) + ' <span class="section-count">' + sectionCount + '</span></h4>' + (sectionRows.length ? '<button class="spec-section-approve" data-section-approve="' + esc(r.section) + '" type="button">Approve all ' + sectionRows.length + ' in this section</button>' : '') + '</div>' : '';
      section = r.section;
      const declined = kind === 'doctrine' && r.status === 'wont';
      const text = declined ? '<s>' + linked(r.standardText || r.text, titles) + '</s>' : linked(r.text, titles);
      const source = kind === 'doctrine' ? ruleSource(r) : 'this repo';
      const reason = (declined || kind === 'spec' && r.status === 'wont') && r.reason ? '<span class="rule-reason" title="' + esc(r.reason) + '">Reason: ' + linked(r.reason, titles) + '</span>' : '';
      const secondary = '<span class="rule-source" title="' + esc(source) + '">' + esc(source) + '</span>' + reason + (r.gate ? '<span class="gate" title="' + esc(r.gate) + '">' + esc(r.gate) + '</span>' : '');
      const statusShown = filter === 'all' || !!r.staleDecision || (filter === 'decide' && r.status !== 'draft');
      const badge = statusShown ? '<span class="chip ' + tone(r.status) + '">' + esc(r.stage || r.status) + '</span>' : r.tier ? '<span class="chip">' + esc(r.tier) + '</span>' : '';
      const citations = p.items.filter((item) => item.specs.includes(r.id)).length;
      return head + (feedback && feedbackId === r.id ? specFeedback(feedback) : '') + recordRow({ tag: 'div', classes: view.row[kind] === r.id ? 'on' : '', attributes: 'data-row="' + kind + ':' + esc(r.id) + '"', title: r.text,
        state: r.status === 'approved' ? 'verified' : r.status === 'wont' ? 'back' : 'open', primary: '<span class="row-id">' + esc(r.id) + '</span>' + text,
        secondary, rightTop: citations ? count(citations, 'item', 'items') : '', rightBottom: badge });
    }).join('') : '<div class="empty">' + (rows.length ? 'No rows match.' : kind === 'spec' ? 'No spec rows yet. Each requirement is one row in SPEC.md, such as G1 [draft, must] and a line; write them, or ask an agent to, and they show up here.' : 'No doctrine rows yet: they live in DOCTRINE.md.') + '</div>';
    if (feedback && !shownRows.length) $(kind + '-list').innerHTML += specFeedback(feedback);
    const row = rows.find((r) => r.id === view.row[kind]);
    const citing = row ? p.items.filter((i) => i.specs.includes(row.id)) : [];
    const declined = kind === 'doctrine' && row && row.status === 'wont';
    const text = row ? declined ? '<s>' + linked(row.standardText || row.text, titles) + '</s>' : linked(row.text, titles) : '';
    const source = kind === 'doctrine' && row ? '<span class="chip" title="' + esc(ruleSourceTitle(row)) + '">' + esc(ruleSource(row)) + '</span>' : '';
    const reason = (declined || kind === 'spec' && row?.status === 'wont') && row?.reason ? '<dt>reason</dt><dd>' + linked(row.reason, titles) + '</dd>' : '';
    // Only a standard rule gets a note; who approves rows is said once elsewhere, not in every detail (#822).
    const home = kind === 'doctrine' && row && row.origin === 'standard' ? 'Standard rules come with Pullboard as defaults to review; override or decline one in DOCTRINE.md.' : '';
    const rowStatus = row?.stage || row?.status;
    const rowDecisionActions = !snapshot && (!readOnly || requests) && row && undecided(row) && (kind === 'spec' || row.origin !== 'standard')
      ? '<div class="spec-decision-actions detail-decision-actions"><button class="approve-row" data-row-decision="approve" data-row-kind="' + kind + '" data-row-id="' + esc(row.id) + '" title="Approve (A, from the list)" type="button">Approve <kbd>A</kbd></button><button class="decline-row" data-row-decision="decline" data-row-kind="' + kind + '" data-row-id="' + esc(row.id) + '" title="Decline (D, from the list)" type="button">Decline <kbd>D</kbd></button></div>'
      : '';
    $(kind + '-detail').innerHTML = row ? '<div class="stack tight"><h2><span>' + esc(row.id) + '</span>' + text + '</h2><div class="meta"><span class="chip ' + tone(row.status) + '">' + esc(rowStatus) + '</span>' + (row.tier ? '<span class="chip">' + esc(row.tier) + '</span>' : '') + source + '</div>' + rowDecisionActions + (kind === 'spec' && view.specFeedback?.kind === kind && view.specFeedback.root === view.root && view.specFeedback.from === 'detail' && view.specFeedback.id === row.id ? specFeedback(view.specFeedback) : '') + '<dl class="kv"><dt>section</dt><dd>' + esc(row.section) + '</dd>' + reason + (row.gate ? '<dt>gate</dt><dd>' + esc(row.gate) + '</dd>' : '') + (row.serves && row.serves.length ? '<dt>serves</dt><dd>' + esc(row.serves.join(', ')) + '</dd>' : '') + '</dl><div><h3>Items that cite it</h3>' + (citing.length ? '<div class="links">' + citing.map((i) => '<div class="links-item" data-item="' + i.id + '"><span>#' + i.id + ' ' + rich(i.title, titles) + '</span></div>').join('') + '</div>' : '<div class="muted">None yet.</div>') + '</div>' + (home ? '<div class="muted">' + home + '</div>' : '') + '</div>' : '<div class="empty">' + (view.tab === kind && view.addressDetail !== null ? 'No ' + (kind === 'spec' ? 'Spec' : 'Doctrine') + ' row ' + esc(view.addressDetail) + ' exists here.' : 'Pick a row to see it, and the items that cite it.') + '</div>';
  }

  if (keep('pb.flow') !== 'hidden') $('flow').innerHTML = flowSvg(p);
  // A shout or an answer says what it said: who to whom, then its first line, from the shouts on hand.
  // One older than those still names who it went to.
  const said = new Map(p.shouts.map((x) => [x.shout_id, x]));
  const spoke = (e) => {
    let detail = {};
    try { detail = JSON.parse(e.event_detail || '{}') || {}; } catch { /* an unreadable detail names the sender alone */ }
    const x = said.get(detail.shout) || { shout_to: detail.to, shout_decision: detail.decision, shout_answers: detail.answers };
    const verb = e.event_kind === 'answer' || x.shout_answers ? 'answered' : x.shout_decision ? 'asked' : 'shouted to';
    const line = firstLine(x.shout_text);
    return '<b>' + esc(agentName(e.event_by)) + '</b> ' + verb + (x.shout_to ? ' <b>' + esc(agentName(x.shout_to)) + '</b>' : '') + (line ? '<span class="said" title="' + esc(line) + '">' + inline(line, titles) + '</span>' : '');
  };
  $('activity').innerHTML = p.events.length ? byDay(p.events, (e) => e.event_at, (e) => '<div><time>' + clock(e.event_at) + '</time><div class="act">' + (e.event_kind === 'shout' || e.event_kind === 'shout_news' || e.event_kind === 'answer' ? spoke(e) : '<b>' + esc(agentName(e.event_by)) + '</b> ' + esc(e.event_kind) + (e.item_id ? ' <a class="ref" href="' + esc(itemAddress(e.item_id)) + '" data-go="item:' + e.item_id + '">#' + e.item_id + '</a>' + (titles.has(String(e.item_id)) ? ' <span class="what">' + rich(titles.get(String(e.item_id)), titles) + '</span>' : '') : '')) + '</div></div>') : '<div class="empty">No activity yet.</div>';
  showTab();
  revealPlace();
  updateRoadmapPanel();
  drawHistoryNotes();
}

/**
 * Show or hide the lifecycle on Activity, and keep the choice: a person who closed it has learned
 * it, so it stays closed across reloads, and across restarts of the view, which serves from the
 * same address again, until they open it. While hidden it is not drawn.
 */
${settingsPageScript()}${agentApprovalScript()}${pageScriptPart4(pageScope)}${historyLoadingScript()}</script>
</body>
</html>`;
}
