/** Return the original live section of the self-contained cockpit document. */
export function cockpitLive(sections) {
  const { pageScriptPart1, pageScope, pageScriptPart2, pageScriptPart3 } = sections;
  return `${pageScriptPart1(pageScope)}const itemSearches = new Map();
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

${pageScriptPart3(pageScope)}/**
 * Draw the shown board from its own read, before the rest of the boards answer (#6589): a board not yet on the page,
 * as on a page load or a switch, fills its frame in at once. The read that started it still draws the full answer.
 * An address naming another board leaves the draw to that board's own refresh.
 */
function drawEarly(root, generation, early) {
  if (root !== view.root || data?.root === root || generation < refreshDrawn.generation) return;
  early.root = root;
  if (!addressReady) {
    const place = placeAtAddress(early);
    if (place?.root && place.root !== root) return;
    if (place) applyPlace(place, globalThis.history?.state);
    addressReady = true;
  }
  seen = boardText(early);
  data = early;
  syncBoardMode(root);
  itemSearches.clear();
  render();
  address(false);
  void loadAddressedShout();
}

async function refresh(fresh = null, attempt = 1) {
  const generation = ++refreshStarted;
  const root = view.root;
  const mark = root ? view.seen['pb.seen.' + root] ?? keep('pb.seen.' + root) : null;
  const next = await boardState(root, mark, fresh, fresh ? null : (early) => drawEarly(root, generation, early));
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
    if (view.tab === 'dashboard' && data.project) dashboardView.draw(data.project);
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
  $('live').textContent = snapshot ? 'read-only' : liveLine();
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

`;
}
