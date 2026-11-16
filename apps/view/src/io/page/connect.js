import {
  heldChip,
  heldNote,
} from "../held.js";
import { agentFloorModel } from "../../logic/agent/floor/model.js";
import { firstRunKit } from "../first/run.js";
import { agentFloorHtml } from "../../logic/agent/floor/render.js";
import { recordRowHtml } from "../../logic/row.js";
import { verdictHtml as verdictRenderer } from "../../logic/render/verdict.js";
import { visibleVerdictNote } from "../../logic/render/verdict.js";
import { replayItem } from "../../logic/pipeline/model.js";
import { pipelineStage } from "../../logic/pipeline/model.js";
import { pipelineSince } from "../../logic/pipeline/model.js";
import { itemListFields } from "../../logic/pipeline/model.js";
import { itemStagePresentation } from "../../logic/pipeline/model.js";
import { withdrawnFromStatus } from "../../logic/pipeline/model.js";
import { itemStageKey } from "../../logic/pipeline/model.js";
import { itemLanded } from "../../logic/counts.js";
import { stageSentence } from "../../logic/pipeline/model.js";
import { pipelineHtml } from "../../logic/pipeline/render.js";
import { pipelineWatchModel } from "../../logic/pipeline/watch.js";
import { pipelineWatchHtml } from "../../logic/pipeline/watch.js";
import { pipelineRuntime } from "../pipeline/runtime.js";
import { lifecycleDiagramHtml } from "../../logic/lifecycle/diagram.js";
import { timelineHtml as renderTimelineHtml } from "../../logic/timeline/render.js";
import { timelineBodyHtml } from "../../logic/timeline/body.js";
/**
 * Part 2 of the hosted page's script, verbatim from apps/cli/src/io/cockpit.js lines 332-1298 (#745): its
 * text is what the page served before the split, with the values its ${} expressions read passed in as scope.
 *
 * @param {Record<string, any>} scope - The values cockpitPage passes for the names this part interpolates.
 * @returns {string} The script text of this part.
 */
export function pageScriptPart2(scope) {
  const { firstRunCoordinate, sharedRowHtml, activityWords, activityModel, activityHtml, activityFilters, activityFlow, activityPageHtml, activityTipHtml, activityStep, activityStart, activityRuntime, lifecycleChart, segmentedToggle, revealSegmentedChoices, dashboardModel, dashboardHtml, comparisonHtml, dashboardRuntime, STAR_KEY, closePageDialog, connection, drawHosted, homeCapacity, homeRules, hostedBrowser, hostedReleaseDistance, hostedReleaseNote, hostedState, lifecycle, lifecycleEvent, lifecycleMove, openPageDialog, personNeeds, releaseHosted, releaseInfo, roadmapBlock, roadmapHeaders, roadmapSummary, sharingPresentation, staleChip, transportModule } = scope;
return `let detailRead = null;
const addressedShouts = new Map();
const $ = (id) => document.getElementById(id);
/**
 * The page's one runtime stylesheet: geometry that only the running page can measure (a windowing spacer, a menu's
 * position, a scroll margin). An element names its rule with data-geo="key" and the rule is written here, so no element
 * carries an inline style; the sheet is built through the style API, which the page's policy allows. Declarations are
 * { 'css-property': 'value' }; a key given null or no declarations drops its rule.
 */
const geometryRules = new Map();
let geometrySheet = null;
function geometry(key, declarations) {
  if (declarations && Object.keys(declarations).length) {
    const rule = '[data-geo="' + key + '"]{' + Object.entries(declarations).map(([property, value]) => property + ':' + value).join(';') + '}';
    if (geometryRules.get(key) === rule) return;
    geometryRules.set(key, rule);
  } else if (!geometryRules.delete(key)) return;
  if (typeof CSSStyleSheet !== 'function' || !('adoptedStyleSheets' in document)) return;
  if (!geometrySheet) { geometrySheet = new CSSStyleSheet(); document.adoptedStyleSheets = [...document.adoptedStyleSheets, geometrySheet]; }
  geometrySheet.replaceSync([...geometryRules.values()].join(''));
}
const sharedRowHtml = (${sharedRowHtml.toString()});
const activityWords = (${activityWords.toString()});
const activityModel = (${activityModel.toString()});
const activityFilters = (${activityFilters.toString()});
const segmentedToggle = (${segmentedToggle.toString()});
const revealSegmentedChoices = (${revealSegmentedChoices.toString()});
const activityHtml = (${activityHtml.toString()});
const activityFlow = (${activityFlow.toString()});
const activityPageHtml = (${activityPageHtml.toString()});
const activityTipHtml = (${activityTipHtml.toString()});
const activityStep = (${activityStep.toString()});
const activityStart = (${activityStart.toString()});
const lifecycleChart = (${lifecycleChart.toString()});
const itemLanded = (${itemLanded.toString()});
const dashboardModel = (${dashboardModel.toString()});
const comparisonHtml = (${comparisonHtml.toString()});
/** Defer the shared clock lookup until the page has initialized its formatter. */
const dashboardWhen = iso => when(iso);
const dashboardView = (${dashboardRuntime.toString()})({ model: dashboardModel, html: (${dashboardHtml.toString()}), stagePresentation: (${itemStagePresentation.toString()}), when: dashboardWhen, working: project => store.select('nav-numbers', [project, view.allAgents, Math.floor(Date.now() / 60_000)], navNumbers).agentIds, api, boardPath, current: () => view.root, redraw: () => { if (view.tab === 'dashboard' && data?.project) render(); }, summary: (entry, context) => roadmapSummary(entry, context), firstRun: { kit: (${firstRunKit.toString()})({ coordinate: ${firstRunCoordinate === true} }), hidden: root => keep('pb.firstrun.' + root) === 'hidden', href: (tab, detail) => { const kept = view.addressDetail; view.addressDetail = detail; try { return tabHref(tab); } finally { view.addressDetail = kept; } } }, agentsTable: () => view.tab === 'dashboard' && view.addressDetail === 'agents', floor: { open: () => view.tab === 'dashboard' && view.addressDetail === 'floor', model: (${agentFloorModel.toString()}), html: (${agentFloorHtml.toString()}), href: (detail) => { const kept = view.addressDetail; view.addressDetail = detail; try { return tabHref('dashboard'); } finally { view.addressDetail = kept; } } } });
// The Activity page: the board's last hours of events and the live snapshot, drawn into #activity (#6916).
const activityView = (${activityRuntime.toString()})({ flow: activityFlow, html: activityPageHtml, tip: activityTipHtml, step: activityStep, start: activityStart, api, boardPath,
  current: () => view.root, view: () => view, project: () => data?.project, active: () => view.tab === 'activity',
  itemHref: id => itemAddress(id),
  working: project => store.select('nav-numbers', [project, view.allAgents, Math.floor(Date.now() / 60_000)], navNumbers).agentIds,
  controls: () => pageControlsHtml({ tab: 'activity', by: view.activityBy || null, people: view.activityPeople || [], activity: view.activityFilter || 'all', counts: view.activityCounts || null, win: view.activityWin || 24 }),
  onFilter: value => { view.activityFilter = value; address(); drawPageControls(); }, after: () => drawPageControls(), drawn: () => drawHistoryNotes(),
  remember: (root, value) => value === undefined ? (Number(keep('pb.activity.left.' + root)) || null) : keep('pb.activity.left.' + root, String(value)) });
// The Insights Pipeline page (#6869): the held event history the Dashboard reads, this machine's CPU samples, and the pure model and markup.
const pipelineView = (${pipelineRuntime.toString()})({ model: (${pipelineWatchModel.toString()}), html: (${pipelineWatchHtml.toString()}), history: project => dashboardView.history(project), api, current: () => view.root,
  redraw: () => { if (view.tab === 'pipeline' && data?.project) render(); }, windowMinutes: () => ({ '15m': 15, '30m': 30, '3h': 180 })[view.pipelineWindow] ?? 60,
  itemsHref: ids => itemsIdsHref(ids), itemHref: id => itemAddress(id), openItems: ids => openPipelineItems(ids), machineHere: privateCost });
// The update note from src/view/hosted-release.js (#632): only a confirmed read of this machine's view says how far behind it is.
// Only the hosted page builds it; every other page draws nothing and never touches the DOM for it.
const renderHostedReleaseNote = ${releaseHosted ? `(${hostedReleaseNote.toString()})(${releaseInfo}, { $, keep, distance: (${hostedReleaseDistance.toString()}),
  // The selected board's own source decides (#632 review): a confirmed local board keeps its note on a mixed list that
  // also reads relay boards, and a selected relay board never shows one; with no board selected, only an all-local page.
  readable: () => {
    if (!hosted.local || !localConfirmed || !localSession || connection.base !== localSession.origin) return false;
    const board = data?.projects?.find((entry) => entry.root === view.root && entry.ok);
    return board ? boardSources.get(board.id)?.kind === 'local' : !transportModule && !transport;
  },
  project: (project = data?.project) => project?.releaseNotes ? project : data?.projects?.find((entry) => entry.ok && entry.releaseNotes) })` : '() => {}'};

const hostedState = (${hostedState.toString()});
const hostedBrowser = (${hostedBrowser.toString()});
const drawHosted = (${drawHosted.toString()});
/**
 * Show the open-board screen the page is in (src/view/hosted.js), or none with null. A phone is the one the relay's
 * page names before first paint (#757), and it hears nothing about this computer.
 */
function localNote(state, facts = {}) {
  drawHosted(document, hostedState(state, { browser: hostedBrowser(navigator), phone: document.documentElement.dataset.relayDevice === 'phone', localNavigationOnly, localOriginKnown: Boolean(localSession), signedIn: hosted.relaySession, ...facts }), { view: localSession?.origin || LOCAL_VIEW, signIn: hosted.signIn, session: hosted.relaySession });
  revealNote(state);
}

let revealTimer = null;
/**
 * Leave the hosted page's neutral mark for the screen just drawn (#948). A screen the page settles on shows at once.
 * Finding your boards and Click Allow are on the way to another screen, so they show only once they last past the
 * page's slow threshold, and a fast look never flashes them (#932). For a signed-in person the other local screens
 * are on the way too, since the account's list decides next, and startPage leaves the mark once it has.
 */
function revealNote(state) {
  clearTimeout(revealTimer);
  if (!state || !document.body.classList.contains('loading')) return;
  const passing = state === 'looking' || state === 'asking';
  if (!passing && hosted.relaySession && LOCAL_STATES.includes(state)) return;
  if (!passing) { document.body.classList.remove('loading'); return; }
  revealTimer = setTimeout(() => { if ($('local-note').dataset.state === state) document.body.classList.remove('loading'); }, 800);
}

let starLinked = { at: 0, linked: false, reading: false };
/**
 * Show the hosted page's star line (src/view/star.js) to a signed-in person whose account lists a linked board, until
 * dismissed here; pass a board list through. Why the account's list: it is the linked-board metadata the relay serves
 * this page, whichever source then draws a board, so a linked board this machine reads locally still counts, and no
 * relay client loads to decide it. It is read until it lists one, at most every few seconds, and
 * declares the relay's engine as every relay request does.
 */
function starLine(list) {
  const line = $('star-line');
  if (!line) return list;
  const show = () => { line.hidden = !(hosted.relaySession && starLinked.linked && keep(${JSON.stringify(STAR_KEY)}) !== 'dismissed'); };
  const learn = (reply) => {
    const linked = Boolean(reply?.boards?.some((board) => typeof board?.id === 'string'));
    starLinked = { at: Date.now(), linked, reading: false };
    line.dataset.linked = linked ? 'yes' : 'no';
    show();
  };
  if (hosted.relaySession && !starLinked.linked && !starLinked.reading) {
    // The page's own read of the account, when it made one since the line last looked, answers the line, refused
    // or not: the line reads the account itself only when the page made no such read, so a listing never brings a
    // second one (#817).
    if (linkedSeen && linkedSeen.at > starLinked.at) learn(linkedSeen.reply);
    else if (Date.now() - starLinked.at > 2500) {
      starLinked = { at: Date.now(), linked: false, reading: true };
      linkedList().then(learn, () => learn(null));
    }
  }
  show();
  return list;
}
$('star-dismiss')?.addEventListener('click', () => { keep(${JSON.stringify(STAR_KEY)}, 'dismissed'); starLine(null); });
// No first look of its own (#817): every signed-in page lists its boards, and api() hands that list here, so the
// account is read only after a listing succeeds, never beside it. A session that its first listing revokes therefore
// sees exactly one listing, and the line, hidden in its markup, stays hidden until a listing shows it.

/** Hide the relay's own banner, which speaks for the relay, on a page the relay does not serve this time. */
function hideRelayNotice() {
  const banner = document.getElementById('relay-notice');
  if (banner) banner.hidden = true;
}

/** Send this tab on the round trip to the local view, which sends it straight back here; two tries in a row at most. */
function localTrip(base) {
  const trips = Number(tabValue(LOCAL_TRIPS) || 0);
  if (trips >= 2) {
    tabValue(LOCAL_TRIPS, null);
    localNote('problem', { detail: 'Pullboard on this computer did not give this page a session it accepts.' });
    return false;
  }
  tabValue(LOCAL_TRIPS, String(trips + 1));
  location.assign(base + '/local/connect');
  return true;
}

/** The local view refused this tab's secret, as after a restart with a new one: go round again for it, unasked. */
function localExpired() {
  const base = localSession.origin;
  localSession = null;
  localConfirmed = false;
  tabValue(LOCAL_TAB, null);
  localTrip(base);
}

// The screens that wait on this computer: the page looks again by itself while one shows, with no Try again (#764).
const LOCAL_STATES = ['looking', 'asking', 'blocked', 'not-running', 'mismatch'];
let localChecking = false;
let localReached = false;
let localNavigationOnly = false;

/**
 * Reach this machine's view: read the view's public protocol, which holds no secret and no board, and take the session
 * the round trip brought back. While the browser asks the person, which it does before the request goes anywhere, the
 * page draws the prompt and says it waits. It is 'local' when the page now reads the local view, 'away' when the
 * browser is on the round trip, 'unreachable' when the page cannot read it, with the screen that says why, and 'busy'
 * while another look is still on its way. A look again by itself (again) redraws only a screen that waits on this
 * computer, so a later screen, such as signing in, stays.
 */
async function connectLocal(again = false) {
  // A phone never runs Pullboard: it is unreachable at once, before a permission query or a fetch can wait (#900).
  if (pageStartup(document.documentElement).phone) return 'unreachable';
  // WebKit refuses HTTPS-to-HTTP loopback reads even after a secret handoff. A top-level link opens the view itself,
  // where its normal session key and same-origin requests work; keep relay boards and their pairing screens independent.
  if (location.protocol === 'https:' && hostedBrowser(navigator) === 'Safari') {
    localNavigationOnly = true;
    if (!again) localNote('local-open', { listed: hosted.relaySession });
    return 'unreachable';
  }
  if (localChecking) return 'busy';
  localChecking = true;
  try { return await lookLocal(again); }
  finally { localChecking = false; }
}

/** One look for this machine's view, for connectLocal, which keeps two from running at once. */
async function lookLocal(again) {
  const base = localSession?.origin || LOCAL_VIEW;
  /** Draw this screen, unless the page has moved past the ones that wait on this computer. */
  const show = (state) => {
    const shown = $('local-note').dataset.state || '';
    if (shown !== state && (!again || LOCAL_STATES.includes(shown))) localNote(state);
  };
  let permission = null;
  for (const name of ['loopback-network', 'local-network-access']) {
    try { permission = (await navigator.permissions.query({ name })).state; break; } catch { /* this browser has no such permission */ }
  }
  if (permission === 'denied') {
    show('blocked');
    return 'unreachable';
  }
  // A browser that says it will ask gets Click Allow on screen before the request that raises its prompt; one that
  // says nothing gets it only once the request is slow to come back, as it is while a prompt waits.
  let slow = null;
  if (permission === 'prompt' && !again) {
    show('asking');
    await new Promise((painted) => requestAnimationFrame(() => requestAnimationFrame(painted)));
  } else if (permission !== 'granted' && !again) slow = setTimeout(() => show('asking'), 800);
  let reply;
  try {
    for (let attempt = 1; !reply; attempt += 1) {
      try { reply = await fetch(base + '/local/protocol', { signal: AbortSignal.timeout(3000), credentials: 'omit', redirect: 'error' }); }
      catch (error) {
        // A read that ran out of time may have met a slow first answer or a browser prompt still open, so it asks once
        // more (#786). After that, one that ran out of time while the browser may still be asking is the prompt waiting
        // for the person, and one refused at once means nothing runs here (#764). One discovery request at a time is all
        // this page makes of this device (P5), so a view too old to answer it reads as none.
        if (attempt < 2 && error?.name === 'TimeoutError') continue;
        show(error?.name === 'TimeoutError' && permission !== 'granted' ? 'asking' : 'not-running');
        return 'unreachable';
      }
    }
  } finally { clearTimeout(slow); }
  let protocol = null;
  try { protocol = await reply.json(); } catch { /* not this protocol */ }
  if (!reply.ok || protocol?.version !== 1 || protocol?.apiVersion !== 1 || protocol?.hostedOrigin !== location.origin) {
    show('mismatch');
    return 'unreachable';
  }
  if (!localSession) return localTrip(base) ? 'away' : 'unreachable';
  connection.base = localSession.origin;
  connection.headers = { 'x-pullboard-key': localSession.key };
  localReadBase = connection.base;
  localReadHeaders = { ...connection.headers };
  readOnly = false;
  requests = false;
  localReached = true;
  document.body.classList.remove('read-only', 'requests');
  hideRelayNotice();
  // Finding your boards stays until the list arrives, so the page never shows an empty board on its way to one.
  if (LOCAL_STATES.includes($('local-note').dataset.state || '')) localNote('looking');
  return 'local';
}

/** Mark primary pointer targets whose click would be lost if a refresh replaces them. */
function holdClickPointer(event) {
  if (!event.isPrimary || event.button !== 0 || !(event.target instanceof Element && event.target.closest('#pipeline .pipeline-item, #spec-detail [data-row-decision="decline"], #spec-decline-submit, #roadmap-panel [data-roadmap-jump]'))) return;
  heldClickPointer = event.pointerId;
}

/** Flush a deferred refresh only after the browser has had the chance to dispatch the resulting click. */
function releaseClickPointer(event) {
  if (event.pointerId !== heldClickPointer) return;
  heldClickPointer = null;
  if (deferredClickRender) requestAnimationFrame(() => {
    if (heldClickPointer === null && deferredClickRender) {
      deferredClickRender = false;
      render();
    }
  });
}

document.addEventListener('pointerdown', holdClickPointer, true);
document.addEventListener('pointerup', releaseClickPointer, true);
document.addEventListener('pointercancel', releaseClickPointer, true);
/**
 * Draw the page in the theme the person picked, light or dark; with none picked it follows the system, live. The button
 * only ever offers the other of the two: it shows the scheme on screen, and a press picks the opposite. Following the
 * system again waits for a settings page. The tokens hold both values, so only the scheme they answer to changes.
 */
function theme(pick) {
  if (pick === 'light' || pick === 'dark') document.documentElement.dataset.theme = pick;
  else delete document.documentElement.dataset.theme;
  const now = document.documentElement.dataset.theme || (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
  document.documentElement.dataset.scheme = now;
  // The open-board screens carry the same toggle in their own header (#764), as the sidebar is hidden there.
  for (const label of document.querySelectorAll('[data-theme-label]')) label.textContent = pick === 'light' ? 'Light' : pick === 'dark' ? 'Dark' : 'System';
  for (const button of [$('ob-theme')]) {
    button.title = now === 'dark' ? 'Dark theme: switch to light' : 'Light theme: switch to dark';
    button.setAttribute('aria-label', button.title);
  }
}
theme(keep('pb.theme'));
matchMedia('(prefers-color-scheme: dark)').addEventListener?.('change', () => theme(keep('pb.theme')));
/** The project list is always the switcher's dropdown, never a docked sidebar. */
document.documentElement.dataset.side = 'collapsed';
/** The navigation sits at the top or in the sidebar, as the pin last chose on this device; a phone always gets the top. */
const widePage = matchMedia('(min-width: 901px)');
function placeNav() {
  const layout = navLayout({ stored: keep('pb.nav'), wide: widePage.matches });
  document.documentElement.dataset.nav = layout;
  const pin = document.getElementById('nav-pin');
  if (!pin) return;
  const words = layout === 'side' ? 'Move the navigation to the top' : 'Move the navigation to the sidebar';
  pin.setAttribute?.('aria-pressed', String(layout === 'side'));
  pin.setAttribute?.('aria-label', words);
  pin.title = words + ' (\\\\)';
  pin.querySelector?.('.pg')?.classList?.toggle('up', layout === 'side');
}
/** The pin flips the layout and this device remembers it. */
function flipNav() {
  keep('pb.nav', document.documentElement.dataset.nav === 'side' ? 'top' : 'side');
  placeNav();
  placeControls();
}
placeNav();
widePage.addEventListener?.('change', () => { placeNav(); placeControls(); });
const esc = (text) => String(text ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
// Inline code: a short chip stays whole on its line; one wider than a phone line's worth may wrap. Width
// is in columns, as a terminal counts them: CJK, full-width and emoji characters take two.
const wideChar = (c) => { const p = c.codePointAt(0); return (p >= 0x1100 && p <= 0x115f) || (p >= 0x2e80 && p <= 0xa4cf) || (p >= 0xac00 && p <= 0xd7a3) || (p >= 0xf900 && p <= 0xfaff) || (p >= 0xfe30 && p <= 0xfe4f) || (p >= 0xff00 && p <= 0xff60) || (p >= 0xffe0 && p <= 0xffe6) || (p >= 0x1f300 && p <= 0x1faff) || (p >= 0x20000 && p <= 0x3fffd); };
const columns = (text) => [...String(text)].reduce((n, c) => n + (wideChar(c) ? 2 : 1), 0);
const codeChip = (text, kind = '') => (kind === 'sha' || /^[0-9a-fA-F]{40}$/.test(String(text))) && String(text).length > 10
  ? '<button class="hash-copy" type="button" title="' + esc(text) + '" aria-label="Copy full hash ' + esc(text) + '" data-copy="' + esc(text) + '"><code class="inline sha" title="' + esc(text) + '">' + esc(String(text).slice(0, 12)) + '</code></button>'
  : '<code class="inline' + (kind ? ' ' + kind : '') + (columns(text) > 24 ? ' long" title="' + esc(text) : '') + '">' + esc(text) + '</code>';
// An age said in words, as a shout's card shows it: now, 2m ago, 1h ago.
const agoLong = (iso) => { const short = ago(iso); return short === 'now' ? 'now' : short + ' ago'; };
const ago = (iso) => { const m = Math.round((Date.now() - Date.parse(iso)) / 60000); return m < 1 ? 'now' : m < 60 ? m + 'm' : m < 2880 ? Math.round(m / 60) + 'h' : Math.round(m / 1440) + 'd'; };
// An age as the page shows it: the moment it counts from stays on it, so tickAges can move it on.
const age = (iso) => '<time data-ago="' + esc(iso) + '">' + ago(iso) + '</time>';
// The browser's date words come from formatters made once: making one per moment cost an item's history 100 ms (#6851).
const dateWords = {};
const dateFormat = (name, options) => dateWords[name] || (dateWords[name] = new Intl.DateTimeFormat([], options));
const clock = (iso) => dateFormat('clock', { hour: 'numeric', minute: '2-digit', hour12: true }).format(new Date(iso));
const when = (iso) => (new Date(iso).toDateString() === new Date().toDateString() ? '' : dateFormat('day', { month: 'short', day: 'numeric' }).format(new Date(iso)) + ' ') + clock(iso);
/** Keep the Roadmap detail's existing local display at the browser boundary. */
const roadmapTime = iso => { const moment = new Date(iso), clock = dateFormat('roadmap', { hour: 'numeric', minute: '2-digit' }).format(moment); return moment.toDateString() === new Date().toDateString() ? clock : dateFormat('day', { month: 'short', day: 'numeric' }).format(moment) + ' ' + clock; };
// A day as a feed names it: Today, Yesterday, or its weekday and date.
const dayName = (iso) => {
  const then = new Date(iso).toDateString(), today = new Date();
  if (then === today.toDateString()) return 'Today';
  today.setDate(today.getDate() - 1);
  return then === today.toDateString() ? 'Yesterday' : new Date(iso).toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' });
};
// When the page last named days, so tickDays can rename them in place once the clock passes midnight (#644).
let daysNamedAt = new Date();
// A feed's rows, newest first, with the day named above each run of rows from the same day.
const byDay = (rows, at, row) => { daysNamedAt = new Date(); return rows.map((x, i) => (i && new Date(at(x)).toDateString() === new Date(at(rows[i - 1])).toDateString() ? '' : '<h4 class="day">' + dayName(at(x)) + '</h4>') + row(x)).join(''); };
// Where the shouts cross into an earlier day, a rule names it in the middle; today needs no label at the top.
const dayRules = (rows, at, row) => { daysNamedAt = new Date(); return rows.map((x, i) => {
  const day = new Date(at(x)).toDateString(), before = i ? new Date(at(rows[i - 1])).toDateString() : new Date().toDateString();
  return (day === before ? '' : '<div class="day-rule" role="separator"><span>' + dayName(at(x)) + '</span></div>') + row(x);
}).join(''); };
const firstLine = (text) => String(text ?? '').split('\\n').map((line) => line.trim()).find(Boolean) || '';
const visibleVerdictNote = (${visibleVerdictNote.toString()});
const verdictRenderer = (${verdictRenderer.toString()});
// The latest verdict is a reject and no accept followed: open again, being reworked, resubmitted, or
// withdrawn after it.
const rejected = (i) => i.status !== 'verified' && !!i.verdict && i.verdict.decision === 'REJECT';
/** Resolve visible agent text from this board's API without changing action identities. */
function agentName(id, project = data?.project) {
  const agent = project?.agents?.find((entry) => entry.agent_id === id);
  const model = [agent?.model, agent?.agent_model].find(value => typeof value === 'string' && value.trim() && value.trim().toLowerCase() !== 'unknown');
  if (!model) return id;
  if (!privateCost) return agent.displayName || id + ' (' + model + ')';
  const named = modelPresentation(model, agent.family).name;
  return agent.displayName?.endsWith('-' + id) ? named + '-' + id : id + ' (' + named + ')';
}
/** Project model labels for private renderers while preserving the native API and public pages. */
function privateModelProject(project) {
  if (!privateCost || !project) return project;
  return { ...project, agents: (project.agents || []).map(agent => {
    const raw = agent.model || agent.agent_model;
    if (typeof raw !== 'string' || !raw.trim()) return agent;
    const name = modelPresentation(raw, agent.family).name;
    const id = agent.agent_id || agent.id;
    return { ...agent, model: name, agent_model: name,
      displayName: agent.displayName?.endsWith('-' + id) ? name + '-' + id : id + ' (' + name + ')' };
  }) };
}
/** Name a typed native event without changing its operation or replay identity. */
const eventWords = kind => activityWords({ kind }).label;
/** Name a lifecycle boundary as a noun, without exposing its internal operation. */
const eventMoment = kind => ({ lapse: 'lease expiry', claim: 'start of building', renew: 'lease renewal', submit: 'submission for review', accept: 'review approval', reject: 'return for rework', reopen: 'reopening', merged: 'landing', add: 'creation', release: 'release', refreeze: 'criterion refreeze', rehomeImport: 'work import', intake: 'arrival for review', 'submit-merge': 'submission update', patch: 'work update' }[kind] || 'recorded update');
/** Prepare browser clock labels before the pure notice formatter sees any presentation text. */
function findingWords(finding, preserveWords = false) {
  const timestampLabels = new Map();
  for (const text of [finding.why, finding.next, finding.since]) {
    for (const match of String(text ?? '').matchAll(/\\b\\d{4}-\\d\\d-\\d\\dT\\d\\d:\\d\\d:\\d\\d(?:\\.\\d+)?(?:Z|[+-]\\d\\d:\\d\\d)\\b/gu))
      if (Number.isFinite(Date.parse(match[0]))) timestampLabels.set(match[0], when(match[0]));
  }
  return activityWords(finding, { now: Date.now(), timestampLabels, preserveWords });
}
/** Display a plain reason while retaining its exact native code as a tooltip. */
const reasonHtml = code => '<span title="' + esc(code) + '">' + esc(activityWords({ cause: code }).label) + '</span>';
/** Keep a shout address whole while its model can shorten, retaining the API name for assistive readers. */
function shoutAgentName(id) {
  const name = agentName(id);
  if (name === id) return '<span class="agent-address" role="group" aria-label="' + esc(id) + '">' + esc(id) + '</span>';
  const prefix = name.endsWith('-' + id);
  const model = prefix ? name.slice(0, -id.length) : name.slice(id.length);
  const address = '<span class="agent-id">' + esc(id) + '</span>';
  const label = '<span class="agent-model">' + esc(model) + '</span>';
  return '<span class="agent-label' + (prefix ? ' prefix' : '') + '" title="' + esc(name) + '" role="group" aria-label="' + esc(name) + '">' + (prefix ? label + address : address + label) + '</span>';
}
/** Render a review note with escaped text and references bound to the selected board. */
const verdictHtml = (v, titles) => verdictRenderer({ verdict: v, decisionLabel: v.decision === 'ACCEPT' ? 'Accepted' : 'Sent back', reasonLabel: activityWords({ cause: v.reason }).label, agentLabel: agentName(v.by), timeLabel: when(v.at), noteHtml: inline(visibleVerdictNote(v.reason, v.note), titles) });
const homeRules = (${homeRules.toString()});
const homeCapacity = (${homeCapacity.toString()});
const roadmapSummary = (${roadmapSummary.toString()}), roadmapHeaders = (${roadmapHeaders.toString()});
const stateOf = (i) => i.status === 'claimed' ? 'building' : i.status === 'submitted' ? 'verify' : i.status === 'verified' ? 'verified' : i.status === 'withdrawn' ? 'withdrawn' : i.verdict && i.verdict.decision === 'REJECT' ? 'back' : 'open';
const STATES = { building: ['building', 'busy'], verify: ['to verify', 'warn'], back: ['sent back', 'no'], verified: ['verified', 'ok'], open: ['unclaimed', 'free'], withdrawn: ['withdrawn', ''] };
const chip = (s) => '<span class="chip ' + STATES[s][1] + '">' + STATES[s][0] + '</span>';
// A verified item's stale mark from src/view/stale.js (#726): Core publishes verdictState and the page only draws it.
const staleChip = (${staleChip.toString()});
// A roadmap item's blocker dot and unfolded reason from src/view/roadmap-block.js (#605), read from the summaries held.
const roadmapBlock = (${roadmapBlock.toString()});
// Whether a list row reads held, and its chip, by the Roadmap header's rule, from src/view/held-items.js (#1256).
const heldNote = (${heldNote.toString()}), heldChip = (${heldChip.toString()});
const openPageDialog = (${openPageDialog.toString()}), closePageDialog = (${closePageDialog.toString()});
/** Parse the bounded reference syntax before requesting additional committed line windows. */
function codeReferenceParts(ref) {
  const match = /^(.+):(\\d+)(?:-(\\d+))?@([0-9a-f]{7,40})$/.exec(String(ref));
  if (!match) return null;
  const from = Number(match[2]);
  const to = Number(match[3] ?? match[2]);
  return Number.isSafeInteger(from) && Number.isSafeInteger(to) && from > 0 && to >= from
    ? { path: match[1], from, to, commit: match[4] } : null;
}
/**
 * Escape and color a source line using a small language-neutral set of common code tokens. A block comment or a
 * template string still open at the line's end is left in state.open, and the next line given the same state goes on
 * inside it, so a comment or a string spanning lines is colored on every one of them.
 */
function highlightCodeLine(line, path, state = {}) {
  const source = String(line);
  const extension = String(path).split('.').at(-1).toLowerCase();
  let output = '', i = 0;
  if (state.open) {
    let end = -1;
    if (state.open === 'comment') { const at = source.indexOf('*/'); end = at < 0 ? -1 : at + 2; }
    else for (let k = 0; k < source.length; k++) { if (source.charCodeAt(k) === 92) { k++; continue; } if (source.charCodeAt(k) === 96) { end = k + 1; break; } }
    const kind = state.open === 'comment' ? 'tok-comment' : 'tok-string';
    if (end < 0) return '<span class="' + kind + '">' + esc(source) + '</span>';
    output = '<span class="' + kind + '">' + esc(source.slice(0, end)) + '</span>';
    i = end;
    state.open = null;
  } else {
    // A preview may start inside a block comment, so a line that reads as one is all comment, and so is a whole-line
    // hash comment where the language has them: their apostrophes are words, not strings.
    const lead = source.trimStart();
    if (/^(?:\\*\\/|\\*(?:\\s|$))/.test(lead) || (['py', 'sh', 'yml', 'yaml', 'rb', 'toml'].includes(extension) && lead.startsWith('#'))) return '<span class="tok-comment">' + esc(source) + '</span>';
  }
  const keywords = new Set(['const', 'let', 'var', 'function', 'return', 'if', 'else', 'new', 'class', 'export', 'import', 'from', 'async', 'await', 'throw', 'try', 'catch', 'true', 'false', 'null', 'undefined']);
  while (i < source.length) {
    if (source.startsWith('//', i) || (extension === 'py' && source[i] === '#')) {
      output += '<span class="tok-comment">' + esc(source.slice(i)) + '</span>';
      break;
    }
    if (source.startsWith('/*', i)) {
      const at = source.indexOf('*/', i + 2), end = at < 0 ? source.length : at + 2;
      output += '<span class="tok-comment">' + esc(source.slice(i, end)) + '</span>';
      if (at < 0) state.open = 'comment';
      i = end;
      continue;
    }
    const char = source[i];
    if (char === '"' || char === "'" || char.charCodeAt(0) === 96) {
      let end = i + 1, closed = false;
      while (end < source.length) {
        if (source.charCodeAt(end) === 92) { end += 2; continue; }
        if (source[end++] === char) { closed = true; break; }
      }
      if (!closed && char.charCodeAt(0) === 96) state.open = 'template';
      output += '<span class="tok-string">' + esc(source.slice(i, end)) + '</span>';
      i = end;
      continue;
    }
    const wordStart = (char >= 'A' && char <= 'Z') || (char >= 'a' && char <= 'z') || char === '_' || char === '$';
    if (wordStart) {
      let end = i + 1;
      while (end < source.length && ((source[end] >= 'A' && source[end] <= 'Z') || (source[end] >= 'a' && source[end] <= 'z') || (source[end] >= '0' && source[end] <= '9') || source[end] === '_' || source[end] === '$')) end++;
      const word = source.slice(i, end);
      output += keywords.has(word) ? '<span class="tok-keyword">' + esc(word) + '</span>' : esc(word);
      i = end;
      continue;
    }
    if (char >= '0' && char <= '9') {
      let end = i + 1;
      while (end < source.length && ((source[end] >= '0' && source[end] <= '9') || source[end] === '.')) end++;
      output += '<span class="tok-number">' + esc(source.slice(i, end)) + '</span>';
      i = end;
      continue;
    }
    output += esc(char);
    i++;
  }
  return output;
}
// A shout or thread fact's path:lines@commit reference: keep only the reference in this button until
// the person opens it. The text before a shout ref is retained so ambiguous paths can be refused.
const codeRef = (ref, before, block = false, hashLength = 12, labelText = null) => {
  const c = view.code[view.root + '\\n' + before + '\\n' + ref];
  const open = Boolean(c && c.open);
  const shownLines = c?.all ? c.allLines : c?.lines, carry = {};
  const shown = !open ? '' : c.error ? '<span class="code no" role="status">' + esc(c.error) + '</span>' : !shownLines ? '<span class="code more">loading…</span>'
    : '<div class="code-wrap"><pre class="code">' + shownLines.map((line, n) => '<span><i>' + (c.from + n) + '</i>' + highlightCodeLine(line, c.path, carry) + '</span>').join('') + '</pre>'
      + (c.more && !c.all ? '<button class="code-control" data-code-all="' + esc(ref) + '"' + (before ? ' data-before="' + esc(before) + '"' : '') + ' type="button"' + (c.allLoading ? ' disabled' : '') + '>' + (c.allLoading ? 'loading all lines…' : 'show all lines') + '</button>' : '')
      + (c.all ? '<button class="code-control" data-code-less="' + esc(ref) + '"' + (before ? ' data-before="' + esc(before) + '"' : '') + ' type="button">show less</button>' : '')
      + '</div>';
  // Its label is one piece: the path, cut short first where the line is narrow, then the lines and the commit's first
  // twelve characters by default. The whole reference is on hover.
  const colon = ref.indexOf(':'), at = ref.lastIndexOf('@');
  const label = labelText === null ? '<span class="ref-path">' + esc(ref.slice(0, colon)) + '</span><span class="ref-at">' + esc(ref.slice(colon, at)) + '<span class="ref-sha">' + esc(ref.slice(at, at + 1 + hashLength)) + '</span></span>' : esc(labelText);
  const button = (asBlock) => '<button class="ref' + (asBlock ? ' block' : '') + '" data-code="' + esc(ref) + '"' + (before ? ' data-before="' + esc(before) + '"' : '') + ' title="' + esc(ref) + '" aria-label="Open code reference ' + esc(ref) + '" type="button" aria-expanded="' + open + '">' + label + '</button>';
  // A reference on a line of its own is a block, collapsed until asked: a caret, the path and lines, the short commit.
  // One inside a sentence keeps its label, so the prose reads on, and opens that same block below it.
  return block ? '<div class="code-ref' + (open ? ' open' : '') + '">' + button(true) + shown + '</div>'
    : button(false) + (open ? '<div class="code-ref open">' + button(true) + shown + '</div>' : '');
};
/** Format the API's structured fact binding as the live reference the code preview accepts. */
function factCodeRef(ref) {
  if (!ref || typeof ref !== 'object') return String(ref ?? '');
  const lines = ref.start === ref.end ? String(ref.start) : ref.start + '-' + ref.end;
  return ref.path + ':' + lines + '@' + ref.commit;
}
const tone = (s) => s === 'approved' ? 'ok' : s === 'pending' ? 'no' : s === 'draft' ? 'warn' : '';
/** Name the visible source category while keeping the full version and override detail in the title. */
const ruleSource = (row) => row.standardVersion != null && !row.overrides ? 'Standard' : 'This repo';
/** Keep the actual packaged version or repository override available on hover. */
const ruleSourceTitle = (row) => row.standardVersion != null ? 'Pullboard v' + row.standardVersion + (row.overrides ? row.status === 'wont' ? ', declined here' : ', overridden here' : '') : 'This repo';
// The same data-in, HTML-out renderer runs here and in the pure view tests.
const recordRow = (${recordRowHtml.toString()});
const count = (n, one, many = one) => n + ' ' + (n === 1 ? one : many);
// What needs the person in a project, as its Rulings list counts it: only the person's calls (B26),
// the decisions passed up to them, spec rows waiting for them, and held lanes, which only the main
// checkout, the person's seat, can set. Work waiting for a verdict or sent back belongs to the agents,
// and the line under the project says so without counting it.
const needCount = (x) => x.ok && !x.loading ? x.decisions + x.pending + x.drafts + x.holds : 0;
const doing = (x) => [x.decisions && count(x.decisions, 'decision', 'decisions'), x.pending && count(x.pending, 'question', 'questions'), x.drafts && count(x.drafts, 'draft row', 'draft rows'), x.holds && count(x.holds, 'lane held', 'lanes held'), x.sentBack && count(x.sentBack, 'sent back'), x.awaiting && count(x.awaiting, 'to verify'), x.building && count(x.building, 'building')].filter(Boolean).join(' · ') || (x.open ? count(x.open, 'item open', 'items open') : 'nothing open');
// Embed the standalone shared builder for every page; the binding also lets the page fixture substitute its output.
let personNeeds = (${personNeeds.toString()});
/** The person's calls in one repo, reused by a combined project view. */
function projectNeeds(p) {
  return personNeeds(p);
}
// The item lifecycle as pullboard declares it in src/machine.js, embedded when the page is served.
const FLOW = ${JSON.stringify(lifecycle()).replaceAll('<', '\\u003c')};
// These standalone native helpers retain one matcher in live timelines and snapshot replay.
const lifecycleEvent = (${lifecycleEvent.toString()});
const lifecycleMove = (${lifecycleMove.toString()});
const renderTimelineHtml = (${renderTimelineHtml.toString()});
const timelineBodyHtml = (${timelineBodyHtml.toString()});

/**
 * An item's history replayed through the lifecycle: each event with the state it found the item in
 * and the move it made, if it made one. The board logs a move under its verb, and a claim on a
 * claimed item as renew, but never the clock's lapse: an event that cannot start where the replay
 * stands, or an item that reads otherwise than where its history leaves it, means the clock moved
 * first, and the replay puts that lapse in, with no time of its own.
 */
const replayItem = (${replayItem.toString()});
const pipelineStage = (${pipelineStage.toString()});
const itemStagePresentation = (${itemStagePresentation.toString()});
const withdrawnFromStatus = (${withdrawnFromStatus.toString()});
const itemStageKey = (${itemStageKey.toString()});
const stageSentence = (${stageSentence.toString()});
const pipelineSince = (${pipelineSince.toString()});
const itemListFields = (${itemListFields.toString()});
/** Bind the current lifecycle declaration at the page adapter boundary. */
function replay(item) { return replayItem(item, FLOW, lifecycleMove); }
/** Keep summary payloads and full snapshot projections on the same pure list path. */
function listFields(item, fresh = false) { return itemListFields(item, FLOW, { fresh, match: lifecycleMove }); }

/** Resolve a builder from the full item's owner or the live claim in an API summary. */
const holderOf = (item) => item.status === 'claimed' ? item.claim?.by ?? item.owner ?? null : null;
/** Resolve a reviewer from the full item or the live claim in an API summary. */
const reviewerOf = (item) => item.status === 'submitted' ? item.claim?.by ?? item.reviewer ?? null : null;

const pipelineHtml = (${pipelineHtml.toString()});
/** Resolve live navigation and clock presentation before calling the pure renderer. */
function pipelineCard(items) {
  return pipelineHtml(items.map(item => {
    const fields = listFields(item);
    const landing = (data.project?.landingBatches || []).find(batch => (batch.items || []).some(entry => entry.id === item.id));
    const gated = Boolean(item.blockedBy?.length || heldNote(item, data.project, undefined, Date.now()));
    const stage = itemStagePresentation(fields, { gated, landingBatchAt: landing ? when(landing.startedAt) : null,
      withdrawnFrom: item.withdrawnFrom || withdrawnFromStatus(fields), gateDetail: item.withdrawnReason || '' });
    return { ...fields, ...stage, stageKey: itemStageKey(stage.stage), stageHtml: stageMarkup(item, data.project, gated, item.withdrawnReason || '', itemStageMarks(item, data.project)), href: itemAddress(item.id), ageHtml: age(fields.since) };
  }), { selectedId: view.item });
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
function timeline(item, { newestFirst = false } = {}) {
  const fromThread = Array.isArray(item.thread) && item.thread.length > 0;
  const recorded = fromThread
    ? item.thread
    : item.history.filter((entry) => entry.kind !== 'fact').map((entry, eventId) => ({ type: 'move', eventId: eventId + 1, ...entry }));
  // Bookkeeping records are not states or findings: usage, rule-based milestone placement, and the
  // verifier's background review-comparison receipts stay out of the person's history.
  const bookkeeping = (entry) => ['usage', 'shared-usage', 'milestone_placed'].includes(entry.kind)
    || (entry.type === 'fact' && String(entry.text ?? '').startsWith('Review comparison: '));
  const entries = recorded.filter((entry) => !bookkeeping(entry));
  // A placement keeps its event identity with the row of the event before it, so every API event is still found once [B33,B29].
  const folded = recorded.flatMap((entry, at) => entry.kind === 'milestone_placed' ? [{ eventId: entry.eventId, after: recorded.slice(0, at).findLast((before) => !bookkeeping(before))?.eventId ?? null }] : []);
  // Native thread moves keep their event detail nested; project it through the shared lifecycle adapter
  // before replay so retained refreezes and other declared event facts match the API history projection.
  const replayEntries = entries.map((entry) => entry.type === 'move' && fromThread
    ? { ...entry, ...lifecycleEvent({ event_kind: entry.kind, event_by: entry.by, event_at: entry.at,
      event_detail: JSON.stringify(entry.detail ?? {}) }) }
    : entry);
  const moves = replayEntries.filter((entry) => entry.type === 'move');
  const steps = replay({ ...item, history: moves });
  /** Resolve model metadata from this board without appending it to the seat address. */
  const modelFor = by => {
    const agent = data?.project?.agents?.find(row => row.agent_id === by);
    const model = agent?.model || agent?.agent_model;
    return model && String(model).toLowerCase() !== 'unknown' ? (privateCost ? modelPresentation(model, agent.family).name : model) : '';
  };
  const presentedEntries = replayEntries.map((entry) => entry.type === 'fact'
    ? { ...entry, text: findingWords({ why: entry.text }, true).text, kindLabel: eventWords(entry.kind), timeLabel: when(entry.at), ageHtml: age(entry.at), model: modelFor(entry.by),
      bodyHtml: timelineBodyHtml(entry.text, { itemHref: itemAddress, codeLink: ref => codeRef(ref, '', false, 12), timeLabel: when, commit: item.commit || item.head || '',
        refusalTitles: { ONE_CLAIM: 'An agent can hold only one building claim at a time.' } }),
      hasCodeRef: Boolean(entry.ref), codeHtml: entry.ref ? codeRef(factCodeRef(entry.ref), '', false, 12) : '' }
    : entry);
  const presentedSteps = steps.map((step) => ({ ...step, kindLabel: eventWords(step.kind), momentLabel: eventMoment(step.kind), timeLabel: step.at ? when(step.at) : '',
    ageHtml: step.at ? age(step.at) : '', model: modelFor(step.by) }));
  return renderTimelineHtml({ entries: presentedEntries, steps: presentedSteps, flow: FLOW, folded,
    open: view.timelineOpen?.get(JSON.stringify([view.root, item.id])) || [], newestFirst });
}

/**
 * The lifecycle drawn as SVG with this board's counts, the way the README's figure draws it. The
 * longest way from the start to a final state runs along a row, the first-declared final winning a
 * tie, its states joined by straight arrows. A pair of states a move leads back along takes a dashed
 * square route above the row, the further back the higher. Forward shortcuts use separate lanes
 * below the row, leaving return labels above it. The moves that keep a state are written
 * in its box after a ↻. A state off the row sits below the last state on the row that leads to it,
 * and routes into it from the row join into one, labelled once. Moves out of those states take
 * separate routes below the boxes, with their words above each route. Final states have a double border. Boxes
 * count the items there now; labels count the moves made along each route, or name its moves when
 * none was. Words are wrapped and placed by a generous estimate of their width, so none overlaps.
 */
const lifecycleDiagramHtml = (${lifecycleDiagramHtml.toString()});
/** Select the actual board counts before drawing the pure declaration diagram. */
function flowSvg(p) {
  const counts = p.moveCounts ? new Map(Object.entries(p.moveCounts)) : moveCounts(p.items);
  return lifecycleDiagramHtml(p, FLOW, counts);
}

/** Read or move through API v1, retaining the rule and repair guidance in a refusal. */
async function api(path, body) {
  path = snapshot ? path.split('?')[0].slice(1) + '.json' : path;
  if (snapshot) {
    if (body !== undefined && body !== null) throw new Error('This is a read-only snapshot.');
    return jsonRequest(path, undefined, '', {});
  }
  if (path === '/api/v1/boards') return starLine(await listedBoards());
  const boardId = /^\\/api\\/v1\\/boards\\/([0-9a-f]{32})(?:\\/|$)/u.exec(path)?.[1];
  const source = boardId ? boardSources.get(boardId) : null;
  if (boardId && !source) throw new Error(transport
    ? 'Pair this browser to read that board, or refresh the board list if the board is local.'
    : 'This board is not available in the current view. Refresh the board list and retry.');
  if (boardId && source?.kind === 'relay') {
    if (body !== undefined && body !== null) throw new Error('This is a read-only view of relay boards.');
    if (!transport) throw transportLoadError || new Error('The relay transport is still loading.');
    const reply = await transport.request(path, body);
    if (path.includes('/state') && reply.state) return { ...reply, state: { ...reply.state, root: source.board.root } };
    return reply;
  }
  if (body && (hosted.local ? readOnly && source?.kind !== 'local' : pageReadOnly)) throw new Error('This is a read-only view.');
  const base = source?.kind === 'local' ? localReadBase : connection.base;
  const headers = source?.kind === 'local' ? localReadHeaders : connection.headers;
  const reply = await jsonRequest(path, body, base, headers); if (boardId && source?.kind === 'local' && path.includes('/state') && reply?.state) return { ...reply, state: { ...reply.state, root: source.board.root } }; return reply;
}

// Transport-only report identities never become public state fields or persisted browser data.
const reportValidators = new WeakMap();

/** Use one JSON request primitive, capturing its local route and session before awaiting a reply. */
async function jsonRequest(path, body, base, headers, cache, format = 'json') {
  const session = localSession;
  path = base + path;
  const res = await fetch(path, { method: body ? 'POST' : 'GET', headers: { ...headers, ...(body ? { 'content-type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined, cache });
  const json = format === 'html' && res.ok ? await res.text() : await res.json();
  if (session && session === localSession && base === session.origin) {
    if (res.status === 401 || res.status === 403) localExpired();
    else if (res.ok && !localConfirmed) { localConfirmed = true; tabValue(LOCAL_TRIPS, null); }
  }
  if (!res.ok) {
    const refusal = json.error;
    const message = refusal && typeof refusal === 'object' ? '[' + refusal.code + '] ' + refusal.message : refusal || res.status;
    const error = new Error(message);
    if (refusal && typeof refusal === 'object') error.code = refusal.code;
    throw error;
  }
  const report = json?.state?.proofStats?.flow?.report ?? json?.delta?.replace?.proofStats?.flow?.report;
  const reportValidator = res.headers.get('x-pullboard-report-validator');
  if (report && typeof report === 'object' && /^[a-f0-9]{64}:[0-9]+$/.test(reportValidator ?? '')) reportValidators.set(report, reportValidator);
  return json;
}

// The list is only a preview: the local view checks the registry again after this one confirmation.
document.addEventListener('click', async (event) => {
  const button = event.target.closest('[data-forget-unreadable]');
  if (!button || snapshot || pageReadOnly) return;
  const root = button.dataset.forgetUnreadable || null;
  if (!confirm(root ? 'Forget this board if it is still unreadable? A recovered board will be kept.' : 'Forget the boards that are unreadable now? Boards recovered since this list was shown will be kept.')) return;
  button.disabled = true;
  try {
    const base = hosted.local ? localReadBase : connection.base;
    const headers = hosted.local ? localReadHeaders : connection.headers;
    const body = { confirm: true };
    if (root) {
      const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(root));
      body.board = Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
    }
    const result = await jsonRequest('/api/v1/projects/forget-unreadable', body, base, headers);
    await refresh();
    $('live').textContent = result.forgotten
      ? 'Forgot ' + result.forgotten + ' unreadable ' + (result.forgotten === 1 ? 'board.' : 'boards.')
      : 'No unreadable boards needed forgetting.';
  } catch (error) {
    $('live').textContent = String(error.message || error);
    button.disabled = false;
  }
});

/** Read only this machine's authenticated view, including when its page is hosted elsewhere. */
function sharingApi(body) {
  return jsonRequest('/api/v1/view-link', body, hosted.local ? localReadBase : connection.base,
    hosted.local ? localReadHeaders : connection.headers);
}

let sharingReady = null;
let sharingTask = Promise.resolve();
let sharing = { state: 'idle', intentId: null, popup: null, timer: null, closing: false, boards: [] };

${sharingPresentation()}/** Stop the one operation and await core cleanup; a linking batch is never described as rolled back. */
async function closeSharing() {
  clearTimeout(sharing.timer);
  sharing.closing = true;
  if (!sharing.intentId) return;
  try {
    const status = await sharingApi({ action: 'cancel', intentId: sharing.intentId });
    sharingProgress(status);
    sharing.popup?.close(); sharing.popup = null;
    $('share-start').disabled = false;
    sharingReady = sharingInvitation();
  } catch (error) {
    $('share-status').textContent = error.message;
    if (error.code === 'VIEW_SIGN_IN_LINKING') {
      sharing.closing = false;
      sharing.timer = setTimeout(() => { sharingTask = pollSharing(); }, 250);
    } else { sharing.popup?.close(); sharing.popup = null; $('share-start').disabled = false; }
  }
}

/** Poll public progress only while the person has an active sign-in or pairing step. */
async function pollSharing() {
  if (sharing.closing) return;
  if (sharing.state === 'waiting' && sharing.popup?.closed) { sharingTask = closeSharing(); return sharingTask; }
  try {
    const status = await sharingApi({ action: 'status', intentId: sharing.intentId });
    sharingProgress(status);
    if (['waiting', 'linking', 'pairing'].includes(status.state)) sharing.timer = setTimeout(() => { sharingTask = pollSharing(); }, 250);
    else { $('share-start').disabled = false; sharingReady = sharingInvitation(); }
  } catch (error) {
    $('share-status').textContent = error.message;
    $('share-start').disabled = false;
  }
}

/** Begin one existing all-board sign-in; open its browser window in the native click before awaiting the server. */
async function beginSharing(popup) {
  sharing = { state: 'waiting', intentId: null, popup, timer: null, closing: false, boards: [] };
  $('share-panel').hidden = false;
  $('share-start').disabled = true;
  $('share-status').textContent = 'Starting GitHub sign-in…';
  try {
    const instructions = await sharingApi({ action: 'start' });
    sharing.intentId = instructions.intentId;
    if (sharing.closing || popup?.closed) return await closeSharing();
    $('share-status').textContent = 'Enter ' + instructions.userCode + ' in the GitHub window. Closing this sign-in before linking leaves every board local.';
    popup.location.replace(instructions.verificationURL);
    sharing.timer = setTimeout(() => { sharingTask = pollSharing(); }, 250);
  } catch (error) {
    popup?.close();
    $('share-status').textContent = error.message;
    $('share-start').disabled = false;
  }
}

/** Open only core's transient device navigation in a separately authenticated HTML response, never a JSON URL. */
async function pairSharing(popup) {
  const base = hosted.local ? localReadBase : connection.base;
  const headers = hosted.local ? localReadHeaders : connection.headers;
  try {
    const html = await jsonRequest('/api/v1/view-link', { action: 'pairing', intentId: sharing.intentId }, base, headers, undefined, 'html');
    const destination = new DOMParser().parseFromString(html, 'text/html').querySelector('a')?.getAttribute('href');
    if (!destination) throw new Error('Phone pairing is no longer waiting. Read the sign-in status and start again if needed.');
    popup.location.replace(destination);
  } catch (error) { popup?.close(); $('share-status').textContent = error.message; }
}

$('share-start')?.addEventListener('click', () => {
  const popup = window.open('about:blank', '_blank');
  if (!popup) { $('share-panel').hidden = false; $('share-status').textContent = 'Allow this view to open the GitHub sign-in window, then try again.'; return; }
  popup.opener = null;
  sharingTask = beginSharing(popup);
});
$('share-close')?.addEventListener('click', () => { sharingTask = closeSharing(); });
$('share-pair')?.addEventListener('click', () => {
  const popup = window.open('about:blank', '_blank');
  if (!popup) { $('share-status').textContent = 'Allow this view to open the device-pairing window, then try again.'; return; }
  popup.opener = null;
  sharingTask = pairSharing(popup);
});

let relayEngine = null;
/** The account's linked boards: a same-origin read that declares the relay's engine, as every relay request does. */
// The account's last read and when it ended, answered or refused, for the star line, which reuses it rather than
// asking again (#817): a refusal is an answer too, "not linked", and is not asked again straight away.
let linkedSeen = null;
async function linkedList() {
  relayEngine ??= await import('/relay/engine.js').then((engine) => String(engine.ENGINE_VERSION), () => '');
  try {
    const reply = await jsonRequest('/api/v1/boards', undefined, '', relayEngine ? { 'x-pullboard-engine': relayEngine } : {}, 'no-store');
    linkedSeen = { at: Date.now(), reply };
    return reply;
  } catch (error) {
    linkedSeen = { at: Date.now(), reply: null };
    throw error;
  }
}

/**
 * Whether the signed-in person's linked boards name one this machine's list lacks: only then does the page need the
 * decrypting relay client. The metadata is a same-origin cookie-authenticated read, with none of this machine's local
 * credential.
 */
async function linkedBoardMissing(localIds) {
  const linked = await linkedList();
  return Boolean(linked.boards?.some(board => typeof board.id === 'string' && /^[0-9a-f]{32}$/.test(board.id) && typeof board.repository === 'string' && !localIds.has(board.id)));
}

/** Read this machine's API list and the signed-in relay list, preferring a local registration with the same id. */
async function listedBoards() {
  let local = { boards: [], warnings: [] };
  let relay = { boards: [], warnings: [] };
  const hasLocal = hosted.local ? Boolean(localReadBase) && Boolean(localSession) : transportModule === null;
  if (hasLocal) {
    try {
      local = await jsonRequest('/api/v1/boards', undefined, localReadBase, localReadHeaders, 'no-store');
    } catch (error) {
      // A local read that fails once, as while the view restarts, is no reason to load the relay client for a
      // person whose linked boards are all on this machine or who has none (#748).
      if (!transport && hosted.relaySession && configuredTransportModule) {
        try { if (await linkedBoardMissing(new Set())) await loadTransport(); } catch { /* Keep the local refusal when neither source can be read. */ }
      }
      if (!transport) throw error;
      localNote('local-failed', { detail: String(error.message || error) });
    }
  }
  if (hosted.local && hasLocal && hosted.relaySession && configuredTransportModule && !transport) {
    try {
      if (await linkedBoardMissing(new Set((local.boards || []).map(board => board.id)))) await loadTransport();
    } catch (error) { localNote('linked-failed', { detail: String(error.message || error) }); }
  }
  if (!hasLocal && transportModule && !transport) throw transportLoadError || new Error('The browser transport is still loading.');
  if (transport) {
    try { relay = await transport.request('/api/v1/boards'); }
    catch (error) {
      if (!hosted.local || !hasLocal) throw error;
      localNote('linked-failed', { detail: String(error.message || error) });
    }
  }
  boardSources.clear();
  localBoardIds.clear();
  const boards = [];
  for (const board of local.boards || []) {
    if (typeof board.id !== 'string') continue;
    const row = { ...board, source: 'local' };
    boardSources.set(row.id, { kind: 'local', board: row });
    localBoardIds.add(row.id);
    boards.push(row);
  }
  for (const board of relay.boards || []) {
    if (typeof board.id !== 'string' || boardSources.has(board.id)) continue;
    // A linked board reads by its own name, as it does locally, with its owner as a quiet prefix.
    const [owner, name] = String(board.name || '').includes('/') ? board.name.split('/') : ['', board.name];
    const row = { ...board, root: board.id, source: 'relay', name, owner };
    boardSources.set(row.id, { kind: 'relay', board: row });
    boards.push(row);
  }
  if (hosted.local) await hostedListed(boards);
  return { version: 1, boards, warnings: [...(local.warnings || []), ...(relay.warnings || [])] };
}

/** After a hosted board list: a list clears a state it stood in for, and a signed-in empty one says why it is empty. */
async function hostedListed(boards) {
  let shown = $('local-note').dataset.state || '';
  // A list that arrives after a failed read, once this computer's view answered, means the page recovered: the problem
  // it showed is over, and this list decides what shows now.
  if (shown === 'problem' && localReached) { localNote(null); shown = ''; }
  if (boards.length && !hosted.relaySession && pageStartup(document.documentElement).pairedBefore()) { localNote('signed-out-paired'); return; }
  if (boards.length) {
    if (localNavigationOnly) localNote('local-open', { listed: true });
    else if (['looking', 'not-running', 'no-linked', 'unpaired', 'signed-out'].includes(shown)) localNote(null);
    return;
  }
  // Nobody signed in and no board on this computer yet: the page says how to make one, as the local view does.
  if (!hosted.relaySession) { if (shown === 'looking') localNote(null); return; }
  // An empty local view can still leave linked boards on another computer waiting for this browser to pair.
  if (!['', 'looking', 'not-running', 'no-linked', 'unpaired', 'local-open'].includes(shown)) return;
  let linked;
  try { linked = await linkedList(); } catch { return; /* the relay's banner says why */ }
  const names = (linked.boards || []).filter((board) => typeof board.repository === 'string').map((board) => board.repository);
  localNote(names.length ? 'unpaired' : 'no-linked', { linked: names });
}

/** Set presentation controls for the selected board; API routing still checks the target board independently. */
`;
}
