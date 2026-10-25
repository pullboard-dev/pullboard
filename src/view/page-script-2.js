import {
  heldChip,
  heldNote,
} from './held-items.js';
/**
 * Part 2 of the hosted page's script, verbatim from src/cockpit.js lines 332-1298 (#745): its
 * text is what the page served before the split, with the values its ${} expressions read passed in as scope.
 *
 * @param {Record<string, any>} scope - The values cockpitPage passes for the names this part interpolates.
 * @returns {string} The script text of this part.
 */
export function pageScriptPart2(scope) {
  const { STAR_KEY, closePageDialog, connection, drawHosted, homeRules, hostedBrowser, hostedReleaseDistance, hostedReleaseNote, hostedState, lifecycle, openPageDialog, personNeeds, releaseHosted, releaseInfo, roadmapBlock, roadmapHeaders, roadmapSummary, sharingPresentation, staleChip, transportModule } = scope;
return `let detailRead = null;
const addressedShouts = new Map();
const $ = (id) => document.getElementById(id);
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
  for (const button of [$('theme'), $('ob-theme')]) {
    button.title = now === 'dark' ? 'Dark theme: switch to light' : 'Light theme: switch to dark';
    button.setAttribute('aria-label', button.title);
  }
}
theme(keep('pb.theme'));
matchMedia('(prefers-color-scheme: dark)').addEventListener?.('change', () => theme(keep('pb.theme')));
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
// Inline code: a short chip stays whole on its line; one wider than a phone line's worth may wrap. Width
// is in columns, as a terminal counts them: CJK, full-width and emoji characters take two.
const wideChar = (c) => { const p = c.codePointAt(0); return (p >= 0x1100 && p <= 0x115f) || (p >= 0x2e80 && p <= 0xa4cf) || (p >= 0xac00 && p <= 0xd7a3) || (p >= 0xf900 && p <= 0xfaff) || (p >= 0xfe30 && p <= 0xfe4f) || (p >= 0xff00 && p <= 0xff60) || (p >= 0xffe0 && p <= 0xffe6) || (p >= 0x1f300 && p <= 0x1faff) || (p >= 0x20000 && p <= 0x3fffd); };
const columns = (text) => [...String(text)].reduce((n, c) => n + (wideChar(c) ? 2 : 1), 0);
const codeChip = (text, kind = '') => kind === 'sha' && String(text).length > 10
  ? '<code class="inline sha" title="' + esc(text) + '">' + esc(String(text).slice(0, 10)) + '</code>'
  : '<code class="inline' + (kind ? ' ' + kind : '') + (columns(text) > 24 ? ' long" title="' + esc(text) : '') + '">' + esc(text) + '</code>';
// An age said in words, as a shout's card shows it: now, 2m ago, 1h ago.
const agoLong = (iso) => { const short = ago(iso); return short === 'now' ? 'now' : short + ' ago'; };
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
/** Omit a duplicated leading verdict code from rendered copy while preserving the recorded note. */
function visibleVerdictNote(reason, note) {
  const text = String(note ?? '');
  const code = String(reason ?? '');
  const remainder = text.slice(code.length);
  return code && text.startsWith(code) && (!remainder || /^\\s/u.test(remainder)) ? remainder.trimStart() : text;
}
// The latest verdict is a reject and no accept followed: open again, being reworked, resubmitted, or
// withdrawn after it.
const rejected = (i) => i.status !== 'verified' && !!i.verdict && i.verdict.decision === 'REJECT';
/** Resolve visible agent text from this board's API without changing action identities. */
function agentName(id, project = data?.project) {
  const agent = project?.agents?.find((entry) => entry.agent_id === id);
  return agent?.displayName || (agent ? id + ' (' + (agent.model || agent.agent_model || 'unknown') + ')' : id);
}
/** Keep a shout address whole while its model can shorten, retaining the API name for assistive readers. */
function shoutAgentName(id) {
  const name = agentName(id);
  if (name === id) return esc(id);
  const prefix = name.endsWith('-' + id);
  const model = prefix ? name.slice(0, -id.length) : name.slice(id.length);
  const address = '<span class="agent-id">' + esc(id) + '</span>';
  const label = '<span class="agent-model">' + esc(model) + '</span>';
  return '<span class="agent-label' + (prefix ? ' prefix' : '') + '" title="' + esc(name) + '" role="group" aria-label="' + esc(name) + '">' + (prefix ? label + address : address + label) + '</span>';
}
/** Render a review note with escaped text and references bound to the selected board. */
const verdictHtml = (v, titles) => '<div class="verdict ' + (v.decision === 'ACCEPT' ? 'yes' : 'no') + '"><b>' + esc(v.decision) + ' ' + esc(v.reason) + '</b><span class="by">' + esc(agentName(v.by)) + ' · ' + when(v.at) + ' · at ' + esc(String(v.commit || '').slice(0, 12)) + '</span><div class="note">' + inline(visibleVerdictNote(v.reason, v.note), titles) + '</div></div>';
const homeRules = (${homeRules.toString()});
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
const codeRef = (ref, before, block = false) => {
  const c = view.code[view.root + '\\n' + before + '\\n' + ref];
  const open = Boolean(c && c.open);
  const shownLines = c?.all ? c.allLines : c?.lines, carry = {};
  const shown = !open ? '' : c.error ? '<span class="code no" role="status">' + esc(c.error) + '</span>' : !shownLines ? '<span class="code more">loading…</span>'
    : '<div class="code-wrap"><pre class="code">' + shownLines.map((line, n) => '<span><i>' + (c.from + n) + '</i>' + highlightCodeLine(line, c.path, carry) + '</span>').join('') + '</pre>'
      + (c.more && !c.all ? '<button class="code-control" data-code-all="' + esc(ref) + '"' + (before ? ' data-before="' + esc(before) + '"' : '') + ' type="button"' + (c.allLoading ? ' disabled' : '') + '>' + (c.allLoading ? 'loading all lines…' : 'show all lines') + '</button>' : '')
      + (c.all ? '<button class="code-control" data-code-less="' + esc(ref) + '"' + (before ? ' data-before="' + esc(before) + '"' : '') + ' type="button">show less</button>' : '')
      + '</div>';
  // Its label is one piece: the path, cut short first where the line is narrow, then the lines and the commit's first
  // ten characters; the whole reference is on hover.
  const colon = ref.indexOf(':'), at = ref.lastIndexOf('@');
  const label = '<span class="ref-path">' + esc(ref.slice(0, colon)) + '</span><span class="ref-at">' + esc(ref.slice(colon, at)) + '<span class="ref-sha">' + esc(ref.slice(at, at + 11)) + '</span></span>';
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
/** Name a rule's actual packaged version or its repository source, including explicit overrides. */
const ruleSource = (row) => row.standardVersion != null ? 'Pullboard v' + row.standardVersion + (row.overrides ? row.status === 'wont' ? ', declined here' : ', overridden here' : '') : 'this repo';
/** Keep the full source label available when a narrow row clips it. */
const ruleSourceTitle = (row) => ruleSource(row);
/** Render the two-line record shared by Items, Spec and Doctrine, with one grid and type hierarchy. */
function recordRow({ tag = 'li', classes = '', attributes, title, state, primary, secondary, rightTop = '', rightBottom = '' }) {
  return '<' + tag + ' class="' + (tag === 'div' ? 'srow ' : '') + 'row s-' + state + (classes ? ' ' + classes.trim() : '') + '" ' + attributes + ' title="' + esc(title) + '"><span class="dot ' + state + '"></span><div><div class="t srow-text">' + primary + '</div>' + (rightTop ? '<span class="row-age">' + rightTop + '</span>' : '') + '<div class="meta">' + secondary + '</div></div>' + rightBottom + '</' + tag + '>';
}
const count = (n, one, many = one) => n + ' ' + (n === 1 ? one : many);
// What needs the person in a project, as its Needs-you list counts it: only the person's calls (B26),
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

/** A recorded merge, rather than an accept, is the end of the shipping pipeline. */
function pipelineStage(item) {
  if (item.stage !== undefined) return item.stage;
  if (item.merged) return 'merged';
  return item.status === 'verified' ? 'accepted' : item.status;
}

/** The last arrival in this stage; edits, review reservations and renewals do not restart its age. */
function pipelineSince(item) {
  if (item.since !== undefined) return item.since;
  if (item.merged) return item.history.findLast((event) => event.kind === 'merged')?.at || item.updatedAt;
  const arrival = replay(item).findLast((step) => step.move && step.from !== step.move.to);
  // Lapses are inferred, but the native claim receipt records the deadline that caused them.
  if (arrival?.move?.verb === 'lapse') {
    const claim = item.thread?.findLast((entry) => entry.type === 'move' && ['claim', 'renew'].includes(entry.kind));
    if (claim?.detail?.leaseUntil) return claim.detail.leaseUntil;
  }
  return arrival ? arrival.at || item.updatedAt : item.history.find((event) => event.kind === 'add')?.at || item.updatedAt;
}

/** Add the list and pipeline fields omitted from full snapshots, while leaving API summaries intact. */
function listFields(item, fresh = false) {
  if (!fresh && item.stage !== undefined) return item;
  const claim = item.status === 'claimed' && item.owner ? { by: item.owner, until: null }
    : item.status === 'submitted' && item.reviewer ? { by: item.reviewer, until: item.reviewUntil ?? null } : null;
  return { ...item, stage: pipelineStage(item), since: pipelineSince(item), claim,
    counts: { verdicts: item.verdicts.length, facts: (item.thread || []).filter((entry) => entry.type === 'fact').length } };
}

/** Resolve a builder from the full item's owner or the live claim in an API summary. */
const holderOf = (item) => item.status === 'claimed' ? item.claim?.by ?? item.owner ?? null : null;
/** Resolve a reviewer from the full item or the live claim in an API summary. */
const reviewerOf = (item) => item.status === 'submitted' ? item.claim?.by ?? item.reviewer ?? null : null;

/** Render the same board's items in lifecycle order, retaining every item as a detail link. */
function pipelineCard(items) {
  const stages = [['open', 'Not started'], ['claimed', 'Building'], ['submitted', 'Waiting for review'], ['accepted', 'Accepted, waiting to merge'], ['merged', 'Merged']];
  return stages.map(([stage, label]) => {
    const rows = items.map((item) => listFields(item)).filter((item) => item.stage === stage).sort((a, b) => a.since.localeCompare(b.since) || a.id - b.id);
    const oldest = rows[0];
    return '<li class="card-panel pipeline-stage" data-pipeline-stage="' + stage + '"><header><h2>' + label + '</h2><b data-stage-count="' + stage + '">' + rows.length + '</b></header>'
      + (oldest ? '<p class="pipeline-oldest">Oldest <a class="ref" href="' + esc(itemAddress(oldest.id)) + '" data-go="item:' + oldest.id + '">#' + oldest.id + '</a> · ' + age(oldest.since) + ' in this stage</p>' : '<p class="pipeline-oldest">No items</p>')
      + '<ul>' + rows.map((item) => '<li><button class="pipeline-item' + (view.item === item.id ? ' on' : '') + '" type="button" data-item="' + item.id + '"><span>#' + item.id + '</span><span>' + esc(item.title) + '</span></button></li>').join('') + '</ul></li>';
  }).join('');
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
    const stay = !enters || (final && !next) ? ''
      : !s.at ? esc(named + (next ? ' after the ' : ' so far since the ') + s.kind + ', length not logged')
      : !next ? esc(named) + ' for ' + age(s.at) + ' so far'
      : !next.at ? esc(named + ' until the ' + next.kind + ', length not logged')
      : esc(named + ' for ' + span(Date.parse(next.at) - Date.parse(s.at)));
    rows.push('<li class="tl-' + esc(state) + (s.kind === 'reject' ? ' tl-back' : '') + (enters ? '' : ' tl-quiet') + '"' + (event ? ' data-event-id="' + event.eventId + '"' : '') + '><time>' + (s.at ? when(s.at) : '') + '</time><span><b>' + esc(s.kind) + '</b> ' + esc(agentName(s.by)) + '</span>' + (stay ? '<small>' + stay + '</small>' : '') + '</li>');
  };
  /** Render one API fact with its identity, replacement and committed code binding. */
  const factRow = (fact) => {
    const replacement = replacements.get(fact.id);
    const judgement = ['decision', 'rejection', 'supersession', 'root-cause'].includes(fact.kind);
    rows.push('<li id="fact-' + esc(fact.id) + '" class="tl-fact' + (judgement ? ' tl-judgement' : '') + (replacement ? ' tl-superseded' : '') + '" data-event-id="' + fact.eventId + '"><time>' + when(fact.at) + '</time><span class="tl-fact-head"><span class="chip">' + esc(fact.kind) + '</span> <b>' + esc(agentName(fact.by)) + '</b></span><span class="tl-body">' + esc(fact.text) + '</span><small>' + age(fact.at) + (replacement ? ' · <a class="thread-replacement" href="#fact-' + esc(replacement.id) + '">replaced by ' + esc(replacement.kind) + '</a>' : '') + '</small>' + (fact.ref ? '<div class="tl-code">' + codeRef(factCodeRef(fact.ref), '') + '</div>' : '') + '</li>');
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
 * square route above the row, the further back the higher. Forward shortcuts use separate lanes
 * below the row, leaving return labels above it. The moves that keep a state are written
 * in its box after a ↻. A state off the row sits below the last state on the row that leads to it,
 * and routes into it from the row join into one, labelled once. Moves out of those states take
 * separate routes below the boxes, with their words above each route. Final states have a double border. Boxes
 * count the items there now; labels count the moves made along each route, or name its moves when
 * none was. Words are wrapped and placed by a generous estimate of their width, so none overlaps.
 */
function flowSvg(p) {
  // Summary states include board-wide tallies, so the lifecycle drawing needs no per-item histories.
  const counts = p.moveCounts ? new Map(Object.entries(p.moveCounts)) : moveCounts(p.items);
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
    // A wrapped line opens with the dot it was split at, so the moves still read as one list (#954).
    const kept = said ? wrap(said.words, BW - 28 - wide('↻ ', 11), 11).map((line, i) => (i ? '· ' : '↻ ') + line) : [];
    return [s.id, { keeps, said, kept, back: s.id === FLOW.initial && back ? back + ' sent back' : '' }];
  }));
  const BH = 44 + 15 * Math.max(1, ...[...inside.values()].map((box) => box.kept.length + (box.back ? 1 : 0)));

  // Routes back along the row, each at a level by how far back it goes; their words above them.
  const ups = pairs.filter((pair) => col(pair.to) >= 0 && col(pair.from) > col(pair.to))
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
  // Higher routes cross this level vertically; put its words in the widest gap between them.
  for (const up of ups) {
    const left = Math.min(up.start, up.end), right = Math.max(up.start, up.end);
    const cuts = [left, ...ups.filter((other) => other.span > up.span).flatMap((other) => [other.start, other.end]).filter((x) => x > left && x < right), right].sort((a, b) => a - b);
    const rooms = cuts.slice(1).map((end, index) => ({ left: cuts[index], right: end })).sort((a, b) => (b.right - b.left) - (a.right - a.left));
    const room = rooms[0];
    up.labelX = (room.left + room.right) / 2;
    up.lines = wrap(up.said.words, room.right - room.left - 20, 12);
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

  // A forward shortcut gets its own lower lane. Keep its words between the vertical stems of
  // deeper shortcuts and routes into off-row states, rather than at a fixed diagram coordinate.
  const shortcuts = pairs.filter((pair) => col(pair.from) >= 0 && col(pair.to) > col(pair.from) + 1)
    .map((pair) => ({ pair, span: col(pair.to) - col(pair.from),
      start: pos.get(pair.from).x + BW / 2 - 40, end: pos.get(pair.to).x - BW / 2 + 40 }))
    .sort((a, b) => a.span - b.span);
  const downwardStems = pairs.filter((pair) => col(pair.from) >= 0 && col(pair.to) < 0)
    .map((pair) => pos.get(pair.from).x);
  shortcuts.forEach((shortcut, index) => {
    const cuts = [shortcut.start, ...downwardStems,
      ...shortcuts.slice(index + 1).flatMap((other) => [other.start, other.end]), shortcut.end]
      .filter((x) => x >= shortcut.start && x <= shortcut.end).sort((a, b) => a - b);
    const rooms = cuts.slice(1).map((right, i) => ({ left: cuts[i], right }))
      .sort((a, b) => (b.right - b.left) - (a.right - a.left));
    const room = rooms[0];
    shortcut.said = told([shortcut.pair]);
    shortcut.lines = wrap(shortcut.said.words, room.right - room.left - 20, 12);
    shortcut.labelX = (room.left + room.right) / 2;
    shortcut.depth = (index ? shortcuts[index - 1].depth + 24 : 30) + 15 * (shortcut.lines.length - 1);
  });
  const shortcutDepth = shortcuts.length ? shortcuts[shortcuts.length - 1].depth : 0;
  // A straight incoming route labels the midpoint of this gap: its words must also sit below
  // every shortcut, not just place the off-row boxes below them.
  const lowerGap = Math.max(80, 2 * shortcutDepth + 32);

  // A state off the row sits below the last state on it that leads there.
  const below = FLOW.states.filter((s) => !pos.has(s.id));
  for (const s of below) {
    const from = row.filter((r) => leads(r).includes(s.id));
    pos.set(s.id, { x: from.length ? pos.get(from[from.length - 1]).x : W / 2, y: bottom + lowerGap + BH / 2 });
  }
  const outgoing = pairs.filter((pair) => pair.from !== pair.to && below.some((state) => state.id === pair.from));
  const H = (below.length ? bottom + lowerGap + BH : bottom + shortcutDepth) + 14 + (outgoing.length ? 44 + 40 * (outgoing.length - 1) : 0);

  const group = (pairList, route, label) => pairList.map((pair, n) => '<g><title>' + esc(says(pair)) + '</title><path class="edge' + (route.back ? ' back' : '') + '" d="' + route.d + '" marker-end="url(#pb-head' + (route.back ? '-back' : '') + ')"/>' + (n === 0 ? label : '') + '</g>').join('');
  const tone = (said, extra = '') => 'tag' + (said.idle ? ' idle' : '') + extra;
  const routes = [];
  // Straight along the row.
  for (const pair of pairs.filter((pair) => col(pair.from) >= 0 && col(pair.to) === col(pair.from) + 1)) {
    const a = pos.get(pair.from), b = pos.get(pair.to), said = told([pair]);
    const words = said.words.join(' · ');
    // A long label sits above the boxes when the gap cannot hold it with clearance.
    const labelY = wide(words, 12) + 8 > b.x - a.x - BW ? top - 8 : Y - 8;
    routes.push(group([pair], { d: path([[a.x + BW / 2, Y], [b.x - BW / 2 - 1, Y]]) }, text((a.x + b.x) / 2, labelY, words, tone(said))));
  }
  // Square, above the row.
  for (const up of ups) {
    const isBack = col(up.pair.to) < col(up.pair.from), y = top - rise[up.level];
    routes.push(group([up.pair], { back: isBack, d: path([[up.start, top], [up.start, y], [up.end, y], [up.end, top - 1]]) }, lines(up.labelX, y - 7, up.lines, tone(up.said, isBack ? ' back' : ''))));
  }
  // Square, below the row, for moves that skip forward past another state.
  for (const shortcut of shortcuts) {
    const y = bottom + shortcut.depth;
    routes.push(group([shortcut.pair], { d: path([[shortcut.start, bottom], [shortcut.start, y], [shortcut.end, y], [shortcut.end, bottom + 1]]) },
      lines(shortcut.labelX, y - 7, shortcut.lines, tone(shortcut.said))));
  }
  // Down from the row, joining into one route per state below, labelled once on the way in.
  for (const s of below) {
    const t = pos.get(s.id), into = pairs.filter((pair) => pair.to === s.id && col(pair.from) >= 0);
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
  // A below-row state can move back into the row or on to another below-row state.
  outgoing.forEach((pair, index) => {
    const from = pos.get(pair.from), to = pos.get(pair.to);
    const lane = bottom + lowerGap + BH + 26 + index * 40;
    const side = to.x < from.x ? to.x + BW / 2 + 1 : to.x - BW / 2 - 1;
    const said = told([pair]);
    const room = Math.max(40, Math.abs(side - from.x) - 24);
    const label = lines((from.x + side) / 2, lane - 8, wrap(said.words, room, 12), tone(said));
    routes.push(group([pair], { d: path([[from.x, from.y + BH / 2], [from.x, lane], [side, lane], [side, to.y]]) }, label));
  });

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
  if (!confirm('Forget the boards that are unreadable now? Boards recovered since this list was shown will be kept.')) return;
  button.disabled = true;
  try {
    const base = hosted.local ? localReadBase : connection.base;
    const headers = hosted.local ? localReadHeaders : connection.headers;
    const result = await jsonRequest('/api/v1/projects/forget-unreadable', { confirm: true }, base, headers);
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
