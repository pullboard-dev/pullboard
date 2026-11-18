import { navStripHtml } from "../nav.js";
import { accountHtml } from "../nav.js";
import { notchHtml } from "../nav.js";
import { navSideHtml } from "../nav.js";

/** Return the original markup section of the self-contained cockpit document, its shell the top layout of the approved navigation [N26]. */
export function cockpitMarkup(sections) {
  const { repositoryAttribute, cssAttribute, hostedLocal, snapshot, readOnly, requestMode, privateCost, hostedMarkup, signIn, settingsMarkup, starMarkup } = sections;
  return `<!doctype html>
<html lang="en" data-nav="top" data-side="collapsed">
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
  <div class="side-body" id="side-body">
    <div class="label">Projects</div>
    <nav id="proj-list" aria-label="Projects on this machine"></nav>
    <section class="products" id="products" aria-label="Products" hidden><div class="label">Products</div><div id="prod-list"></div></section>
  </div>
  <nav class="side-footer" aria-label="Project tools"><a class="ghost" href="${repositoryAttribute}" target="_blank" rel="noopener">GitHub <span aria-hidden="true">↗</span></a></nav>
</aside>
<div class="body">
<header class="top">
  <div class="top-tier">
    <button class="menubtn" id="menu-btn" type="button" aria-expanded="false" aria-controls="mdrawer"><span class="bars" aria-hidden="true"><i></i><i></i><i></i></span>Menu<span class="badge" id="menu-rulings" title="Rulings on this board"></span></button>
    <div class="side-top">
    <span class="brand" id="side-toggle" title="Pullboard"><svg viewBox="0 0 64 64" aria-hidden="true"><path fill="currentColor" d="M8 7h35a6 6 0 0 1 6 6v7H8a5 5 0 0 1-5-5v-3a5 5 0 0 1 5-5Z"/><rect width="56" height="14" x="3" y="25" fill="var(--accent)" rx="5"/><path fill="currentColor" d="M8 43h35a6 6 0 0 1 6 6v8H8a5 5 0 0 1-5-5v-4a5 5 0 0 1 5-5Z"/></svg><span>Pullboard</span></span>
    <button class="switch-btn" id="proj-switch" type="button" aria-expanded="false" aria-controls="side-body" title="Switch project"><span id="proj-name">Projects</span><span class="badge" id="proj-rulings" title="Rulings on this board"></span><small aria-hidden="true"><svg viewBox="0 0 16 16"><path d="M4 6l4 4 4-4" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"/></svg></small></button>
    </div>
    <span class="ptitle" id="proj-title"></span>
    <button class="pin" id="nav-pin" type="button" aria-pressed="false" aria-label="Move the navigation to the sidebar" title="Move the navigation to the sidebar (\\)"><span class="pg">⇤</span></button>
    <span class="crumb">/ <b id="crumb-page"></b></span>
    <span class="notch" id="notch" aria-label="The board now">${notchHtml()}</span>
    <div class="top-right">
      <div class="top-find"><input id="q" type="search" placeholder="Search" aria-label="Search items, Spec, Doctrine and shouts" aria-keyshortcuts="Meta+K Control+K" autocomplete="off"><kbd aria-hidden="true">⌘K</kbd><div class="find-results" id="find-results" role="listbox" aria-label="Search results" hidden></div></div>
      <span class="account-slot" id="account-slot">${accountHtml()}<div class="acct-menu" id="account-menu" role="menu" aria-label="Account" hidden></div></span>
    </div>
  </div>
  <div class="strip" id="nav-strip">
    <nav class="tabs" id="tabs" aria-label="Board">${navStripHtml({ cost: privateCost })}</nav>
    <span class="pagectl" id="page-controls"></span>
  </div>
</header>
<main>
  <div class="page-title" id="page-title"><h2 id="page-title-text"></h2></div>
  <section class="card-panel first">
    <h2>No boards yet</h2>
    <p>Run <code>pullboard init</code> in a git repo, or ask an agent to. Its board shows up here by itself.</p>
  </section>
  <p class="empty" id="project-loading" role="status" hidden>Loading project…</p>
  <section class="board-frame" id="board-frame" aria-hidden="true" hidden><div class="frame-primary"><div class="card-panel frame-card"></div><div class="card-panel frame-card frame-list"></div></div><div class="card-panel frame-card frame-detail"></div></section>
  ${hostedMarkup('http://127.0.0.1:4890', { looking: Boolean(hostedLocal) && !snapshot, signIn })}
  <button class="ob-gh share-gh" id="share-start" type="button" hidden>Sign in with GitHub</button>
  <section class="card-panel" id="share-panel" aria-label="Link these boards" hidden>
    <p id="share-status" role="status" aria-live="polite"></p>
    <button class="ghost" id="share-pair" type="button" hidden>Pair a device</button>
    <button class="ghost" id="share-close" type="button">Cancel sign-in</button>
  </section>
  <section id="group-view" class="group-view" hidden>
    <section class="card-panel group-panel"><h2>Rulings</h2><div id="group-needs"></div></section>
    <section class="card-panel group-panel"><h2>Activity</h2><div class="feed" id="group-activity"></div></section>
  </section>
  <section class="card-panel person-requests" id="person-requests" aria-label="Your requests" aria-live="polite" hidden></section>
  <section data-pane="dashboard" id="dashboard" class="dashboard" aria-label="Dashboard"></section>
  <section data-pane="items" class="two">
    <div class="primary">
      <section class="card-panel upgrade-note" id="upgrade-note" aria-label="What is new" hidden></section>
      <div class="card-panel list-card" id="item-list"><ol class="chain" id="chain" aria-label="Items"></ol><ol class="needs" id="needs" aria-label="Rulings" hidden></ol></div>
      <ol class="pipeline" id="pipeline" aria-label="Item pipeline" hidden></ol>
    </div>
    <aside class="card-panel detail" aria-label="Item detail">
      <div id="detail"></div>
      <form id="add-form" class="panel-form" hidden>
        <h3 class="hd2">New item</h3>
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
      <div class="card-panel shouts-card sx-compose"><form id="shout-form" class="shout-form"><p class="answering" id="answering" hidden><span>Answering <b id="answering-who"></b>: <span id="answering-q"></span></span><button class="ghost" id="answer-cancel" type="button">Cancel</button></p><div class="composer"><input id="shout-to" type="hidden" value="coordinator"><span class="to-chip" id="shout-to-chip" hidden></span><textarea id="shout-text" required rows="1" placeholder="Shout to the coordinator" aria-label="Message"></textarea><button class="send" id="shout-send" type="submit" aria-label="Shout" title="Shout (Enter; Shift+Enter for a new line)"><svg viewBox="0 0 16 16" aria-hidden="true"><path fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" d="M8 13V3M3.5 7.5 8 3l4.5 4.5"/></svg></button></div></form></div><section class="rulings-box" id="coordinator-decisions" aria-label="Coordinator decision queue" hidden></section><section class="rulings-box" id="decisions" aria-label="Decisions needed" hidden></section><div class="feed" id="feed"></div>
    </div>
    <aside class="detail sx-rail" aria-label="Agents and credentials">
      <div id="agents"></div>
      <section id="credentials" aria-label="Agent credentials"></section>
    </aside>
  </section>
  <section data-pane="spec" class="two">
    <div class="primary"><div class="card-panel rows-card"><div id="spec-fit" class="fit"></div><div class="rows-filter rule-description-wrap"><div id="spec-chips"></div><p class="rule-tab-description" id="spec-description">What to build: the requirements you approve.</p></div><div class="rows" id="spec-list" tabindex="0" aria-label="Spec rows"></div></div></div>
    <aside class="card-panel detail" aria-label="Spec row"><div id="spec-detail"></div></aside>
  </section>
  <section data-pane="doctrine" class="two">
    <div class="primary"><div class="card-panel rows-card"><div class="rows-filter rule-description-wrap"><div id="doctrine-chips"></div><p class="rule-tab-description" id="doctrine-description">How it's built: the rules every agent follows.</p></div><div class="rows" id="doctrine-list" tabindex="0" aria-label="Doctrine rows"></div></div></div>
    <aside class="card-panel detail" aria-label="Practice row"><div id="doctrine-detail"></div></aside>
  </section>
  <section data-pane="activity">
    <div class="act-live"><div id="activity" aria-label="Activity"></div><div class="act-tip" id="act-tip" hidden></div></div>
    <details class="sx-lanes" id="lanes-fold"><summary>Lanes</summary>
      <div id="lanes"></div>
      <form id="hold-form" class="panel-form"><label>Hold a lane<select id="hold-lane"></select></label><label>Why<input id="hold-reason" required placeholder="What its agents should wait for"></label><button class="go" type="submit">Hold lane</button></form>
    </details>
  </section>
  <section data-pane="pipeline" id="insights-pipeline" class="pipeline-page" aria-label="Pipeline"></section>
  ${settingsMarkup()}
  <section data-pane="roadmap" class="roadmap-layout" id="roadmap" aria-label="Roadmap"></section>
  ${privateCost ? '<section data-pane="cost" id="cost" aria-label="Cost"></section>' : ''}
  ${hostedLocal && !snapshot ? starMarkup() : ''}
</main>
</div>
<nav class="sidenav" id="sidenav" aria-label="Pages">${navSideHtml({ cost: privateCost, amber: ['shouts'] })}</nav>
</div>
<div class="mveil" id="mveil" hidden></div>
<aside class="mdrawer" id="mdrawer" aria-label="Menu" hidden>
  <div class="mh"><button class="switch-btn" id="mdrawer-proj" type="button" title="Switch project"><span id="mdrawer-proj-name">Projects</span><span class="badge" id="mdrawer-rulings"></span><small aria-hidden="true"><svg viewBox="0 0 16 16"><path d="M4 6l4 4 4-4" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"/></svg></small></button>
  <div class="stats"><span><b data-notch="agents">—</b> agents</span><span><b class="g" data-notch="perHour">—/h</b></span></div></div>
  <button class="rul" type="button" data-needs-list><i aria-hidden="true"></i>Rulings<em data-notch="rulings">0</em></button>
  <nav class="mnav" aria-label="Pages">${navSideHtml({ cost: privateCost, amber: ['shouts'] })}</nav>
</aside>
<footer class="status${snapshot ? ' snap' : ''}" aria-label="Board status"><span class="live" id="live"></span><span class="status-board" id="status-board"></span>${snapshot ? `<div class="snapshot-controls" id="snapshot-controls" aria-label="Snapshot replay">
  <button class="snapshot-play" id="replay-play" type="button" aria-label="Play from first event" title="Play from first event"><svg viewBox="0 0 16 16" aria-hidden="true"><path d="M4 2.5 13 8l-9 5.5z" fill="currentColor"/></svg></button>
  <button class="snapshot-pause" id="replay-pause" type="button" aria-label="Pause replay" title="Pause replay" disabled><svg viewBox="0 0 16 16" aria-hidden="true"><path d="M4 3h3v10H4zm5 0h3v10H9z" fill="currentColor"/></svg></button>
  <label class="snapshot-speed">Speed <select id="replay-speed" aria-label="Replay speed"><option value="1">1×</option><option value="4">4×</option><option value="16">16×</option></select></label>
  <output id="replay-progress" aria-live="polite">event 0 of 0</output>
</div>` : ''}</footer>
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
`;
}
