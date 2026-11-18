/** Attribute waiting requests to this device while keeping relay intent private [H17,H5]. */
import { excludedNoticeLines } from '../../logic/notice.js';
/** Match requests to device-owned ids, retaining only waiting receipts and observed final statuses. */
export function reconcileOwnedRequests(requests, ownedIds) {
  const records = new Map((Array.isArray(requests) ? requests : []).filter(value => value && typeof value.id === 'string').map(value => [value.id, value]));
  const waiting = [];
  const finished = [];
  for (const id of ownedIds) {
    const status = records.get(id)?.status;
    if (status === 'waiting') waiting.push(id);
    else if (status === 'done' || status === 'refused') finished.push(id);
  }
  return { waiting, finished };
}

/** Persist only this device's stable request id; the sealed intent remains in the separate outbox. */
export function rememberOwnedRequestId(storage, key, id) {
  const saved = JSON.parse(storage.getItem(key) ?? '[]');
  const owned = Array.isArray(saved) ? saved.filter(value => typeof value === 'string') : [];
  if (!owned.includes(id)) storage.setItem(key, JSON.stringify([...owned, id]));
}

/** Keep IDs through incomplete replay, then forget them only after their own final status arrives. */
export function storedOwnedRequestState(storage, key, requests) {
  const saved = JSON.parse(storage.getItem(key) ?? '[]');
  const owned = Array.isArray(saved) ? saved.filter(value => typeof value === 'string') : [];
  const state = reconcileOwnedRequests(requests, owned);
  if (state.finished.length) {
    const finished = new Set(state.finished);
    storage.setItem(key, JSON.stringify(owned.filter(value => !finished.has(value))));
  }
  return { ...state, owned: new Set(owned) };
}

/** Preserve this browser's first failed read per board; another board cannot clear it. */
export function recordBrowserReadFailure(degradedBoards, id, now = Date.now()) {
  if (!degradedBoards.has(id)) degradedBoards.set(id, new Date(now).toISOString());
}

/** Clear only the board whose authenticated snapshot and complete prefix were read successfully. */
export function clearBrowserReadFailure(degradedBoards, id) {
  degradedBoards.delete(id);
}

/** The plain words for each relay fault: what happened, then the one next step [H5,H17]. */
export const RELAY_FAULT_WORDS = Object.freeze({
  down: 'The relay is not answering. Wait a moment; this page tries again by itself.',
  trouble: 'The relay is having trouble. Wait a moment; this page tries again by itself.',
  behind: 'The relay is catching up with this board. Wait a moment; this page tries again by itself.',
  version: 'This page is older than the relay. Reload this page to get the new version.',
});

/**
 * Which relay fault an error is, or null when it is none of the four a person can wait out or reload past. Why: a
 * refusal arrives as an Error with a code, as a bracketed code at the front of its message, or as the browser's own
 * network TypeError, and every one of them should read the same to the person.
 * @param {unknown} error - A thrown error or an `{ code, message }` document from the relay.
 * @returns {'down'|'trouble'|'behind'|'version'|null}
 */
export function relayFault(error) {
  const text = String(error?.message ?? error ?? '');
  const code = String(error?.code ?? /^\[([A-Z_]+)\]/u.exec(text)?.[1] ?? '');
  if (['ENGINE_VERSION', 'RELAY_ENGINE_VERSION'].includes(code)) return 'version';
  if (code === 'SNAPSHOT_REQUIRED') return 'behind';
  if (code === 'RELAY_UNAVAILABLE') return 'trouble';
  if (error instanceof TypeError || /failed to fetch|network ?error|load failed/iu.test(text)) return 'down';
  return null;
}

/**
 * What the page says about a failed relay read: the fault's plain words and next step, else the error's own sentence
 * with any leading refusal code taken off, so a code never reaches the person.
 * @param {unknown} error
 * @returns {string}
 */
export function relayFailureText(error) {
  const fault = relayFault(error);
  if (fault) return RELAY_FAULT_WORDS[fault];
  return String(error?.message ?? error ?? '').replace(/^\[[A-Z_]+\]\s*/u, '');
}

/** Build truthful device notices from authorized boards and their decrypted pending requests. */
export function noticeLines({ available, paired, ownedRequestIds = new Map(), waitingBoards = new Map(), sizeProblems = new Map(), approvedBoards = new Set(), pendingLinks = [], warnings = [], failure = '', exclusions = [], degradedBoards = new Map(), queuedRequests = new Map() }) {
  const lines = [];
  for (const [id, entry] of paired) {
    const since = degradedBoards.get(id);
    const queued = queuedRequests.get(id);
    if (!since && !(queued > 0) && queued !== null) continue;
    const name = entry.repository ?? id;
    const count = queued === null ? 'queued request count unavailable' : `${queued ?? 0} sealed request${queued === 1 ? '' : 's'} queued locally`;
    lines.push(`${name}: ${since ? `relay degraded since ${since.slice(11, 16)}; ` : ''}${count}.${queued > 0 ? ' This device has not received an acknowledgement for these queued requests.' : ''}`);
  }
  const waiting = [...paired.entries()].reduce((count, [id, entry]) => {
    const owned = ownedRequestIds.get(id) ?? new Set();
    return count + reconcileOwnedRequests(entry.state?.personRequests, owned).waiting.length;
  }, 0);
  if (waiting) lines.push(`${waiting} request${waiting === 1 ? '' : 's'} from this device ${waiting === 1 ? 'is' : 'are'} waiting for a linked machine to run Pullboard.`);
  for (const link of pendingLinks) if (typeof link?.name === 'string') lines.push(`${link.name}: waiting for approval on your phone.`);
  // One board's successful event or checkpoint cannot clear another board's recorded lag.
  for (const [id, entry] of paired) if (entry.checkpointTimedOut) {
    lines.push((entry.repository ?? id) + ': The relay snapshot has not caught up to this move. Retry this board.');
  }
  const pairedRepositories = new Set(available.filter(board => paired.has(board.id)).map(board => board.repository));
  for (const board of available.filter(value => !paired.has(value.id))) {
    if (sizeProblems.has(board.id)) { lines.push(uploadSizeLine(sizeProblems.get(board.id))); continue; }
    // This phone just approved the link: its key is on the way, so asking to pair would be wrong.
    if (approvedBoards.has(board.id)) {
      lines.push(`${board.repository} · board ${board.id.slice(0, 8)}: approved; waiting for the computer to send this phone its key.`);
      continue;
    }
    if (waitingBoards.has(board.id)) {
      lines.push(`${board.repository} · board ${board.id.slice(0, 8)}: waiting for its first snapshot from a linked machine.`);
      continue;
    }
    if (!pairedRepositories.has(board.repository)) {
      lines.push(board.repository + ': pair this browser using a link or QR from a linked machine.');
      continue;
    }
    const date = Number.isSafeInteger(board.linkedAt) && board.linkedAt >= 0 && board.linkedAt <= 8640000000000000
      ? new Date(board.linkedAt).toISOString().slice(0, 10) : 'date unavailable';
    const warning = warnings.find(value => value?.board === board.id && value.code === 'BOARD_INACTIVE' && Number.isInteger(value.daysLeft));
    const removal = warning
      ? `To remove it, run pullboard relay off from the machine that linked it, or wait ${warning.daysLeft} days for automatic removal.`
      : 'To remove it, run pullboard relay off from the machine that linked it, or wait until 90 days without activity for automatic removal.';
    lines.push(`${board.repository} · linked ${date} · board ${board.id.slice(0, 8)}. ${removal}`);
  }
  for (const warning of warnings) if (warning?.code === 'BOARD_INACTIVE' && Number.isInteger(warning.daysLeft)) {
    lines.push('BOARD_INACTIVE: ' + warning.daysLeft + ' days left before this relay board is deleted. Make a board move from a linked machine to keep it.');
  }
  const storageAccounts = new Set();
  for (const warning of warnings) if (['ACCOUNT_STORAGE_WARNING', 'ACCOUNT_STORAGE_LIMIT'].includes(warning?.code) && typeof warning.message === 'string') {
    const account = warning.storage?.account?.id;
    if (account && storageAccounts.has(account)) continue;
    if (account) storageAccounts.add(account);
    lines.push(warning.message);
  }
  if (failure) lines.push(failure);
  lines.push(...excludedNoticeLines(exclusions));
  if (!available.length && !exclusions.length) lines.push('No linked boards are available for this account.');
  return lines;
}

/** Describe only authenticated publisher measurements, without guessing from an absent snapshot. */
export function uploadSizeLine(value) {
  return `${value.repository}: too big to share (${value.sealedBytes} bytes; relay limit ${value.limit} bytes). Upgrade the configured relay for bounded snapshots.`;
}

/** The approved words of the two first screens another device can show (#757); the view may draw them from these. */
export const RELAY_SCREEN_WORDS = Object.freeze({
  signIn: Object.freeze({ title: 'Your boards, on your phone', say: 'Sign in with the GitHub account you use on your computer.',
    action: 'Sign in with GitHub', small: 'Nothing to install on your phone.', help: 'Stuck? On your computer, ask your agent', ask: 'Help me see my boards on my phone.' }),
  share: Object.freeze({ title: 'One step on your computer', say: 'On the computer with your projects, open a terminal and run this once:',
    command: 'pullboard relay on --all', agent: 'Ask your agent', ask: 'Help me share my boards with my phone.',
    small: 'It shares every project with your account. Your boards show up here by themselves.', waiting: 'Waiting for your boards' }),
});

/** Select guidance from observed inventory and key delivery, never infer why a computer has not uploaded. */
export function emptyBoardStep({ available = [], waitingBoards = new Map(), sizeProblems = new Map(), approvedBoards = new Set(), loaded = false, browserPaired = false, knownDevice = false, failure = '', exclusions = [] } = {}) {
  const pair = { command: 'pullboard relay pair --new-browser', ask: 'Help me pair this browser with my boards.',
    small: 'On the computer with the boards, run this, then open the link it prints here or scan its QR.' };
  if (!loaded) return { title: 'Checking your linked boards', say: failure || 'Waiting for this account’s board list.', command: '', ask: '', small: '', waiting: failure || 'Checking your boards' };
  if (sizeProblems.size) return { title: 'Board too big to share', say: [...sizeProblems.values()].map(uploadSizeLine).join(' '),
    command: '', ask: 'Help me upgrade my relay for bounded snapshots.', small: 'Local work remains available on the computer.', waiting: 'Board exceeds the relay limit' };
  if (!available.length && exclusions.length) return { title: 'Boards excluded from sharing',
    say: excludedNoticeLines(exclusions).join(' '), command: 'pullboard relay on', ask: 'Help me include my excluded boards.',
    small: 'On the named computer, open a terminal in each excluded board and run this command.', waiting: 'Waiting for you to include a board' };
  if (approvedBoards.size) return { title: 'Finishing this pairing', say: 'Approved; waiting for the computer to send this browser its board keys.',
    command: '', ask: '', small: 'Keep the setup command open on the computer with the boards.', waiting: failure || 'Waiting for this browser’s keys' };
  if (waitingBoards.size) return { title: 'Waiting for the first board copy',
    say: [...waitingBoards.values()].join(', ') + ': its first copy has not reached the relay yet.', command: 'pullboard relay status',
    ask: 'Help me check why my board has not reached the relay.', small: 'Run this on the computer with the board to see why.', waiting: failure || 'Waiting for the first board copy' };
  if (!available.length) return { ...RELAY_SCREEN_WORDS.share,
    say: 'No linked boards are available for this account. ' + RELAY_SCREEN_WORDS.share.say,
    ...(failure ? { title: 'Could not check your boards', say: failure, command: '', ask: '', small: '', waiting: 'Open this page again to retry.' } : {}) };
  if (!browserPaired && knownDevice) return { ...pair, title: 'This browser lost its pairing', say: failure || 'Its site storage was cleared, so it forgot it was paired. Pair it again to open your boards.', waiting: 'Waiting for this browser to be paired again' };
  if (!browserPaired) return { ...pair, title: 'This browser is not paired', say: failure || 'Your account already has linked boards. Pair this browser to open them.', waiting: 'Waiting for this browser to be paired' };
  return { ...pair, title: 'Linked boards, none readable here', say: failure || 'The computer has not handed this browser keys for these boards yet.', waiting: 'Waiting for keys to your linked boards' };
}

const MARK = '<svg viewBox="0 0 64 64" aria-hidden="true"><path fill="currentColor" d="M8 7h35a6 6 0 0 1 6 6v7H8a5 5 0 0 1-5-5v-3a5 5 0 0 1 5-5Z"/><rect fill="var(--accent)" width="56" height="14" x="3" y="25" rx="5"/><path fill="currentColor" d="M8 43h35a6 6 0 0 1 6 6v8H8a5 5 0 0 1-5-5v-4a5 5 0 0 1 5-5Z"/></svg>';
const GITHUB = '<svg viewBox="0 0 16 16" aria-hidden="true"><path fill="currentColor" d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0 0 16 8c0-4.42-3.58-8-8-8Z"/></svg>';
const SPEECH = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 12a8 8 0 0 1-11.6 7.1L4 20l1-4.6A8 8 0 1 1 21 12Z"/></svg>';

/**
 * The markup of one first screen, served inside the hosted page and shown only while the page's state names it.
 * Why markup on the server: the screen is there at first paint, before any script, so a phone never flashes the board.
 * @param {'sign-in'|'share'} name
 * @param {string} signIn - the same-site path that starts GitHub sign-in
 */
export function relayScreenMarkup(name, signIn) {
  const head = '<div class="relay-mark">' + MARK + 'Pullboard</div>';
  if (name === 'sign-in') {
    const words = RELAY_SCREEN_WORDS.signIn;
    return '<section id="relay-screen" aria-label="Pullboard"><div class="relay-panel" data-screen="sign-in">' + head
      + '<h1>' + words.title + '</h1><p class="relay-say">' + words.say + '</p>'
      + '<a class="relay-big relay-github" href="' + signIn + '">' + GITHUB + words.action + '</a>'
      + '<p class="relay-small">' + words.small + '</p>'
      + '<div class="relay-help">' + SPEECH + '<span>' + words.help + '<small>“' + words.ask + '”</small></span><button type="button" data-copy="' + words.ask + '">Copy</button></div>'
      + '</div></section>';
  }
  const words = emptyBoardStep();
  return '<section id="relay-screen" aria-label="Pullboard"><div class="relay-panel" data-screen="share">' + head
    + '<h1>' + words.title + '</h1><p class="relay-say">' + words.say + '</p>'
    + '<div class="relay-box relay-command" hidden><code></code><button type="button" data-copy="">Copy</button></div>'
    + '<div class="relay-or" hidden>or</div>'
    + '<div class="relay-box relay-agent" hidden>' + SPEECH + '<span>Ask your agent<small></small></span><button type="button" data-copy="">Copy</button></div>'
    + '<p class="relay-small">' + words.small + '</p>'
    + '<p class="relay-live" role="status"><i aria-hidden="true"></i><span>' + words.waiting + '</span></p>'
    + '</div></section>';
}

/** True when this device can open no board and none is on its way, so the one-command screen is the next step. */
export function nothingShared({ paired, waitingBoards, failure }) {
  return paired.size === 0 && waitingBoards.size === 0 && !failure;
}

/**
 * Name the first screen the page shows, or none so the board shows. The state is the root's data-relay-screen,
 * which the stylesheet reads; clearing it gives back only the screen this transport set.
 * A phone waiting for its first readable board keeps the actual failure or waiting reason here.
 * @param {HTMLElement} root - The document's root element.
 * @param {string|null} name - The first screen, or null when the board can show.
 * @param {string} [message] - Existing transport guidance to display instead of the default waiting line.
 * @param {object} [step] - Observed empty-board state; omitted while the first inventory is pending.
 */
export function showRelayScreen(root, name, message = '', step = emptyBoardStep()) {
  if (name) root.dataset.relayScreen = name;
  else if (root.dataset.relayScreen === 'share') delete root.dataset.relayScreen;
  const panel = root.querySelector?.('#relay-screen .relay-panel[data-screen="share"]');
  if (!panel) return;
  panel.querySelector('h1').textContent = step.title;
  panel.querySelector('.relay-say').textContent = step.say;
  panel.querySelector('.relay-small').textContent = step.small;
  const command = panel.querySelector('.relay-command');
  command.hidden = !step.command;
  command.querySelector('code').textContent = step.command ? '$ ' + step.command : '';
  command.querySelector('button').dataset.copy = step.command;
  const agent = panel.querySelector('.relay-agent');
  agent.hidden = !step.ask;
  agent.querySelector('small').textContent = step.ask ? '“' + step.ask + '”' : '';
  agent.querySelector('button').dataset.copy = step.ask;
  panel.querySelector('.relay-or').hidden = !step.ask;
  panel.querySelector('.relay-live span').textContent = message || step.waiting;
}

/** Copy a screen's sentence or command; a browser without the clipboard API copies from a selected field. */
async function copyText(text) {
  try { await navigator.clipboard.writeText(text); return; }
  catch { /* Fall back to a selected field below: older and embedded browsers refuse the clipboard API. */ }
  const field = document.createElement('textarea');
  field.value = text;
  field.setAttribute('readonly', '');
  field.style.position = 'fixed';
  field.style.opacity = '0';
  document.body.append(field);
  field.select();
  document.execCommand('copy');
  field.remove();
}

/** Make every Copy button on the first screens copy its own words and say so for a moment. */
export function wireRelayScreens(root) {
  root.addEventListener('click', async event => {
    const button = event.target instanceof Element ? event.target.closest('button[data-copy]') : null;
    if (!button) return;
    await copyText(button.dataset.copy);
    button.textContent = 'Copied';
    setTimeout(() => { button.textContent = 'Copy'; }, 1600);
  });
}

const HOME_LINE = 'pullboard.relay.home-screen-line.v1';

/** True once the person dismissed the Home Screen line on this device; unreadable storage shows it again. */
export function homeLineDismissed(storage) {
  try { return storage.getItem(HOME_LINE) === 'dismissed'; } catch { return false; }
}

/** One dismissible line, under the board, that suggests the Home Screen so the browser keeps this pairing. */
export function homeScreenLine(doc, storage) {
  const line = doc.createElement('p');
  line.id = 'pairing-storage-notice';
  line.className = 'relay-line';
  line.setAttribute('role', 'status');
  const text = doc.createElement('span');
  text.textContent = 'Add to Home Screen to keep this pairing.';
  const dismiss = doc.createElement('button');
  dismiss.type = 'button';
  dismiss.setAttribute('aria-label', 'Dismiss');
  dismiss.title = 'Dismiss';
  dismiss.innerHTML = '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M4 4l8 8M12 4l-8 8" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round"/></svg>';
  dismiss.addEventListener('click', () => {
    try { storage.setItem(HOME_LINE, 'dismissed'); } catch { /* Unsaved, the line comes back next visit; it still goes now. */ }
    line.remove();
  });
  line.append(text, dismiss);
  return line;
}

/**
 * Name the real cause of a RELAY_UNAVAILABLE read from data the relay already has, each with the one command that fixes it [H5,H17].
 * A real network failure stays a connection problem. The excluded actor and reason appear only when recorded (#1975).
 * @param {{ error?: unknown, relayOn?: boolean, machine?: string|null, excluded?: { name?: string, by?: string|null, reason?: string|null, at?: string|null }|null, machines?: { id: string, label?: string, lastSeen?: string|null, online?: boolean }[] }} state
 * @returns {{ cause: 'connection'|'relay_off'|'excluded'|'asleep'|'unknown', machine: string|null, fix: string|null, [field: string]: unknown }}
 */
export function relayUnavailableCause({ error, relayOn = true, machine = null, excluded = null, machines = [] } = {}) {
  if (relayFault(error) === 'down') return { cause: 'connection', machine, fix: null };
  if (excluded) {
    return { cause: 'excluded', machine, name: excluded.name ?? null, by: excluded.by ?? null, reason: excluded.reason ?? 'unknown historical exclusion',
      at: excluded.at ?? null, fix: 'On that computer, run pullboard relay on in this board.' };
  }
  if (!relayOn) return { cause: 'relay_off', machine, fix: 'On that computer, run pullboard relay on.' };
  const seen = machines.find(entry => entry.id === machine);
  if (seen && seen.online === false) {
    return { cause: 'asleep', machine, label: seen.label ?? null, lastSeen: seen.lastSeen ?? null, fix: 'Wake that computer, or run pullboard relay there.' };
  }
  return { cause: 'unknown', machine, fix: null };
}
