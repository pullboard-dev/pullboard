import { AUTOMATIC_DISPATCH_ENGINE } from "../../../../state/light.js";
/** Durable work-health observations, separate from the person's decisions [A6,H16]. */
import { Refused } from "../../../../kernel/light.js";
import { CPU_SENTINEL_ENGINE } from "../../../../state/light.js";

/** The allocated engine for ordered sentinel observations; earlier moves keep their meaning. */
import { HEALTH_SENTINEL_ENGINE } from "../../../../state/light.js";
export { HEALTH_SENTINEL_ENGINE } from "../../../../state/light.js";

import { HEALTH_CAP_ENGINE } from "../../../../state/light.js";
export { HEALTH_CAP_ENGINE } from "../../../../state/light.js";

import { HEALTH_QUIET_ENGINE } from "../../../../state/light.js";

/** The most stuck or resolved notices one health run shouts one by one (#940). */
export const HEALTH_SHOUT_CAP = 10;

/** Pending CPU deliveries require an engine that can preserve their durable queue [A6,H16]. */
export function hasPendingCpuNotices(board) {
  if (!board) return false;
  const last = board.db.prepare("SELECT event_detail FROM event WHERE event_kind = 'health-scan' ORDER BY event_id DESC LIMIT 1").get();
  return Boolean(last && JSON.parse(last.event_detail).pendingCpu?.length);
}

/** A capped coordinator warning stays durable until a later ordinary sentinel scan can deliver it. */
export function hasPendingDispatchNotices(board) {
  if (!board) return false;
  const last = board.db.prepare("SELECT event_detail FROM event WHERE event_kind='health-scan' ORDER BY event_id DESC LIMIT 1").get();
  return Boolean(last && JSON.parse(last.event_detail).pendingDispatch?.length);
}

/** Validate and retain only the fields needed to identify and explain a health finding. */
export function normalizedHealthFindings(findings) {
  if (!Array.isArray(findings) || findings.length > 10_000) {
    throw new Refused('HEALTH_FINDINGS', 'a sentinel scan needs at most 10000 health findings; run pullboard health and retry the scan');
  }
  const seen = new Set();
  return findings.map(finding => {
    const text = key => typeof finding?.[key] === 'string' && finding[key].length > 0 && finding[key].length <= 8192;
    if (!['key', 'cause', 'subject', 'title', 'since', 'why', 'next'].every(text)
      || !/^[A-Z][A-Z0-9_]*$/u.test(finding.cause) || !Number.isFinite(Date.parse(finding.since))
      || finding.item !== null && (!Number.isSafeInteger(finding.item) || finding.item < 1)
      || seen.has(finding.key)) {
      throw new Refused('HEALTH_FINDINGS', 'a sentinel finding needs a unique key, cause, subject, time and next step; run pullboard health again');
    }
    const who = finding.owner?.who ?? finding.detail?.reviewer ?? finding.detail?.builder ?? finding.detail?.holder ?? null;
    if (who !== null && (typeof who !== 'string' || !who || who.length > 256)) {
      throw new Refused('HEALTH_FINDINGS', 'a sentinel finding needs its owner address; run pullboard health again');
    }
    seen.add(finding.key);
    return Object.fromEntries(['key', 'cause', 'item', 'subject', 'title', 'since', 'why', 'next'].map(key => [key, finding[key]]).concat([['owner', who]]));
  });
}

/** A new lease or owner is a new episode, even if no scan observed the intervening clear state. */
export function healthFindingIdentity(finding) {
  return JSON.stringify([finding.key, finding.since, finding.owner]);
}

/** Keep a whole owner address and the original cause and next step in each feed notice. */
export function healthFindingNotice(finding, resolved = false) {
  return `${resolved ? 'Resolved' : 'Stuck'}: ${finding.subject} ${finding.title} [${finding.cause}], since ${finding.since}. ${finding.why}. ${finding.owner ? `Owner: ${finding.owner}. ` : ''}Next: ${finding.next}.`;
}

/** The causes the coordinator hears whoever owns them: it rules on each (#1479). */
const COORDINATOR_CAUSES = new Set(["UNLANDED_CONFLICT", "UNLANDED_WAITING", "UNLANDED_READY", "UNLANDED_STACKED", "DECISION_UNANSWERED", "REQUEST_UNANSWERED", "STALE_ROW_DECISION"]);

/**
 * Who hears a finding: the coordinator, and its owner when the owner is a known address. From HEALTH_QUIET_ENGINE only the known owner
 * hears it, and the coordinator only when the owner is unknown or the cause is one the coordinator rules on. From HEALTH_CAP_ENGINE an
 * idle seat alone hears that it is idle, so a board of quiet seats never fills the coordinator's feed (#940).
 *
 * @param {{ cause: string, owner: string|null }} finding
 * @param {{ engine: number, coordinator: string, person: string, lanes: string[], agents: { agent_id: string }[] }} context
 * @returns {string[]}
 */
export function healthTargets(finding, { engine, coordinator, person, lanes, agents }) {
  const known = (who) => who === person || lanes.includes(who) || agents.some((agent) => agent.agent_id === who);
  const owner = finding.owner && known(finding.owner) ? finding.owner : null;
  if (engine >= HEALTH_QUIET_ENGINE && owner && !COORDINATOR_CAUSES.has(finding.cause)) return [owner];
  if (engine >= HEALTH_CAP_ENGINE && finding.cause === 'IDLE_AGENT' && owner) return [owner];
  return [...new Set([coordinator, ...(owner ? [owner] : [])])];
}

/**
 * Deliver one run's notices, resolved first: each finding's shouts, then its event, as earlier engines recorded them.
 * Every finding keeps its event. From HEALTH_CAP_ENGINE the run sends at most HEALTH_SHOUT_CAP shouts and one more to
 * the coordinator saying how many it held back, so a backfill never floods a feed (#940). From HEALTH_QUIET_ENGINE a
 * resolved finding is logged and shouted to no one; an earlier engine's run replays with its original shouts.
 *
 * @param {{ resolved: any[], added: any[], engine: number, coordinator: string, targets: (finding: any) => string[],
 *   shout: (to: string, text: string) => void, log: (finding: any, cleared: boolean) => void }} run
 */
export function deliverHealthNotices({ resolved, added, pending = [], engine, coordinator, targets, shout, log }) {
  const capped = engine >= HEALTH_CAP_ENGINE;
  const durableCpu = engine >= CPU_SENTINEL_ENGINE;
  const deferred = [];
  let sent = 0;
  let held = 0;
  for (const [finding, cleared, retry] of [...(durableCpu ? pending : []).map(entry => [entry, false, true]),
    ...resolved.map(entry => [entry, true, false]), ...added.map(entry => [entry, false, false])]) {
    let coordinatorSent = false;
    for (const to of cleared && engine >= HEALTH_QUIET_ENGINE ? [] : targets(finding)) {
      if (capped && sent >= HEALTH_SHOUT_CAP) { held += 1; continue; }
      shout(to, healthFindingNotice(finding, cleared));
      sent += 1;
      if (to === coordinator) coordinatorSent = true;
    }
    if (!cleared && !coordinatorSent && (durableCpu && finding.cause === 'AGENT_CPU'
      || engine >= AUTOMATIC_DISPATCH_ENGINE && finding.cause === 'UNPAIRED_WORK')) deferred.push(finding);
    if (!retry) log(finding, cleared);
  }
  if (held) shout(coordinator, `Health: ${held} more notices from this run were held back, so one run never floods a feed; pullboard health lists every finding.`);
  return durableCpu ? deferred : undefined;
}
