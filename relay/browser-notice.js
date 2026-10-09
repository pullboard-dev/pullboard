/** Attribute waiting requests to this device while keeping relay intent private [H17,H5]. */
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

/** Build truthful device notices from authorized boards and their decrypted pending requests. */
export function noticeLines({ available, paired, ownedRequestIds = new Map(), waitingBoards = new Map(), warnings = [], failure = '' }) {
  const lines = [];
  const waiting = [...paired.entries()].reduce((count, [id, entry]) => {
    const owned = ownedRequestIds.get(id) ?? new Set();
    return count + reconcileOwnedRequests(entry.state?.personRequests, owned).waiting.length;
  }, 0);
  if (waiting) lines.push(`${waiting} request${waiting === 1 ? '' : 's'} from this device ${waiting === 1 ? 'is' : 'are'} waiting for a linked machine to run Pullboard.`);
  const pairedRepositories = new Set(available.filter(board => paired.has(board.id)).map(board => board.repository));
  for (const board of available.filter(value => !paired.has(value.id))) {
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
  if (failure) lines.push(failure);
  if (!available.length) lines.push('No linked boards are available for this account.');
  return lines;
}
