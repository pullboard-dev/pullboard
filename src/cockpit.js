import { dashboardModel } from './view/dashboard-model.js';
import { dashboardHtml } from './view/dashboard-render.js';
import { dashboardRuntime } from './view/dashboard-runtime.js';
import { releaseNotice } from './view/release-notice.js';
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
import { pageRenderScript } from './view/page-render.js';
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
  const pageScope = { dashboardModel, dashboardHtml, dashboardRuntime, releaseNotice, STAR_KEY, applyStateDelta, closePageDialog, connection, drawHosted, hostedBrowser, hostedOptions, hostedReleaseDistance, hostedReleaseNote, homeRules, hostedState, lifecycle, moduleOption, openPageDialog, pageStartup, paths, personNeeds, readOnly, releaseHosted, releaseInfo, requestMode, roadmapBlock, roadmapHeaders, roadmapSummary, sharingPresentation, snapshot, staleChip, tabValue, transportModule };
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
    <button class="tab" data-tab="dashboard" type="button">Dashboard</button>
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
  <section data-pane="dashboard" id="dashboard" class="dashboard" aria-label="Dashboard"></section>
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
    if (view.tab === 'dashboard' && data.project) dashboardView.draw(data.project, $('home-needs').innerHTML);
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
let renderIndexes = new WeakMap();
/** Index only the immutable board objects used during this synchronous render. */
function renderIndex(project) {
  if (!project) return { items: new Map(), titles: new Map(), releases: new Map(), citations: new Map() };
  if (!renderIndexes.has(project)) {
    const releases = new Map();
    for (const milestone of project.milestones || []) {
      for (const id of new Set(milestone.items.map(entry => entry.id))) {
        if (!releases.has(id)) releases.set(id, []);
        releases.get(id).push(milestone.name);
      }
    }
    const citations = new Map();
    for (const item of project.items || []) for (const id of new Set(item.specs || [])) {
      if (!citations.has(id)) citations.set(id, []);
      citations.get(id).push(item);
    }
    renderIndexes.set(project, { citations, items: new Map((project.items || []).map(item => [item.id, item])),
      titles: new Map((project.items || []).map(item => [String(item.id), item.title])), releases });
  }
  return renderIndexes.get(project);
}

/** Resolve a milestone item from the current render's exact local or foreign board snapshot. */
function milestoneItem(entry, p) {
  const local = typeof entry.id === 'number';
  const ref = local ? null : /^(.+)#([1-9]\\d*)$/.exec(String(entry.id));
  const named = ref ? data.projects.filter((x) => x.name === ref[1] || String(x.root).split('/').pop() === ref[1]) : [];
  const root = local ? view.root : named.length === 1 && named[0].ok ? named[0].root : null;
  const id = local ? entry.id : ref ? Number(ref[2]) : null;
  const source = root === view.root ? p : root ? named[0] : null;
  const item = renderIndex(source).items.get(id) || null;
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
    titles: renderIndex(source).titles,
    state: read ? stateOf(read) : null,
    stale: item ? staleChip(item) : '', held: item ? heldNote(item, source, entry) : null,
    block: item ? roadmapBlock(detail?.item || item, {
      holds: root === view.root ? source.holds : source.laneHolds, itemHolds: source.itemHolds, items: source.items, agents: source.agents, state: stateOf,
      address: (id) => itemAddress(id, root), board: root === view.root ? null : root,
      releases: renderIndex(p).releases.get(entry.id) || [], summaryOnly: !expanded,
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
  markRoadmapArrival(key, target);
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
  /** Group work in the legend's shipping order; stable sorting preserves milestone order within each group. */
  const rank = (row) => row.stage === 'merged' ? 5 : row.stage === 'accepted' ? 0 : row.stage === 'submitted' ? 1 : row.held ? 4 : row.stage === 'claimed' ? 2 : row.state === 'verified' ? 5 : 3;
  const rows = [...visible].sort((a, b) => rank(a) - rank(b));
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

/** The existing upgrade card is kept outside the cockpit's page-size budget. */
function renderReleaseNotes(project) {
  return (${releaseNotice.toString()})(project, { $, snapshot, releaseNotices, keep, newerRelease, esc });
}

/** Draw the board shown: the sidebar, then every tab's panes from the project's board. */
${pageRenderScript()}
/**
 * Show or hide the lifecycle on Activity, and keep the choice: a person who closed it has learned
 * it, so it stays closed across reloads, and across restarts of the view, which serves from the
 * same address again, until they open it. While hidden it is not drawn.
 */
${settingsPageScript()}${agentApprovalScript()}${pageScriptPart4(pageScope)}${historyLoadingScript()}</script>
</body>
</html>`;
}
