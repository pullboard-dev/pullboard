import { modelLabelRules } from "../cost/tab.js";
import { projectSummary } from "../../logic/summary/project.js";
import { readyAndBlocked } from "../../logic/counts.js";
import { splitReady } from "../../logic/counts.js";
import { withReadySplit } from "../../logic/counts.js";
/**
 * Read the private board's cost event history once per board and window, and again only after a usage, shared-usage
 * or merged event has arrived since the last read; a gap in the visible ids reads the event log for the missing ones. The drawn numbers stay on screen while a new read is on its way.
 * This function is serialized into the private page script and uses its page-local state.
 * @param {Record<string, any>} project - The current board state.
 * @param {boolean} [switching] - Whether a tab switch asks, which keeps analytics already read.
 * @returns {{loading: false, error: string}|{sequence: number, loading: boolean, error: string|null, model: any}} The private-history status or cached entry.
 */
function readCostHistory(project, switching = false) {
  if (!privateCost || snapshot || hosted.local || readOnly || data.group) return { loading: false, error: 'Cost is available in the private local view only.' };
  project.costPrices = localCostPrices;
  const root = view.root;
  const sequence = Number(project.sequence ?? project.events?.[0]?.event_id ?? 0);
  const window = view.costWindow ?? '7d';
  const key = root + '\n' + window;
  const kept = costHistory.get(key);
  const events = project.events || [];
  const seen = Math.max(0, ...events.map(event => Number(event.event_id) || 0));
  if (kept) {
    if (kept.loading && !kept.model) return kept;
    const oldest = events.length ? Math.min(...events.map(event => Number(event.event_id) || 0)) : seen;
    const costEvent = events.some(event => event.event_id > kept.seen && ['usage', 'shared-usage', 'merged'].includes(event.event_kind));
    if (!costEvent && oldest <= kept.seen + 1) return kept;
    if (!costEvent && !kept.stale) {
      // A gap of ids may hide a cost event, but a gap alone is not a reason to read cost-analytics: the missing
      // events are read from the event log (cheap) once per gap, and only a cost-bearing one among them reads again.
      if (kept.gapUpTo !== oldest) {
        kept.gapUpTo = oldest;
        const gapKey = key;
        const scan = after => api(boardPath(root) + '/events?after=' + after).then(reply => {
          const batch = Array.isArray(reply.events) ? reply.events : [];
          const missing = batch.filter(event => event.event_id < oldest);
          if (missing.some(event => ['usage', 'shared-usage', 'merged'].includes(event.event_kind))) throw { found: true };
          const last = batch.length ? Number(batch[batch.length - 1].event_id) : oldest;
          if (batch.length && last < oldest - 1) return scan(last);
        });
        scan(kept.seen).then(() => {
          if (costHistory.get(gapKey) === kept) kept.seen = Math.max(kept.seen, oldest - 1);
        }).catch(found => {
          if (costHistory.get(gapKey) !== kept) return;
          if (found && found.found) kept.stale = true;
          else kept.gapUpTo = null;
          if (kept.stale && view.tab === 'cost' && root === view.root) render();
        });
      }
      return kept;
    }
  }
  // The last numbers this browser read draw at once while the fresh read is on its way.
  let remembered = null;
  if (!kept?.model) { try { remembered = JSON.parse(keep('pb.cost.' + key) || 'null'); } catch { remembered = null; } }
  const entry = { sequence, window, seen, loading: true, refreshing: Boolean(kept?.model || remembered), error: null, model: kept?.model ?? remembered };
  costHistory.set(key, entry);
  api(boardPath(root) + '/cost-analytics?window=' + encodeURIComponent(window)).then(reply => {
    if (costHistory.get(key) !== entry || !reply.costAnalytics) return;
    entry.model = reply.costAnalytics;
    try { keep('pb.cost.' + key, JSON.stringify(reply.costAnalytics)); } catch { /* storage full or unavailable: the numbers are simply not kept for next time */ }
    entry.loading = false;
    entry.refreshing = false;
    if (view.tab === 'cost' && root === view.root && window === (view.costWindow ?? '7d')) render();
  }).catch(error => {
    if (costHistory.get(key) !== entry) return;
    entry.loading = false;
    entry.refreshing = false;
    if (!entry.model) entry.error = String(error.message || error);
    if (view.tab === 'cost' && root === view.root && window === (view.costWindow ?? '7d') && !entry.model) render();
  });
  return entry;
}

/**
 * Part 3 of the hosted page's script, verbatim from apps/cli/src/io/cockpit.js lines 1310-1690 (#745): its
 * text is what the page served before the split, with the values its ${} expressions read passed in as scope.
 *
 * @param {Record<string, any>} scope - The values cockpitPage passes for the names this part interpolates.
 * @returns {string} The script text of this part.
 */
export function pageScriptPart3(scope) {
  const { applyStateDelta, costPrices, costTabScript, deriveMilestoneForecasts, expandItemSummaries, milestoneForecast, privateCost } = scope;
const privateCostSource = privateCost ? `${costTabScript()}
const costHistory = new Map();
const localCostPrices = ${JSON.stringify(costPrices ?? null).replace(/</g, '\\u003c')};
${readCostHistory.toString()}
function costPaneHtml(history, project) {
  const shown = { vendorClasses: modelTables.vendorClasses };
  // The frame (heading and period buttons) draws at once; the numbers fill in place, or the last read ones stay up.
  if (history.loading && !history.model) return costOverviewHtml({ window: view.costWindow ?? '7d' }, null, { ...shown, waiting: 'Reading cost history…' });
  if (history.error && !history.model) return costOverviewHtml({ window: view.costWindow ?? '7d' }, null, { ...shown, waiting: 'Cost history is unavailable.' });
  return costOverviewHtml(history.model, view.costOpen, { ...shown, updating: Boolean(history.loading) });
}` : '';
return `${privateCostSource}
const modelLabelRules = ${JSON.stringify(modelLabelRules())};

/** Whether a selected project is backed by the read-only relay transport. */
function relayProject(root = view.root) {
  const board = data?.projects.find((entry) => entry.root === root && entry.ok);
  return boardSources.get(board?.id)?.kind === 'relay';
}

/** Send only literal person intent; the transport seals it and generic API writes stay refused. */
async function sendPersonRequest(root, move) {
  if (!requests || snapshot || !readOnly) throw new Error('This view cannot send person requests.');
  if (!relayProject(root)) throw new Error('Person requests through the relay require a linked relay board.');
  if (!['add', 'shout', 'answer', 'hold', 'spec-approve', 'spec-decline', 'spec-answer', 'sentinel-approve', 'sentinel-decline'].includes(move.verb)) throw new Error('Choose a person action from the view controls.');
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
  if (move?.verb === 'spec-answer') return 'Answer row ' + (args.row || '') + ': ' + (args.answer || '');
  if (move?.verb === 'sentinel-approve') return 'Approve sentinel ' + (args.name || '');
  if (move?.verb === 'sentinel-decline') return 'Decline sentinel ' + (args.name || '') + (args.reason ? ': ' + args.reason : '');
  return 'Person request';
}

/** Retain the native request status and the CLI's complete refusal guidance beside an action. */
function requestNotice(request) {
  const label = { waiting: 'Waiting', done: 'Done', refused: 'Refused' }[request.status] || 'Unknown status';
  const error = request.status === 'refused' && request.error;
  return label + ' · ' + requestLabel(request) + (error ? '\\n' + (error.code ? '[' + error.code + '] ' : '') + (error.message || '') + (error.next ? '\\n' + error.next : '') : '');
}

/** Show the public request receipts on every board tab and update the latest action's status; returns how far the panel grew above the viewport. */
function renderPersonRequests(project) {
  const entries = project?.personRequests || [];
  const panel = $('person-requests');
  // A panel above the viewport (hidden counts: it opens at the page top) is measured before and after, so render can
  // move its page-scroll mark by the growth and a new receipt never shoves what the person reads [H12,H5].
  const above = typeof window !== 'undefined' && window.scrollY > 0 && (panel.hidden || panel.getBoundingClientRect().bottom <= 0);
  const heightBefore = above && !panel.hidden ? panel.getBoundingClientRect().height : 0;
  panel.hidden = !entries.length;
  panel.innerHTML = entries.length ? '<h2>Your requests</h2><ul class="request-list">' + [...entries].sort((a, b) => b.sequence - a.sequence).map((request) => {
    const status = { waiting: 'Waiting', done: 'Done', refused: 'Refused' }[request.status] || 'Unknown status';
    const error = request.status === 'refused' && request.error;
    const reason = error ? '<p class="request-error">' + (error.code ? '<b>' + esc(error.code) + '</b> ' : '') + esc(error.message || '') + '</p>' + (error.next ? '<p class="request-next">' + esc(error.next) + '</p>' : '') : '';
    return '<li data-person-request="' + esc(request.id) + '"><span class="request-label">' + esc(requestLabel(request)) + '</span><span class="chip request-status ' + (request.status === 'done' ? 'ok' : request.status === 'refused' ? 'no' : 'warn') + '">' + status + '</span>' + reason + '</li>';
  }).join('') + '</ul>' : '';
  const grew = above ? (entries.length ? panel.getBoundingClientRect().height : 0) - heightBefore : 0;
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
  return grew;
}

/**
 * An opened board's sidebar row: the same counts a listed board's summary carries (U94), from the full state the
 * page displays, plus what that state lets the opened project's pages read.
 */
function boardSummary(board, state) {
  return {
    ...board, ok: true, ...projectSummary(state, personNeeds(state)),
    // An open-first state counts the finished items it left out in state.finished (#6697).
    ...(state.itemsOmitted === 'finished' ? { verified: state.items.filter((item) => item.status === 'verified').length + (state.finished?.verified ?? 0) } : {}),
    releaseNotes: state.releaseNotes,
    laneHolds: state.holds,
    // What each item's state reads from, so another repo's roadmap can show it as this board's
    // Items tab does, sent back included, and open it here.
    items: state.items.map((item) => listFields(item)),
    agents: state.agents, events: state.events, milestones: state.milestones,
  };
}

/** Format an API-measured duration in readable units without deriving times from events [N26]. */
function flowMinutes(value) {
  if (value === null || value === undefined) return 'unmeasured';
  const minutes = Math.round(value);
  if (minutes < 60) return minutes + ' min';
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return hours + ' h ' + minutes % 60 + ' min';
  return Math.floor(hours / 24) + ' d ' + hours % 24 + ' h';
}

/** A queue's oldest item and how long it has waited, as the flow card reads it. */
function oldestLine(oldest) {
  return 'Oldest: ' + (oldest ? '#' + oldest.id + ' · ' + flowMinutes(oldest.ageMinutes) : 'none');
}

/** Render the four stages, live queues and single recommendation supplied by stats [N26]. */
function proofFlowCard(flow) {
  if (!flow) return '';
  const stages = [['build', 'Build'], ['reviewWait', 'Review wait'], ['review', 'Review'], ['mergeWait', 'Merge wait']];
  const queues = [['open', 'Open'], ['claimed', 'Building'], ['submitted', 'In review'], ['accepted', 'Awaiting merge']];
  const averages = stages.map(([key, label]) => {
    const average = flow.stages[key].averageMinutes;
    return '<div><span>' + label + ' average</span><b data-stage="' + key + '" data-value="' + esc(average ?? '') + '">' + esc(flowMinutes(average)) + '</b></div>';
  }).join('');
  const waiting = queues.map(([key, label]) => {
    const queue = flow.queues[key];
    const oldest = queue.oldest;
    return '<div><span>' + label + ' queue</span><b data-queue="' + key + '" data-value="' + esc(queue.size) + '">' + esc(queue.size) + '</b>'
      + '<small data-oldest="' + key + '" data-value="' + esc(oldest?.ageMinutes ?? '') + '">' + esc(oldestLine(oldest)) + '</small></div>';
  }).join('');
  const bottleneck = flow.bottleneck;
  return '<div class="proof-stats-flow"><div class="proof-stats-grid">' + averages + waiting + '</div>'
    + '<p class="proof-stats-bottleneck"><b>Bottleneck: </b><span data-flow="bottleneck">' + esc(bottleneck.message) + '</span>'
    + (bottleneck.recommendation ? ' · <span data-flow="recommendation">' + esc(bottleneck.recommendation) + '</span>' : '') + '</p></div>';
}

/** Render the event-log totals already supplied by the shared stats API [V2,N26]. */
function proofStatsCard(stats, expanded = false) {
  if (!stats) return '<span class="muted">Stats unavailable</span>';
  const percentage = (Number(stats.rejectionShare) * 100).toFixed(1) + '%';
  const bottleneck = stats.flow?.bottleneck;
  const stage = { build: 'Build', reviewWait: 'Review wait', review: 'Review', mergeWait: 'Merge wait' }[bottleneck?.stage];
  const summary = stats.merged + ' merged · ' + percentage + ' sent back'
    + (bottleneck ? ' · Bottleneck: ' + (stage || bottleneck.message) + (bottleneck.recommendation ? ', ' + bottleneck.recommendation : '') : '');
  /** Format an API timestamp for the card without recalculating event statistics.
   * @param {string|number|null} value
   * @returns {string}
   */
  const dateText = (value) => value ? new Date(value).toLocaleDateString([], { year: 'numeric', month: 'short', day: 'numeric' }) : 'none';
  const firstAt = stats.firstEventAt ?? '';
  const lastAt = stats.lastEventAt ?? '';
  return '<button class="proof-stats-summary" id="proof-stats-summary" data-stats-toggle type="button" aria-expanded="' + expanded + '" aria-controls="proof-stats-full">'
    + '<span class="proof-stats-summary-text">' + esc(summary) + '</span><span class="proof-stats-caret" aria-hidden="true">' + (expanded ? '−' : '+') + '</span></button>'
    + '<div class="proof-stats-full" id="proof-stats-full"' + (expanded ? '' : ' hidden') + '>'
    + '<div class="proof-stats-head"><b>Proof stats</b><span>from recorded moves</span></div>'
    + '<div class="proof-stats-grid">'
    + '<div><span>Submissions</span><b data-stat="submissions" data-value="' + esc(stats.submissions) + '">' + esc(stats.submissions) + '</b></div>'
    + '<div><span>Sent back items</span><b data-stat="rejections" data-value="' + esc(stats.rejections) + '">' + esc(stats.rejections) + '</b></div>'
    + '<div><span>Sent back share</span><b data-stat="rejectionShare" data-value="' + esc(percentage) + '">' + esc(percentage) + '</b></div>'
    + '<div><span>Merged</span><b data-stat="merged" data-value="' + esc(stats.merged) + '">' + esc(stats.merged) + '</b></div>'
    + '<div><span>Without accept</span><b data-stat="mergedWithoutAccept" data-value="' + esc(stats.mergedWithoutAccept) + '">' + esc(stats.mergedWithoutAccept) + '</b></div>'
    + '<div><span>Agents</span><b data-stat="agentCount" data-value="' + esc(stats.agentCount) + '">' + esc(stats.agentCount) + '</b></div>'
    + '<div><span>First · latest</span><small><time data-stat="firstEventAt" data-value="' + esc(firstAt) + '" datetime="' + esc(firstAt) + '">' + esc(dateText(firstAt)) + '</time> · <time data-stat="lastEventAt" data-value="' + esc(lastAt) + '" datetime="' + esc(lastAt) + '">' + esc(dateText(lastAt)) + '</time></small></div>'
    + '</div>' + proofFlowCard(stats.flow) + '</div>';
}

/** Resolve a displayed repo to the persistent board identity supplied by API v1. */
function boardPath(root) {
  const board = data && data.projects.find((entry) => entry.root === root && entry.ok);
  if (!board) throw new Error('This board is unavailable; choose a readable project and retry.');
  return '/api/v1/boards/' + encodeURIComponent(board.id);
}

/**
 * What the page last drew for a listed board, to stand in for it in a catch-up that does not read it: its sidebar
 * row, and its state when the page shows it. Nothing when the page has no such row, or shows the board without one.
 */
function lastRead(board, root) {
  const row = data?.projects.find((entry) => entry.root === board.root && entry.id === board.id && entry.ok);
  if (!row || row.loading) return null;
  const state = data.root === board.root ? data.project : data.group?.repos.find((repo) => repo.root === board.root)?.board ?? null;
  if (!state && (board.root === root || root === 'group:' + board.project)) return null;
  return { row: { ...row, ...board, ok: true }, state };
}

/** Group the listed repositories without waiting for their individual board states. */
function projectGroups(projects) {
  const grouped = new Map();
  for (const project of projects) {
    if (!project.project) continue;
    if (!grouped.has(project.project)) grouped.set(project.project, []);
    grouped.get(project.project).push(project);
  }
  // One repository shows once, without a heading that repeats its name.
  return [...grouped].filter(([, repos]) => repos.length > 1).map(([name, repos]) => ({ name, key: 'group:' + name, repos }));
}

/**
 * Put one board's read on the page the moment it lands, not when the slowest board answers (#6589): a sidebar row
 * still loading takes its counts, and the shown board's read goes to shown, which draws it. The full answer of the
 * same read still draws after, so this only moves each part earlier.
 */
function arrived(board, summary, shown, state) {
  if (!data) return;
  const same = (entry) => entry.root === board.root && entry.id === board.id;
  const at = data.projects.findIndex((entry) => same(entry) && entry.loading);
  if (at >= 0) {
    data.projects[at] = summary;
    data.groups = projectGroups(data.projects);
    renderSide();
  }
  if (!shown) return;
  const projects = data.projects.map((entry) => same(entry) ? summary : entry);
  // An early draw that fails never fails the board's read: the full answer draws it again and reports its own error.
  try { shown({ projects, groups: projectGroups(projects), project: state, group: null }); }
  catch { /* the full answer redraws */ }
}

/**
 * Compose the multi-repo page from the public board list and each board's public state. A catch-up names the boards
 * whose events arrived in fresh and reads only those; every other board keeps what the page last drew (#545). shown,
 * when given, takes the shown board's state as soon as it arrives (#6589).
 */
async function boardState(root, mark, fresh = null, shown = null) {
  const listed = await api('/api/v1/boards');
  stateWorkerStopped = listed.stateWorker === 'stopped';
  if (!data) {
    // Names are already known: a slow board must not leave the project picker blank.
    const projects = listed.boards.map((board) => ({ ...board, ok: true, loading: true }));
    projects.push(...(listed.warnings || []).map((warning) => ({ ...warning, ok: false,
      warningCode: warning.error?.error?.code, error: warning.error?.error?.message || 'This board could not be read.' })));
    data = store.set({ root: null, project: null, group: null, projects, groups: projectGroups(projects) });
    renderSide();
    $('project-loading').hidden = projects.length === 0;
    // A listed board draws the frame now; its state fills the frame in as it arrives (#6589).
    if (projects.some((entry) => entry.ok)) drawFrame();
  }
  // A page whose remembered board is not listed has no board to read yet: hand the listed boards back at once, and the
  // refresh picks the first of them, instead of reading every board's state before choosing one (#6715).
  if (!fresh && listed.boards.length && !listed.boards.some((board) => board.root === root) && !projectGroups(listed.boards).some((entry) => entry.key === root)) {
    const projects = listed.boards.map((board) => ({ ...board, ok: true, loading: true }));
    return { projects, groups: projectGroups(projects), project: null, group: null };
  }
  const states = new Map();
  const cursor = mark !== null && mark !== undefined && /^\\d+$/.test(String(mark)) && Number.isSafeInteger(Number(mark)) ? Number(mark) : null;
  /** Read one listed board: its state when the page shows its items, else only its summary (U94). */
  const read = async (board, full) => {
    const kept = fresh && !fresh.has(board.root) ? lastRead(board, root) : null;
    if (kept) {
      if (kept.state) states.set(board.root, kept.state);
      return kept.row;
    }
    let summary;
    try {
      if (!full) summary = { ...board, ok: true, ...await summaryRead(board) };
      else {
      const state = await boardRead(board, board.root === root ? cursor : null);
      states.set(board.root, state);
      summary = boardSummary(board, state);
      }
    } catch (error) {
      return { ...board, ok: false, error: String(error.message || error) };
    }
    if (!fresh) arrived(board, summary, full && board.root === root ? shown : null, states.get(board.root));
    return summary;
  };
  // The opened project, a board or each repo of a group, reads its state. Every other listed board reads its summary at
  // the same time, so the sidebar fills in without waiting for the opened board. A board the opened project's
  // milestones name then reads its state too, since its Roadmap shows that board's items.
  const opened = (board) => board.root === root || Boolean(board.project && root === 'group:' + board.project);
  const first = listed.boards.map((board) => opened(board) ? read(board, true) : null);
  const rest = listed.boards.map((board, n) => first[n] ?? read(board, false));
  await Promise.all(first);
  const names = new Set([...states.values()].flatMap((state) => (state.milestones || []).flatMap((milestone) => milestone.items || []))
    .map((entry) => /^(.+)#[1-9]\\d*$/.exec(String(entry.id))?.[1]).filter(Boolean));
  const named = (board) => names.has(board.name) || names.has(String(board.root).split('/').pop());
  const projects = await Promise.all(listed.boards.map((board, n) => first[n] ? first[n] : named(board) ? read(board, true) : rest[n]));
  projects.push(...(listed.warnings || []).map((warning) => ({ ...warning, ok: false,
    warningCode: warning.error?.error?.code, error: warning.error?.error?.message || 'This board could not be read.' })));
  const groups = projectGroups(projects);
  const group = groups.find((entry) => entry.key === root);
  return {
    projects, groups, project: states.get(root) || null,
    group: group ? { name: group.name, repos: group.repos.filter((repo) => repo.ok).map((repo) => ({ root: repo.root, name: repo.name, board: states.get(repo.root) })) } : null,
  };
}

// Whether the server's state worker has stopped, so the status bar says the view serves from the request thread.
let stateWorkerStopped = false;
// What each local board last sent this page, {state, sequence, version}: the base its next read asks to extend.
const sentStates = new Map();
// #552's delta applier, embedded as the server's own source, so the page applies a delta and recomputes nothing.
const applyStateDelta = (${applyStateDelta.toString()});
// state.milestoneDelta (#9849): with it on, a milestone's forecast is derived here from its count left and the pace the page holds.
const MILESTONE_DELTA = ${JSON.stringify(typeof milestoneForecast === 'function')};
const deriveMilestoneForecasts = (${deriveMilestoneForecasts.toString()});
const milestoneForecast = ${typeof milestoneForecast === 'function' ? '(' + milestoneForecast.toString() + ')' : 'null'};
// Expand the opt-in wire dictionary before holding a delta base or rendering any item.
const expandItemSummaries = (${expandItemSummaries.toString()});

/**
 * Read one board's summary state. A local board the page read before asks only what changed since the state it holds
 * (#552) and applies that delta as sent; it loads a fresh snapshot only when the answer resets, as when the server no
 * longer keeps that base or the format changed (#555). Relay boards and snapshots have no deltas.
 */
async function boardRead(board, seen) {
  const path = '/api/v1/boards/' + encodeURIComponent(board.id) + '/state', mark = seen === null ? '' : 'seen=' + encodeURIComponent(seen);
  const local = !snapshot && localBoardIds.has(board.id), held = local ? sentStates.get(board.id) : null;
  if (held && Number.isSafeInteger(held.sequence)) {
    const reply = await api(path + '?since=' + held.sequence + (mark && '&' + mark) + (held.version === undefined ? '' : '&eventLogVersion=' + encodeURIComponent(held.version)));
    if (reply.delta) {
      // The finished items may have joined the kept state while this read was on its way: build on that state, at the same sequence, so the reply never puts the open-only one back (#8904).
      const now = sentStates.get(board.id), base = now && now.sequence === held.sequence ? now : held;
      const applied = applyStateDelta(base.state, reply.delta);
      const state = MILESTONE_DELTA ? deriveMilestoneForecasts(applied, milestoneForecast) : applied;
      // A state that already holds the finished items stays whole: the delta's counts never mark them omitted again (#6697).
      if (base.whole) { delete state.itemsOmitted; delete state.finished; }
      sentStates.set(board.id, { state, sequence: reply.sequence, version: reply.eventLogVersion, whole: base.whole });
      return withReadySplit(state);
    }
  }
  // A first load takes the state the server keeps (kept=1): the stream's opening catch-up reads the delta to now [A2,C7].
  // It asks for open work only (finished=omit): finished and withdrawn items come from ensureFinished when a screen shows them (#6697).
  const query = [mark, local ? 'items=compact' : '', local && !held ? 'finished=omit' : '', local && !held ? 'kept=1' : ''].filter(Boolean).join('&');
  const reply = await api(path + (query && '?' + query));
  const state = expandItemSummaries(reply.state);
  if (local) sentStates.set(board.id, { state, sequence: state.sequence, version: reply.eventLogVersion });
  // Release and Roadmap call ready what the Dashboard's NOW calls ready; the kept state stays as the board sent it (#7763).
  return withReadySplit(state);
}

// The same split the server's counts use, embedded so the page and the server agree on which open items are ready.
const readyAndBlocked = (${readyAndBlocked.toString()});
const splitReady = (${splitReady.toString()});
const withReadySplit = (${withReadySplit.toString()});

// U94's sidebar summary, embedded as its own source so the page and a server that serves it count alike.
const projectSummary = (${projectSummary.toString()});
/**
 * Read a listed board that is not opened as its summary: counts, rulings and last change, under 2 KB (U94). A local
 * board whose listing row offers summaryVersion 1 serves it at /summary; a relay board, a snapshot, or an API that
 * offers none gives its state, which the page reduces to the same summary. Asking only when offered keeps an older
 * API from answering a 404 the browser would log.
 */
async function summaryRead(board) {
  if (!snapshot && localBoardIds.has(board.id) && board.summaryVersion === 1) {
    const reply = await api('/api/v1/boards/' + encodeURIComponent(board.id) + '/summary');
    if (reply?.summary?.version === 1) return reply.summary;
  }
  const state = await boardRead(board, null);
  return projectSummary(state, personNeeds(state));
}

const finishedReads = new Set();
/**
 * Read the finished and withdrawn items an open-first state left out, once per board, and put them into the state the
 * page draws, so Items on Verified or All, the pipeline, search, Roadmap and an item address show them (#6697).
 * @param {object|null} project The state the page draws now.
 */
function ensureFinished(project) {
  const board = project?.itemsOmitted === 'finished' && data?.project === project ? data.projects.find((row) => row.root === data.root && row.ok) : null;
  if (!board || finishedReads.has(board.id)) return;
  finishedReads.add(board.id);
  api('/api/v1/boards/' + encodeURIComponent(board.id) + '/finished').then((reply) => {
    const held = sentStates.get(board.id);
    const into = held?.state ?? data.project;
    if (!into || into.itemsOmitted !== 'finished') return;
    const have = new Set(into.items.map((item) => item.id));
    const whole = { ...into, items: [...into.items, ...expandItemSummaries(reply.state).items.filter((item) => !have.has(item.id))] };
    delete whole.itemsOmitted; delete whole.finished;
    if (held) sentStates.set(board.id, { ...held, state: whole, whole: true });
    // The page draws a ready-split copy of the kept state (#7763), so the page's own state is replaced as well as the kept one (#7738).
    if (data.project === into || data.project === project) data.project = withReadySplit(whole);
    render();
  }, () => { finishedReads.delete(board.id); });
}

/** Whether a board state already carries every item's detail, as exports and event replays do. */
const fullItems = (project) => project.items.every((item) => Array.isArray(item.history));

/** Text available locally for an item before the API searches criteria omitted from summaries. */
const searchedText = (item) => ('#' + item.id + ' ' + item.title + ' ' + item.lane + ' ' + item.specs.join(' ') + ' ' + (item.criterion || '')).toLowerCase();

/** Whether the board's retained events hold an event of this item newer than a detail read. */
function movedSince(project, id, cursor) {
  return (project.events || []).some((event) => event.event_id > cursor && event.item_id === id);
}

/**
 * What says an item has moved: its last update, status and counts. A whole summary can differ between two polls of an
 * item that has not moved, and an event gap says nothing about this item, so neither drops a detail it read (#1039).
 */
const movedKey = (item) => JSON.stringify([item.id, item.updatedAt, item.status, item.counts]);

// Reads ahead of an expand, two at a time, so they never crowd out one the person asked for (#1039).
const aheadQueue = [];
let aheadBusy = 0;

/**
 * Start the next queued reads ahead while fewer than two are on their way. When the queue drains, one redraw puts what
 * landed into the folded rows, so each opens in place whole.
 */
function aheadNext() {
  while (aheadBusy < 2 && aheadQueue.length) {
    const entry = aheadQueue.shift();
    if (!entry.start) continue;
    aheadBusy++;
    entry.start().finally(() => { aheadBusy--; aheadNext(); if (!aheadBusy && !aheadQueue.length && view.tab === 'roadmap') render(); });
  }
}

/**
 * Load one item's omitted fields, retaining them while the item has not moved. ask is true for an item on show and
 * 'ahead' for a Roadmap row on screen, read in the background so its expand fills at once (#1039).
 */
function detailOf(project, item, ask, root = view.root) {
  if (Array.isArray(item.history)) return { item };
  const drawnRoot = view.root, key = root + '\\n' + item.id, moved = movedKey(item), shows = ask && ask !== 'ahead';
  const kept = itemDetails.get(key);
  /** Keep the prior detail visible during a refresh, or return the short initial loading state. */
  const waiting = (entry) => (entry?.shown ? { item: { ...item, ...entry.shown } } : { loading: true });
  if (kept?.loading) {
    // Asked for while it waits in the queue ahead, it starts now and draws when it lands.
    if (shows && !kept.wanted) { kept.wanted = true; if (kept.start) detailRead = kept.start(); }
    return waiting(kept);
  }
  if (kept && kept.moved === moved && !movedSince(project, item.id, kept.cursor) && !(shows && kept.error && Date.now() - kept.failedAt >= 2_500)) {
    return kept.error ? { error: kept.error } : { item: { ...item, ...kept.detail } };
  }
  if (!ask) return waiting(kept && { shown: kept.detail });
  const entry = { loading: true, wanted: shows, moved, cursor: project.events?.[0]?.event_id ?? 0, detail: null, error: null, shown: kept?.detail ?? null };
  itemDetails.set(key, entry);
  entry.start = () => {
    entry.start = null;
    return api(boardPath(root) + '/items/' + encodeURIComponent(String(item.id))).then((reply) => { entry.detail = reply.item; }, (error) => {
      // A read ahead that fails is forgotten, so the expand reads again; one on show reads again in 3 s while this item stays open (#908).
      if (!entry.wanted) { if (itemDetails.get(key) === entry) itemDetails.delete(key); return; }
      entry.error = String(error.message || error); entry.failedAt = Date.now(); setTimeout(() => { if (view.root === drawnRoot && view.item === item.id) render(); }, 3_000);
    }).finally(() => {
      entry.loading = false;
      if (entry.wanted && view.root === drawnRoot && ((root === view.root && view.item === item.id) || view.tab === 'roadmap')) render();
    });
  };
  if (shows) detailRead = entry.start();
  else { aheadQueue.push(entry); aheadNext(); }
  return waiting(entry);
}

// The rows the last Roadmap draw can read ahead, by row key (#1039).
const roadmapAhead = new Map();
let aheadFrame = 0;

/** Read ahead the detail of each folded Roadmap row on screen, once per frame, so its first expand fills at once (#1039). */
function aheadRoadmapRows() {
  // A page drawn outside a browser, as the list tests draw one, has no frames and reads nothing ahead.
  if (aheadFrame || view.tab !== 'roadmap' || typeof requestAnimationFrame !== 'function') return;
  aheadFrame = requestAnimationFrame(() => {
    aheadFrame = 0;
    for (const row of document.querySelectorAll('#roadmap .milestone-item[aria-expanded=false]')) {
      const box = row.getBoundingClientRect();
      if (box.height && box.bottom > 0 && box.top < innerHeight) roadmapAhead.get(row.dataset.roadmapKey)?.();
    }
  });
}

/** Search full snapshots locally and summary states through the API, once per query and board. */
function searchIds(project, words) {
  const query = words.trim().toLowerCase();
  const local = new Set(project.items.filter((item) => searchedText(item).includes(query)).map((item) => item.id));
  if (!query || fullItems(project) || data.root !== view.root) return local;
  const root = view.root, key = root + '\\n' + query;
  const kept = itemSearches.get(key);
  if (kept) return kept.ids || local;
  const entry = { ids: null };
  itemSearches.set(key, entry);
  api(boardPath(root) + '/items?q=' + encodeURIComponent(query)).then((reply) => {
    entry.ids = new Set(reply.ids);
    if (view.root !== root || $('q').value.trim().toLowerCase() !== query) return;
    render();
    if (!$('find-results').hidden) showFound();
  }, () => {
    if (itemSearches.get(key) === entry) itemSearches.delete(key);
  });
  return local;
}

// Keep credential metadata apart from board snapshots and scoped to the selected project (H2,H9).
const credentials = new Map();

/** Draw only allowlisted credential metadata; bearer values never enter page state or markup. */
function renderCredentials() {
  const region = $('credentials');
  region.hidden = snapshot || readOnly;
  if (region.hidden) { region.innerHTML = ''; return; }
  const state = credentials.get(view.root);
  /** Render an inventory timestamp without shortening its date or timezone. */
  const stamp = (value) => value === null ? 'Unknown' : new Date(value).toISOString();
  region.innerHTML = '<button class="link" data-credentials type="button" aria-expanded="' + Boolean(state) + '"' + (state?.busy ? ' disabled' : '') + '>Agent credentials</button>'
    + (state ? '<p role="status">' + esc(state.message || '') + '</p>'
      + state.tokens.map((row) => '<article class="credential" data-token-id="' + esc(row.id) + '"><b>' + esc(agentName(row.agent)) + '</b><code>' + esc(row.id) + '</code>'
        + '<dl><dt>Created</dt><dd>' + esc(stamp(row.created)) + '</dd><dt>Expires</dt><dd>' + esc(stamp(row.expires)) + '</dd></dl>'
        + (row.revoked ? '<span class="chip">Revoked</span>' : '<button class="ghost" type="button" data-revoke-token="' + esc(row.id) + '"' + (state.busy ? ' disabled' : '') + '>Revoke</button>') + '</article>').join('') : '');
}

/** Load this board's public metadata on demand, without granting any person authority. */
async function loadCredentials(root = view.root) {
  if (snapshot || relayProject(root) || (!hosted.local && pageReadOnly)) return;
  const state = credentials.get(root) || { tokens: [], message: '', busy: false };
  credentials.set(root, state);
  state.message = 'Loading agent credentials…';
  if (root === view.root) renderCredentials();
  try {
    const reply = await api(boardPath(root) + '/tokens');
    state.tokens = reply.tokens.map(({ id, agent, created, expires, revoked }) => ({ id, agent, created, expires, revoked }));
    state.message = state.tokens.length ? '' : 'No agent credentials.';
  } catch (error) { state.message = String(error.message || error); }
  if (root === view.root) renderCredentials();
}

/** Revoke a listed id through the existing one-tap phone grant, then reread its public metadata. */
async function revokeCredential(id) {
  if (snapshot || relayProject(view.root) || (!hosted.local && pageReadOnly)) return;
  const root = view.root, state = credentials.get(root);
  if (!state || state.busy || !state.tokens.some((row) => row.id === id && !row.revoked)) return;
  state.busy = true;
  state.message = 'Approve revocation on your phone…';
  renderCredentials();
  try {
    const result = await api(boardPath(root) + '/tokens', { id });
    if (result.id !== id || result.revoked !== true) throw new Error('Revocation was not acknowledged; refresh the credential list.');
    state.tokens = state.tokens.map((row) => row.id === id ? { ...row, revoked: true } : row);
    await loadCredentials(root);
    state.message = 'Credential revoked.';
  } catch (error) { state.message = String(error.message || error); }
  state.busy = false;
  if (root === view.root) renderCredentials();
}

// Each item object's text, and each text's number, for boardText (#6851).
const itemTexts = new WeakMap();
const itemNumbers = new Map();
let itemCount = 0;
/**
 * A board read as text with its clock readings blanked: root observedAt, the flow's observation time (asOf) and each
 * queue's oldest age (ageMinutes) are stamped afresh on every read, so clock-only changes show the same board (#644).
 * The two-hour window comparison (statsComparison) ends at the read's own clock, so it is blanked too; the Dashboard
 * still draws each read's comparison in place, and a real change moves the board's events with it.
 * Authenticated local report metadata compares recorded facts and native expiry, not display-only duration increments.
 * Matching whole JSON keys is safe: a quote inside any string value is escaped, so no title can look like one.
 */
function boardText(state) {
  const observations = new Set([state?.project, ...(state?.group?.repos ?? []).map(repo => repo.board)]);
  const blank = (key, value) => value && typeof value === 'object' && reportValidators.has(value)
    ? { reportValidator: reportValidators.get(value) }
    : key === 'statsComparison' ? null
    : observations.has(value) && value && Object.hasOwn(value, 'observedAt') ? { ...value, observedAt: null } : value;
  const clocks = (text) => text.replace(/"(asOf|ageMinutes)":(?:"[^"]*"|[-+.0-9eE]+|null)/g, '"$1":null');
  // Each item is written as its text's number: a live update keeps every unchanged item's object, so only the items that
  // changed are written out, and the board's text stays small (#6851). The same text has one number, never reused.
  const lists = new Set([state?.project?.items, ...(state?.projects ?? []).map(board => board?.items),
    ...(state?.group?.repos ?? []).map(repo => repo.board?.items)].filter(Array.isArray));
  if (itemNumbers.size > 100000) itemNumbers.clear();
  return clocks(JSON.stringify(state, function (key, value) {
    if (!lists.has(this) || !value || typeof value !== 'object') return blank(key, value);
    let text = itemTexts.get(value);
    if (text === undefined) {
      text = clocks(JSON.stringify(value, blank));
      itemTexts.set(value, text);
    }
    if (!itemNumbers.has(text)) itemNumbers.set(text, itemCount++);
    return itemNumbers.get(text);
  }));
}

/** Show each queue's oldest age from the board on hand in place: the one thing on the page that moves with the clock alone. */
function showFlowAges() {
  const flow = data?.project?.proofStats?.flow;
  if (!flow) return;
  for (const node of document.querySelectorAll('#proof-stats [data-oldest]')) {
    const oldest = flow.queues[node.dataset.oldest]?.oldest;
    node.dataset.value = oldest?.ageMinutes ?? '';
    node.textContent = oldestLine(oldest);
  }
}

/** Refresh from API v1, every board or only those in fresh, and discard a response for a project the person left. */
`;
}
