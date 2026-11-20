/**
 * Which agent session built an item (#921). A seat name is not a session: one session can hold the coordinator's
 * checkout and a review worktree at once, and then "never verify your own work" holds only by name. Claims and submits
 * record the session's digest beside the board, in this repository's own Git directory, never on the shared board or
 * the relay, and a verdict from a session that built or submitted the item is refused.
 */
import { join } from 'node:path';
import { fileSystemAdapter } from '../../../fs/index.js';
import { Refused } from "../../../kernel/index.js";

const fs = fileSystemAdapter();

/** A caller must explicitly capture a native digest or the no-agent null result, never omit identity [V1,B3]. */
function requireCapturedSession(digest) {
  if (digest === undefined) throw new Refused('SESSION_LEDGER', 'the native caller must capture its current agent session before using the local ledger');
}

/** The local ledger of item moves by session digest, shared by every worktree of this repository. */
function ledgerFile(info) {
  return join(info.commonDir, 'pullboard', 'item-sessions.jsonl');
}

/** The refusal when the ledger cannot keep a session's claims and submits; a lost entry would let that session judge its own work. */
function ledgerRefusal(info, error) {
  return new Refused('SESSION_LEDGER', `this agent session's claim or submit cannot be recorded in ${ledgerFile(info)} (${error.code ?? error.message}), so a later verdict could not be checked against it`,
    `make that file writable by this user (chmod u+rw ${ledgerFile(info)}), then run the command again`);
}

/**
 * Refuse a claim or submit from an agent session before it moves when the ledger cannot be written (#921). A shell
 * with no agent session records nothing and is never refused.
 */
export function requireLedger(info, digest) {
  requireCapturedSession(digest);
  if (!digest) return;
  try {
    fs.mkdir(join(info.commonDir, 'pullboard'), { recursive: true, mode: 0o700 });
    fs.access(fs.exists(ledgerFile(info)) ? ledgerFile(info) : join(info.commonDir, 'pullboard'), fs.constants.W_OK);
  } catch (error) { throw ledgerRefusal(info, error); }
}

/** Record that this session claimed or submitted an item; a write that fails after the move is reported, never dropped. */
export function recordItemSession(info, item, move, digest) {
  requireCapturedSession(digest);
  if (!digest || !Number.isInteger(Number(item))) return;
  try {
    fs.appendFile(ledgerFile(info), JSON.stringify({ item: Number(item), move, digest, at: new Date().toISOString() }) + '\n', { mode: 0o600 });
  } catch (error) { throw ledgerRefusal(info, error); }
}

/** The digests recorded for one item's claims and submits. */
function ledgerDigests(info, item, commitOnly = false) {
  const file = ledgerFile(info);
  if (!fs.exists(file)) return new Set();
  let text;
  try { text = fs.readFile(file, 'utf8'); }
  catch (error) {
    throw new Refused('SESSION_LEDGER', `the agent-session ledger ${file} cannot be read (${error.code ?? error.message}), so this verdict's independence from the builder cannot be checked`,
      `make it readable by this user (chmod u+r ${file}), then verify again`);
  }
  return new Set(text.split('\n').flatMap((line) => {
    try {
      const row = JSON.parse(line);
      return row.item === item && (!commitOnly || row.move === 'submit') && typeof row.digest === 'string' ? [row.digest] : [];
    } catch { return []; }
  }));
}

/** The seats this session's digest is bound to now, in the main checkout and every worktree. */
function boundSeats(info, digest) {
  const files = [join(info.commonDir, 'pullboard-checkout-session.json')];
  const worktrees = join(info.commonDir, 'worktrees');
  if (fs.exists(worktrees)) {
    for (const entry of fs.list(worktrees, { withFileTypes: true })) {
      if (entry.isDirectory()) files.push(join(worktrees, entry.name, 'pullboard-checkout-session.json'));
    }
  }
  const seats = new Set();
  for (const file of files) {
    try {
      const binding = JSON.parse(fs.readFile(file, 'utf8'));
      if (binding.digest === digest && typeof binding.agent === 'string') seats.add(binding.agent);
    } catch { /* A missing or damaged peer binding names no seat. */ }
  }
  return seats;
}

/**
 * Refuse a verdict from the agent session that built or submitted the item: its digest is on the item's ledger, or it
 * is bound right now to any seat in its recorded author history. A shell with no agent session (the person's terminal) is never refused.
 * Skipped when review.independence is off, which the CLI passes by default; a caller that names no setting keeps this strict rule.
 *
 * @param {{ commonDir: string }} info
 * @param {{ item_id: number, item_built_by?: string|null, item_owner?: string|null }} item
 * @param {string|null} [digest] - Current local session digest.
 * @param {string[]} [authors] - Historical author seats from the board's claim and submit events.
 * @param {{ independence?: 'off'|'session' }} [options] - review.independence from the repo configuration.
 */
export function refuseSelfSession(info, item, digest, authors = [], { commitOnly = false, currentAuthorSessions, independence = 'session' } = {}) {
  requireCapturedSession(digest);
  if (!digest || independence === 'off') return; // review.independence off: only the seat itself is refused, by the board.
  const builders = [item.item_built_by, ...(commitOnly ? [] : [item.item_owner]), ...authors].filter(Boolean);
  const seats = boundSeats(info, digest);
  const recorded = currentAuthorSessions === undefined ? ledgerDigests(info, item.item_id, commitOnly).has(digest) : currentAuthorSessions.includes(digest);
  if (!recorded && !builders.some((builder) => seats.has(builder))) return;
  throw new Refused('SELF_SESSION_VERIFY', `this agent session built or submitted #${item.item_id}, so its verdict would be its own work under another seat's name`,
    'start the review in a separate process or session: run pullboard next --verify from a different agent session\'s own worktree');
}
