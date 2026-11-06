/** Physical-board heartbeat state never crosses a relay or export boundary [Q1,Q3,H16]. */
export const LANDING_LOCAL_PREFIX = 'local:landing-lease:';

/** Read only an exact invocation's local observation; malformed local state grants no authority. */
export function localLandingEntry(board, entry) {
  if (!entry) return null;
  const row = board.db.prepare('SELECT meta_value FROM board_meta WHERE meta_key=?').get(LANDING_LOCAL_PREFIX + entry.token);
  try {
    const value = row && JSON.parse(row.meta_value);
    const boardId = board.db.prepare("SELECT meta_value FROM board_meta WHERE meta_key='board_id'").get()?.meta_value;
    return value && value.boardId === boardId && value.branch === entry.branch && value.pid === entry.pid && value.lineage === entry.lineage
      && value.generation === (entry.generation ?? null) && Number.isFinite(Date.parse(value.until)) ? value : null;
  } catch { return null; }
}

/** How long one local lease mark waits out another process's board write before giving up [C7]. */
const LOCAL_LEASE_BUSY_MS = 10_000;

/**
 * Mark only a successfully acknowledged local request, then extend that invocation's local deadline. A busy board is
 * waited out in short sleeps: this one statement ran with no busy handling, so a seat's write at the wrong moment
 * ended the landing that had just been granted its lease with a bare "database is locked" [C7].
 */
export function rememberLocalLanding(board, entry) {
  const started = Date.now();
  for (;;) {
    try {
      board.db.prepare('INSERT INTO board_meta(meta_key,meta_value) VALUES (?,?) ON CONFLICT(meta_key) DO UPDATE SET meta_value=excluded.meta_value')
        .run(LANDING_LOCAL_PREFIX + entry.token, JSON.stringify({ boardId: board.db.prepare("SELECT meta_value FROM board_meta WHERE meta_key='board_id'").get()?.meta_value, branch: entry.branch, pid: entry.pid, lineage: entry.lineage,
          generation: entry.generation ?? null, until: entry.until }));
      return;
    } catch (error) {
      const busy = (Number.isInteger(error?.errcode) && [5, 6].includes(error.errcode & 0xff)) || /database is locked/iu.test(error?.message ?? '');
      if (!busy || Date.now() - started >= LOCAL_LEASE_BUSY_MS) throw error;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50);
    }
  }
}

/** Forget a completed local invocation without changing shared native history. */
export function forgetLocalLanding(board, token) {
  board.db.prepare('DELETE FROM board_meta WHERE meta_key=?').run(LANDING_LOCAL_PREFIX + token);
}
