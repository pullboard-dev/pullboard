import { logEvent } from '../../../../store/index.js';
import { PERSON } from '../../../../store/index.js';
/** Person-owned machine exclusions carry key-free native provenance [H5,H17,B26]. */
import { repoInfo } from '../../../../git/index.js';
import { sameCommonDir } from '../../../../git/index.js';
import { readRelayMachine } from './machine.js';
import { updateRelayMachine } from './machine.js';
import { requirePersonChannel } from '../../../../person/index.js';
import { relayExcludeByBoard } from './canary/watch.js';

/**
 * The key an exclusion is stored under and every entry that counts as this board's exclusion.
 * Why: with relay.excludeByBoard on, every worktree of one board shares its commonDir key, and an older entry keyed by any
 * checkout root of that board is read as the board's own; off (default), the key stays the checkout root alone [C7,#9414].
 */
function exclusionKeys(root, state) {
  const info = repoInfo(root);
  if (!relayExcludeByBoard()) return { key: info.root, matching: [info.root] };
  const sameBoard = entry => {
    try { return sameCommonDir(repoInfo(entry).commonDir, info.commonDir); } catch { return false; }
  };
  return { key: info.commonDir, matching: [info.commonDir, ...state.excluded.filter(entry => !sameCommonDir(entry, info.commonDir) && sameBoard(entry))] };
}

/**
 * Read an exclusion without inferring a missing historical actor or timestamp [H5,H17].
 * A legacy entry has no recorded provenance, so its first observation is stored once and shown as first-seen, never as the exclusion time.
 */
export function relayExclusion(root) {
  const state = readRelayMachine();
  const project = exclusionKeys(root, state).matching.find(entry => state.excluded.includes(entry));
  if (project === undefined) return null;
  const detail = state.exclusionDetails?.[project];
  let firstSeenAt = detail?.firstSeenAt ?? null;
  if (!detail?.reason && !firstSeenAt) {
    firstSeenAt = new Date().toISOString();
    try {
      updateRelayMachine(next => {
        next.exclusionDetails ??= {};
        next.exclusionDetails[project] ??= {};
        next.exclusionDetails[project].firstSeenAt ??= firstSeenAt;
        firstSeenAt = next.exclusionDetails[project].firstSeenAt;
      });
    } catch { /* A read-only machine home still names the exclusion; the first-seen time is then not retained. */ }
  }
  return { reason: detail?.reason ?? 'unknown historical exclusion', at: detail?.at ?? null,
    by: detail?.by ?? null, path: detail?.path ?? null, eventId: detail?.eventId ?? null,
    ...(detail?.reason ? {} : { firstSeenAt }), next: 'pullboard relay on' };
}

/** Successful local unlink remains available to agents; only a person can persist an opt-out. */
export function excludeRelayByPerson(root, io, { localRecords }) {
  let channel;
  try { channel = requirePersonChannel(io.personChannel); }
  catch (error) { if (error.code === 'B26_PERSON_CHANNEL') return false; throw error; }
  const project = exclusionKeys(root, readRelayMachine()).key;
  // Record the intent first: a storage failure can leave a truthful request, never an unattributed exclusion.
  const receipt = localRecords(root, board => recordRelayExclusionIntent(board, channel));
  updateRelayMachine(state => {
    if (!state.excluded.includes(project)) state.excluded.push(project);
    state.exclusionDetails ??= {};
    state.exclusionDetails[project] = { reason: 'person relay off', path: 'relayOff',
      by: receipt.by, at: receipt.at, eventId: receipt.eventId };
  });
  return true;
}

/** Clear only this board's opt-out once a newly authorized link has actually finished. */
export function clearRelayExclusion(root) {
  return updateRelayMachine(state => {
    const { matching } = exclusionKeys(root, state);
    const existed = matching.some(entry => state.excluded.includes(entry));
    state.excluded = state.excluded.filter(entry => !matching.includes(entry));
    if (state.exclusionDetails) for (const entry of matching) delete state.exclusionDetails[entry];
    return existed;
  });
}

/** Explain a completed opt-in without hiding a separate fresh-board notice. */
export function reportClearedExclusion(result, io) {
  const notice = 'The exclusion was cleared; this board is linked again.';
  result.notice = [result.notice, notice].filter(Boolean).join(' ');
  io.err(notice);
}

/** Record the person request before settings persistence, so every durable opt-out cites its native intent. */
export function recordRelayExclusionIntent(board, channel) {
  requirePersonChannel(channel);
  logEvent(board, PERSON, 'relay_exclusion', null, { path: 'relayOff', reason: 'person relay off', channel, action: 'exclude' });
  return { by: board.lastEvent.event_by, at: board.lastEvent.event_at, eventId: board.lastEvent.event_id };
}

/** A pending authorized upload does not hide an exclusion which has not yet been cleared. */
export function withRelayExclusion(root, result) {
  if (result.excluded) return result;
  const exclusion = relayExclusion(root);
  return { ...result, ...(exclusion ? { excluded: true, exclusion } : {}) };
}
