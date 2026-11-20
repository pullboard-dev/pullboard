/**
 * The clock table: every non-terminal item state has an owner, a deadline and a default move the board makes at the
 * deadline, so no state can hold an item forever [B4,C7]. Pure logic: no board, no io and no clock; the caller passes now.
 * Unsure never means never: unknown activity evidence waits one more deadline (the hard limit), then the move applies.
 */

const MINUTE_MS = 60_000;

/** Item statuses that need no clock: the item landed (verified) or was withdrawn. */
export const CLOCK_TERMINAL = Object.freeze(['verified', 'withdrawn']);

/**
 * One row per state. deadlineMinutes is the fixed deadline, or null when the row inherits it from deadlineFrom (a lease,
 * the hold's recorded deadline or the root item's deadline). unknownLimit 1 means unknown evidence waits one extra deadline.
 */
export const CLOCK_TABLE = Object.freeze([
  { rule: 'gate-deferred', state: 'open, newest gate deferred and unsettled', owner: 'board', deadlineMinutes: 120, deadlineFrom: null, move: 'gate-dead', unknownLimit: 1 },
  { rule: 'gate-unknown', state: 'claimed, gate settled unknown', owner: 'submitter', deadlineMinutes: 240, deadlineFrom: null, move: 'release-claim', unknownLimit: 1 },
  { rule: 'claim-idle', state: 'claimed, building; progress is the holder\'s own board event on the item or a file change in its item folder, never a heartbeat, a beater or a live pid', owner: 'builder', deadlineMinutes: 30, deadlineFrom: null, move: 'release-claim', unknownLimit: 1 },
  { rule: 'hold', state: 'held, any kind including coordinator holds', owner: 'hold-owner', deadlineMinutes: 1440, deadlineFrom: 'hold-deadline', move: 'to-rebar', unknownLimit: 1 },
  { rule: 'rescope', state: 'open, hidden by a re-scope release', owner: 're-bar-queue', deadlineMinutes: 120, deadlineFrom: null, move: 'to-person', unknownLimit: 1 },
  { rule: 'folder', state: 'item folder of a landed, withdrawn, released or lapsed item, or seat folder of a gone seat', owner: 'board', deadlineMinutes: 10, deadlineFrom: null, move: 'remove-folder', unknownLimit: 1 },
  { rule: 'ready', state: 'open, unheld, every after landed, offerable', owner: 'builders', deadlineMinutes: 60, deadlineFrom: null, move: 'alarm', unknownLimit: 1 },
  { rule: 'submitted', state: 'in the gate', owner: 'runner', deadlineMinutes: null, deadlineFrom: 'gate-lease', move: 'existing', unknownLimit: 1 },
  { rule: 'review', state: 'in review', owner: 'reviewer', deadlineMinutes: null, deadlineFrom: 'review-lease', move: 'existing', unknownLimit: 1 },
  { rule: 'waiting', state: 'open with an unlanded after', owner: 'root-owner', deadlineMinutes: null, deadlineFrom: 'root-deadline', move: 'inherit', unknownLimit: 1 }
].map((row) => Object.freeze(row)));

const BY_RULE = new Map(CLOCK_TABLE.map((row) => [row.rule, row]));
const EVIDENCE = new Set(['active', 'idle', 'unknown']);

/** The table row for a rule name; throws for a name the table does not hold. */
function rowFor(rule) {
  const row = BY_RULE.get(rule);
  if (!row) throw new Error(`clock: no row for rule ${rule}`);
  return row;
}

/**
 * Map one item's facts to exactly one clock row. Facts: status (open, claimed, submitted, or terminal), held, gate
 * ('deferred', 'unknown' or other), rescope, after ('landed' or 'unlanded'), review, and folder ('ended' when the facts
 * describe an item or seat folder whose item or claim ended). Facts no row covers throw, so a new state cannot slip past.
 *
 * @param {{ status?: string, held?: boolean, gate?: string, rescope?: boolean, after?: string, review?: boolean, folder?: string }} facts - One item's facts.
 * @returns {object} The frozen CLOCK_TABLE row.
 */
export function clockRow(facts) {
  const { status, held = false, gate, rescope = false, after, review = false, folder } = facts ?? {};
  if (folder === 'ended') return rowFor('folder');
  if (CLOCK_TERMINAL.includes(status)) throw new Error(`clock: status ${status} is terminal and has no row`);
  if (held) return rowFor('hold');
  if (status === 'submitted') return rowFor(review ? 'review' : 'submitted');
  if (status === 'claimed') return rowFor(gate === 'unknown' ? 'gate-unknown' : 'claim-idle');
  if (status === 'open') {
    if (rescope) return rowFor('rescope');
    if (gate === 'deferred') return rowFor('gate-deferred');
    return rowFor(after === 'unlanded' ? 'waiting' : 'ready');
  }
  throw new Error(`clock: no row covers status ${status}`);
}

/**
 * Whether a rule's default move is due at now. since is when the state (or its last progress) began, in ms; evidence is
 * 'active', 'idle' or 'unknown'. Idle evidence is due at one deadline; unknown waits one more deadline; at the hard limit
 * (1 + unknownLimit deadlines) the move is due whatever the evidence. deadlineMinutes overrides the row's deadline (a
 * recorded hold deadline, a lease, a root's deadline) and is required for rows that inherit theirs.
 *
 * @param {{ rule: string, since: number, evidence: string, deadlineMinutes?: number }} input - The rule, start time, evidence and optional deadline.
 * @param {number} now - The current time in ms, passed by the caller.
 * @returns {{ due: boolean, move?: string, deadlineAt?: number, waiting?: string }} The verdict.
 */
export function clockDue({ rule, since, evidence, deadlineMinutes }, now) {
  const row = rowFor(rule);
  if (!EVIDENCE.has(evidence)) throw new Error(`clock: evidence must be active, idle or unknown, not ${evidence}`);
  const minutes = deadlineMinutes ?? row.deadlineMinutes;
  if (!(minutes > 0)) throw new Error(`clock: rule ${rule} needs a positive deadline (${row.deadlineFrom ?? 'deadlineMinutes'})`);
  if (!Number.isFinite(since) || !Number.isFinite(now)) throw new Error('clock: since and now must be times in ms');
  const deadlineAt = since + minutes * MINUTE_MS;
  const limitAt = since + (1 + row.unknownLimit) * minutes * MINUTE_MS;
  if (now < deadlineAt) return { due: false, deadlineAt };
  if (now >= limitAt) return { due: true, move: row.move };
  if (evidence === 'idle') return { due: true, move: row.move };
  if (evidence === 'unknown') return { due: false, waiting: 'unknown-evidence', deadlineAt: limitAt };
  return { due: false, deadlineAt: limitAt };
}
