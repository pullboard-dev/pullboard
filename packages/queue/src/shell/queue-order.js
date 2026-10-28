/** Pure ordering shared by every machine gate client, including shipped runner runtimes [C7,V4]. */
/** Admission classes, most urgent first. */
export const QUEUE_CLASSES = ['landing', 'review', 'submit', 'other'];
/** By default a waiter moves up one class for every this long it has waited, so no class starves. */
export const QUEUE_AGE_MS = 30 * 60_000;
/** Landings first, then arrival: the order every pool keeps unless the machine opts in to reviews first. */
export const ARRIVAL_ORDER = Object.freeze({ reviewsFirst: false, ageMs: QUEUE_AGE_MS });

/**
 * A waiter's admission class: its declared class from the run it names, and the class it holds now
 * after aging up one class per ageMs waited (QUEUE_AGE_MS unless the machine sets agingMinutes). Landings come first, then reviews (they unblock
 * landing), then submits and item checks, then focused, diagnostic and every other run.
 *
 * @param {{ landing?: number|boolean, itemCheck?: number|boolean, diagnostic?: number|boolean, kind?: string, since?: string }} entry
 * @param {number} [now] - The clock reading to age against; injectable so tests need not wait.
 * @param {number} [ageMs] - How long a waiter waits before it moves up one class.
 * @returns {{ base: number, effective: number, name: string, declared: string }}
 */
export function queueClass(entry, now = Date.now(), ageMs = QUEUE_AGE_MS) {
  const kind = entry.kind ?? '';
  const base = entry.landing === true || entry.landing === 1 ? 0
    : kind === 'review' ? 1
      : !(entry.diagnostic === true || entry.diagnostic === 1) && (entry.itemCheck === true || entry.itemCheck === 1 || kind === 'submit' || kind === 'check') ? 2
        : 3;
  const waited = Math.max(0, now - (Date.parse(entry.since ?? '') || now));
  const effective = Math.max(0, base - Math.floor(waited / ageMs));
  return { base, effective, name: QUEUE_CLASSES[effective], declared: QUEUE_CLASSES[base] };
}

/**
 * Whether a line admits by class: only while the machine opts in to reviews first and every
 * waiter in it was queued by a process that admits by class (see admissionRank for why).
 *
 * @param {Array<{ classed?: number }>} waiters - The whole line for one resource.
 * @param {{ reviewsFirst: boolean }} order - The pool's admission order setting.
 * @returns {boolean}
 */
export function classOrderInEffect(waiters, order) {
  return order.reviewsFirst && (releaseOrderInEffect(waiters, order) || waiters.every((waiter) => waiter.classed === 1));
}

/**
 * The compatibility marker understood by class-only clients. Release-aware clients write 0
 * while release ordering is enabled: older clients must fall back to arrival until they leave.
 * New clients may then use class and release order together only when all waiters are aware.
 * Why not always 1: a #651-only process reads classed=1 on every waiter as "everyone admits by
 * class" and ranks by class, while a process with reviewsFirst off ranks by arrival; the two would
 * disagree and a free slot could stay empty. Writing 0 with the setting off makes every process,
 * old or new, fall back to arrival order together.
 *
 * @param {{ reviewsFirst: boolean, currentReleaseFirst?: boolean }} order - This poll's settings.
 * @returns {0|1}
 */
export function classedMarker(order) {
  return order.reviewsFirst && !order.currentReleaseFirst ? 1 : 0;
}

/**
 * The admission rank every process in this queue agrees on. Class order (with aging) applies only
 * while the machine opts in to reviews first and every waiter was queued by a process that admits
 * by class; otherwise landings come first and then arrival. Why: an older pullboard admits
 * landings first and then by ticket, and two processes ranking the same line differently each
 * wait for the other while a slot stays empty. With any older waiter queued, everyone falls back
 * to that older order, so mixed versions on one machine never deadlock.
 *
 * @param {Array<{ classed?: number }>} waiters - The whole line for one resource.
 * @param {number} now
 * @param {{ reviewsFirst: boolean, ageMs: number }} order - The pool's admission order setting.
 * @returns {(waiter: object) => number}
 */
function admissionRank(waiters, now, order) {
  return classOrderInEffect(waiters, order) ? (waiter) => queueClass(waiter, now, order.ageMs).effective : (waiter) => (waiter.landing === 1 ? 0 : 1);
}

/** All waiters must understand release ordering, or old and new clients use arrival together. */
export function releaseOrderInEffect(waiters, order) {
  return order.currentReleaseFirst && waiters.every((waiter) => waiter.release_aware === 1);
}

/**
 * One admission order for display, reported position and local/remote execution. Begin with the
 * existing class/arrival order, then exchange only otherwise-tied positions belonging to one
 * board. Aged entries keep their positions, so continuing current-release arrivals cannot
 * displace them. Unknown board identities keep their original positions too.
 *
 * @param {object[]} waiters - The complete resource line, before capability filtering.
 * @param {number} now - One clock reading for the whole order.
 * @param {{ reviewsFirst: boolean, currentReleaseFirst?: boolean, ageMs: number }} order
 * @returns {object[]}
 */
export function orderedWaiters(waiters, now, order) {
  const rank = admissionRank(waiters, now, order);
  const releaseOrder = releaseOrderInEffect(waiters, order);
  /** Opportunity positions are consumed separately from immutable waiter identity tickets. */
  const opportunity = waiter => releaseOrder ? waiter.queue_ticket ?? waiter.ticket : waiter.ticket;
  const line = [...waiters].sort((left, right) => rank(left) - rank(right) || opportunity(left) - opportunity(right) || left.ticket - right.ticket);
  if (!releaseOrder) return line;
  const positions = new Map();
  line.forEach((waiter, index) => {
    const waited = Math.max(0, now - (Date.parse(waiter.since ?? '') || now));
    if (!waiter.board_key || waited >= order.ageMs) return;
    const key = JSON.stringify([waiter.board_key, rank(waiter)]);
    const group = positions.get(key) ?? [];
    group.push(index);
    positions.set(key, group);
  });
  for (const group of positions.values()) {
    const tickets = group.map(index => opportunity(line[index]));
    const entries = group.map(index => line[index]).sort((left, right) => left.release_rank - right.release_rank || opportunity(left) - opportunity(right) || left.ticket - right.ticket);
    group.forEach((index, at) => { line[index] = { ...entries[at], queue_ticket: tickets[at] }; });
  }
  return line;
}
