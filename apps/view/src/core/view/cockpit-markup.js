/** Return the original markup section of the self-contained cockpit document. */
export function cockpitMarkup(sections) {
  const { repositoryAttribute, cssAttribute, hostedLocal, snapshot, readOnly, requestMode, privateCost, hostedMarkup, signIn, settingsMarkup, starMarkup } = sections;
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
    <div class="label">Projects</div>
    <nav id="proj-list" aria-label="Projects on this machine"></nav>
    <button class="share-again" id="share-again" type="button" hidden>Link boards to pullboard.dev&hellip;</button>
    <section class="products" id="products" aria-label="Products" hidden><div class="label">Products</div><div id="prod-list"></div></section>
  </div>
  <nav class="side-footer" aria-label="Project tools"><button class="ghost" data-tab="settings" type="button">Settings</button><a class="ghost" href="${repositoryAttribute}" target="_blank" rel="noopener">GitHub <span aria-hidden="true">↗</span></a></nav>
</aside>
<div class="body">
<header class="top">
  <nav class="tabs" id="tabs" aria-label="Board">
    <button class="tab" data-tab="dashboard" type="button">Dashboard</button>
    <button class="tab" data-tab="items" type="button">Items</button>
    <button class="tab" data-tab="shouts" type="button">Shouts</button>
    <button class="tab" data-tab="spec" type="button">Spec</button>
    <button class="tab" data-tab="doctrine" type="button">Doctrine</button>
    <button class="tab" data-tab="activity" type="button">Activity</button>
    <button class="tab" data-tab="roadmap" type="button">Roadmap</button>
    ${privateCost ? '<button class="tab" data-tab="cost" type="button">Cost</button>' : ''}
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
  <section id="group-view" class="group-view" hidden>
    <section class="card-panel group-panel"><h2>Needs you</h2><div id="group-needs"></div></section>
    <section class="card-panel group-panel"><h2>Activity</h2><div class="feed" id="group-activity"></div></section>
  </section>
  <section class="card-panel person-requests" id="person-requests" aria-label="Your requests" aria-live="polite" hidden></section>
  <section data-pane="dashboard" id="dashboard" class="dashboard" aria-label="Dashboard"></section>
  <section data-pane="items" class="two">
    <div class="primary">
      <section class="card-panel proof-stats" id="proof-stats" aria-label="Board proof stats" hidden></section>
      <div class="card-panel toolbar" id="items-toolbar">
        <div class="items-view-switch" id="items-view-switch"></div>
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
    <div class="primary"><div class="card-panel rows-card"><div id="spec-fit" class="fit"></div><div class="rows-filter rule-description-wrap"><div id="spec-chips"></div><p class="rule-tab-description" id="spec-description">What to build: the requirements you approve.</p></div><div class="rows" id="spec-list" tabindex="0" aria-label="Spec rows"></div></div></div>
    <aside class="card-panel detail" aria-label="Spec row"><div id="spec-detail"></div></aside>
  </section>
  <section data-pane="doctrine" class="two">
    <div class="primary"><div class="card-panel rows-card"><div class="rows-filter rule-description-wrap"><div id="doctrine-chips"></div><p class="rule-tab-description" id="doctrine-description">How it's built: the rules every agent follows.</p></div><div class="rows" id="doctrine-list" tabindex="0" aria-label="Doctrine rows"></div></div></div>
    <aside class="card-panel detail" aria-label="Practice row"><div id="doctrine-detail"></div></aside>
  </section>
  <section data-pane="activity">
    <div class="activity-toolbar"><div id="activity-filters"></div><button class="ghost flow-show" id="flow-show" type="button" aria-controls="flow-panel" aria-expanded="false"><svg viewBox="0 0 16 16" aria-hidden="true"><path d="M2 13V8h3v5m2 0V3h3v10m2 0V6h2v7"/></svg>How work moves</button></div>
    <figure class="card-panel flow" id="flow-panel" hidden><div id="flow"></div><figcaption>Every item on the board, since the start. Hover a number for what it means.</figcaption></figure>
    <div class="card-panel feed" id="activity"></div>
  </section>
  ${settingsMarkup()}
  <section data-pane="roadmap" class="roadmap-layout" id="roadmap" aria-label="Roadmap"></section>
  ${privateCost ? '<section data-pane="cost" id="cost" aria-label="Cost"></section>' : ''}
  ${hostedLocal && !snapshot ? starMarkup() : ''}
</main>
</div>
</div>
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
