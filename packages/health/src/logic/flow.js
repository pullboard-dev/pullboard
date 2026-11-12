/** Release flow: one current cause per unlanded item, every idle seat, and recent landings [N26,C7]. */
const HOUR_MS = 3_600_000;
const FINISHED_BATCH = new Set(['landed', 'blocked', 'flaky', 'test-defect']);

/**
 * Snapshot the current causes without inventing missing provenance or mutating dispatch. The seven causes:
 * landing, reviewing, building, held, waiting, review (waiting for a reviewer) and free.
 * Why a refuse port: the cell stays free of the kernel; the caller passes its Refused.
 * Why a store port: the projection is pure, so the CLI and the view read the board through one injected reader.
 *
 * @param {any} board - Passed through to every port call.
 * @param {{ store: any, workProgress: (board: any) => Map<number, any>, reviewEligibility: (board: any, item: any, options: any) => { eligible: string[], ineligible: { agent: string, rule: string }[] }, now: () => number, merged: (board: any, sinceIso: string) => { item_id: number, event_at: string }[], release?: string, policy?: string, familyPolicy?: string, familyRelaxAt?: unknown, refuse?: (code: string, message: string) => Error }} ports
 * @returns {{ version: 1, release: string | null, asOf: string, items: any[], idle: any[], landings: { lastHour: number, lastTwoHours: number } }}
 */
export function flowWhy(board, { store, workProgress, reviewEligibility, now, merged, release, policy = 'any', familyPolicy = 'off', familyRelaxAt, refuse = (code, message) => Object.assign(new Error(message), { code }) }) {
  const milestones = store.milestones(board);
  const focusName = store.lineSettings(board).focusMilestone;
  const selected = release ? milestones.find(row => row.name === release)
    : milestones.find(row => row.name === focusName) ?? milestones.find(row => !row.shipped) ?? null;
  if (release && !selected) throw refuse('NO_MILESTONE', `no release named ${release}; read pullboard roadmap`);
  const all = store.listItems(board, { all: true });
  const selectedIds = selected ? new Set(selected.items.filter(id => Number.isSafeInteger(id))) : null;
  const rows = all.filter(item => (!selectedIds || selectedIds.has(item.item_id)) && !item.item_merged_commit && item.item_status !== 'withdrawn');
  const seats = store.listAgents(board).filter(seat => seat.presence === 'live');
  const live = new Set(seats.map(seat => seat.agent_id));
  const progress = workProgress(board);
  const batches = store.landingBatches(board).filter(batch => !FINISHED_BATCH.has(batch.state));
  const at = now();
  const items = rows.map(item => {
    const state = progress.get(item.item_id);
    const batch = batches.find(candidate => candidate.items?.some(entry => entry.id === item.item_id));
    const value = { id: item.item_id, title: item.item_title, lane: item.item_lane };
    if (batch) return { ...value, cause: 'landing', batch: batch.id, minutes: minutesSince(batch.startedAt ?? batch.createdAt ?? batch.updatedAt, at) };
    if (item.item_status === 'submitted' && state?.holder) return { ...value, cause: 'reviewing', seat: state.holder };
    if (item.item_status === 'claimed' && state?.holder) return { ...value, cause: 'building', seat: state.holder, minutes: state.idleMinutes, basis: state.idleBasis };
    if (item.item_hold_reason) return { ...value, cause: 'held', reason: item.item_hold_reason };
    const laneHold = store.laneHold(board, item.item_lane);
    if (laneHold) return { ...value, cause: 'held', reason: laneHold.hold_reason };
    const waits = (state?.waits ?? []).filter(wait => wait.startsWith('#'));
    if (waits.length) return { ...value, cause: 'waiting', waits };
    if (item.item_status === 'submitted') {
      const reviewers = reviewEligibility(board, item, { policy, familyPolicy, familyRelaxAt });
      const eligible = reviewers.eligible.filter(id => live.has(id));
      return { ...value, cause: 'review', eligible, reason: eligible.length ? null : reviewers.ineligible.filter(row => live.has(row.agent)).map(row => `${row.agent}: ${row.rule}`).join('; ') || 'no live eligible reviewer' };
    }
    if (item.item_status === 'verified') return { ...value, cause: 'landing', batch: null, minutes: null };
    return { ...value, cause: 'free' };
  });
  const active = new Set(all.flatMap(item => {
    const state = progress.get(item.item_id);
    return state?.holder ? [state.holder] : [];
  }));
  const focus = milestones.find(row => row.name === focusName);
  const omitted = focus ? all.filter(item => !focus.items.includes(item.item_id)).map(item => item.item_id) : [];
  const idle = seats.filter(seat => !active.has(seat.agent_id)).map(seat => {
    const options = { agentId: seat.agent_id, lane: seat.agent_lane, policy, familyPolicy, familyRelaxAt, observeIdle: true };
    const build = store.nextFor(board, options);
    const review = store.nextFor(board, { ...options, verify: true });
    const focusBuild = focus ? store.nextFor(board, { ...options, omitIds: omitted }) : build;
    const focusReview = focus ? store.nextFor(board, { ...options, verify: true, omitIds: omitted }) : review;
    const eligible = focusBuild.item ?? focusReview.item;
    const reason = eligible ? 'work available' : focus && (build.item || review.item) ? 'overflow off' : 'nothing eligible';
    return { seat: seat.agent_id, lane: seat.agent_lane, reason, ...(eligible ? { item: eligible.item_id } : {}),
      ...(!eligible && !focus && (build.reasons?.length || review.reasons?.length) ? { detail: [...(build.reasons ?? []), ...(review.reasons ?? [])] } : {}) };
  });
  const landed = merged(board, new Date(at - 2 * HOUR_MS).toISOString()).filter(row => !selectedIds || selectedIds.has(row.item_id));
  return { version: 1, release: selected?.name ?? null, asOf: new Date(at).toISOString(), items, idle,
    landings: { lastHour: landed.filter(row => Date.parse(row.event_at) >= at - HOUR_MS).length, lastTwoHours: landed.length } };
}

/** Whole minutes since a timestamp; a missing or unreadable one stays unknown rather than zero. */
function minutesSince(value, at) {
  const then = Date.parse(value ?? '');
  return Number.isFinite(then) ? Math.max(0, Math.floor((at - then) / 60_000)) : null;
}
