import { allItemsNeedingRescope } from '../../../store/index.js';
import { landingBatches } from '../../../store/index.js';
import { flowWhy } from '../logic/flow.js';
import { shimLifecycle } from '../../../codemap/index.js';
import { rankInversionHistory } from './inversion.js';
import { readWorkFreeReleases } from '../../../stats/index.js';
import { landingFailureFindings } from './landing.js';
import { firstRefusal } from '../../../store/index.js';
import { compositionFamilyFallback } from '../../../verify/index.js';
import { reviewWait } from '../../../verify/index.js';
import { eligibilityProblem } from '../../../verify/index.js';
import { lineSettings } from '../../../state/light.js';
import { familyIndex } from '../../../verify/index.js';
import { unreviewableStrict } from '../../../verify/index.js';
import { withLocalSeatPresence } from '../../../store/index.js';
import { mechanicalConflictFiles } from '../../../merge/index.js';
import { localDependencyIds } from '../../../items/index.js';
import { dependencyLabel } from '../../../items/index.js';
import { itemFileCollisions } from '../../../items/index.js';
/**
 * `pullboard health`: every stuck item on the board, why it is stuck, since when, the one next step
 * and who takes it [A6]. Doctor checks a board's integrity; health checks its flow, so nobody has
 * to remember to look for a dead claim, an idle review or accepted work that never landed.
 *
 * It reads the board through a read-only SQLite connection and asks git only questions that leave
 * every checkout alone: merge-tree writes a tree object and never an index or a working tree.
 */
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { machineHome } from '../../../resources/index.js';
import { runnerRecoveryStatus } from '../../../resources/index.js';
import { missedJobFindings } from '../../../store/index.js';
import {
  COORDINATOR,
  durationMs,
} from '../../../config/index.js';
import {
  mainCheckout,
  tryGit,
} from '../../../git/index.js';
import { gateControlFindings } from '../../../gate/index.js';
import { boardBusyError } from '../../../store/index.js';
import { buildOrder } from '../../../store/index.js';
import { nextFor } from '../../../store/index.js';
import { foreignBlockers } from '../../../store/index.js';
import { milestonePriorities } from '../../../store/index.js';
import { milestones } from '../../../store/index.js';
import { canTake } from '../../../store/index.js';
import { listItems } from '../../../store/index.js';
import { itemById } from '../../../store/index.js';
import { laneHold } from '../../../store/index.js';
import { reviewHolder } from '../../../store/index.js';
import { listAgents } from '../../../store/index.js';
import { openBoardReadOnly } from '../../../store/index.js';
import { readBoardSnapshot } from '../../../store/index.js';
import { PERSON } from '../../../store/index.js';
import { ROUTES } from '../../../store/index.js';
import { rowDecisions } from '../../../store/index.js';
import { unverifiedSubmissions } from '../../../store/index.js';
import { roadmap } from '../../../store/index.js';
import { staleRowDecisions } from '../../../spec/index.js';
import { localReleaseRank } from '../../../landing/index.js';
import { workQueue } from '../../../items/index.js';
import { trunkRef } from '../../../sandbox/index.js';
import { routeWorkShortages } from '../../../seats/index.js';
import { readRelayHealth } from '../../../link/index.js';

/** Each threshold's pullboard.json key under "health" and its default. */
export const HEALTH_DEFAULTS = Object.freeze({ stuck: '1h', holds: '1d', release: '1d' });

/** Moves that start or end an item's wait, in the order the event log records them. */
const LIFECYCLE = new Set(['add', 'claim', 'release', 'submit', 'accept', 'reject', 'reopen', 'refreeze', 'escalate', 'withdraw']);

/**
 * Read the thresholds from pullboard.json's "health" group, each a duration like 90m, 2h or 1d.
 *
 * @param {any} config
 * @returns {{ stuck: string, holds: string, release: string, ms: { stuck: number, holds: number, release: number } }}
 */
export function healthThresholds(config = {}) {
  const raw = config?.health ?? {};
  const chosen = { ...HEALTH_DEFAULTS, ...(raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {}) };
  const ms = Object.fromEntries(Object.keys(HEALTH_DEFAULTS).map((key) => [key, durationMs(chosen[key], `health.${key}`)]));
  return { stuck: chosen.stuck, holds: chosen.holds, release: chosen.release, ms };
}

/**
 * Scan a board file read-only. A missing board has nothing on it, so nothing is stuck.
 *
 * @param {string} file
 * @param {{ root: string, config?: any, now: Date, dispatchHealth: Function }} options Explicit upper-layer dispatch observation.
 * @returns {ReturnType<typeof healthReport>}
 */
export function boardHealth(file, { root, config, now, dispatchHealth, machineSettings }) {
  if (!existsSync(file)) return healthReport({ db: null, root, config, now, dispatchHealth, machineSettings });
  const startedAt = Date.now();
  let db;
  try {
    db = openBoardReadOnly(file);
    return healthReport({ db, root, config, now, dispatchHealth, machineSettings });
  } catch (error) {
    throw boardBusyError(file, startedAt, error);
  } finally {
    db?.close();
  }
}

/**
 * Every stuck finding on an open board connection, and the rework that waits for a later release.
 *
 * @param {{ db: any, root: string, config?: any, now: Date, dispatchHealth: Function }} options Explicit upper-layer dispatch observation.
 * @returns {{ asOf: string, thresholds: { stuck: string, holds: string, release: string }, stuck: Finding[], waiting: Finding[] }}
 */
export function healthReport({ db, root, config, now, dispatchHealth, machineSettings }) {
  const limits = healthThresholds(config);
  const asOf = now.toISOString();
  const report = { asOf, thresholds: { stuck: limits.stuck, holds: limits.holds, release: limits.release }, stuck: [], waiting: [] };
  // Gate alarms read the git directory, so they report even before a board exists (U41).
  report.stuck.push(...gateControlFindings(root, config ?? {}, now));
  report.stuck.push(...unavailableRunnerFindings(now));
  const canary = readRelayHealth(root);
  if (typeof canary.alertSince === 'string' && Number.isFinite(Date.parse(canary.alertSince))) {
    const step = typeof canary.step === 'string' ? canary.step : 'unknown';
    const code = typeof canary.code === 'string' ? canary.code : 'RELAY_CANARY_FAILURE';
    const slow = canary.p95Ms !== null && canary.p95Ms > 2000;
    const why = slow ? `Ten-minute p95 is ${Math.round(canary.p95Ms)} ms`
      : canary.consecutiveFailures >= 2 ? `The last canary probe failed during ${step} (${code})`
        : `The relay canary alert remains active; the latest recorded step is ${step} (${code})`;
    report.stuck.push(finding('RELAY_CANARY', null, {
      subject: 'relay canary', key: 'RELAY_CANARY:relay', since: canary.alertSince, now: now.getTime(),
      title: 'sealed round trips are degraded',
      why,
      next: 'inspect pullboard relay canary; keep working locally while queued moves await the relay',
      owner: { role: 'coordinator', who: COORDINATOR }, detail: { step, code, roundTripMs: canary.roundTripMs, p95Ms: canary.p95Ms },
    }));
  }
  const settings = machineSettings;
  if (settings?.gate?.loadAwareDispatch === true) {
    const fresh = (settings.runners ?? []).filter(runner => {
      const age = now.getTime() - Date.parse(runner.cpuLoad?.at);
      return Number.isFinite(age) && age >= 0 && age <= 30_000;
    });
    report.runnerCpu = { ceiling: settings.gate?.runnerBusyCeiling ?? 90,
      readings: fresh.map(runner => ({ host: runner.host, ...runner.cpuLoad })),
      spread: fresh.length ? Math.max(...fresh.map(runner => runner.cpuLoad.busyPercent)) - Math.min(...fresh.map(runner => runner.cpuLoad.busyPercent)) : null,
      note: fresh.length ? 'Recent runner-reported CPU busy percentages; incompatible and full runners remain excluded at dispatch' : 'No fresh runner CPU readings; dispatch falls back to free slots' };
    if (fresh.some(runner => runner.cpuLoad.busyPercent >= report.runnerCpu.ceiling) && fresh.some(runner => runner.cpuLoad.busyPercent < report.runnerCpu.ceiling)) report.stuck.push(finding('RUNNER_CPU_SPREAD', null, {
      subject: 'runner CPU load', key: 'RUNNER_CPU_SPREAD:machine', since: fresh.map(runner => runner.cpuLoad.at).sort()[0], now: now.getTime(),
      title: `runner CPU busy spread is ${Math.round(report.runnerCpu.spread)} percentage points`,
      why: fresh.map(runner => `${runner.host}: ${Math.round(runner.cpuLoad.busyPercent)}% busy, load ${runner.cpuLoad.average[0]}`).join('; '),
      next: 'let measured dispatch prefer compatible quieter runners; inspect runner health if the spread persists',
      owner: { role: 'coordinator', who: COORDINATOR }, detail: report.runnerCpu,
    }));
  }
  if (!db) return report;
  report.workFreeReleases = readWorkFreeReleases(db);
  if (typeof dispatchHealth !== 'function') throw new TypeError('healthReport requires its dispatchHealth observation port');
  const at = now.getTime();
  report.stuck.push(...landingFailureFindings({ db, clock: { now: () => now } }, now));
  const age = (iso) => at - Date.parse(iso);
  const board = { ...readBoardSnapshot(db, { now: () => now }), familyAliases: familyIndex(config?.families) };
  report.stuck.push(...missedJobFindings(board, at), ...dispatchHealth(board, config).findings);
  for (const stale of staleRowDecisions(rowDecisions(board), root, config)) {
    report.stuck.push(finding('STALE_ROW_DECISION', null, {
      subject: `${stale.kind}:${stale.id}`, key: `STALE_ROW_DECISION:${stale.kind}:${stale.id}`,
      since: stale.at ?? asOf, now: at, title: 'person decision is stale', why: stale.why, next: stale.next,
      owner: { role: 'person', who: PERSON }, detail: { changed: stale.changed },
    }));
  }
  const items = db.prepare('SELECT * FROM item ORDER BY item_id').all();
  const shimMaxAgeDays = config?.cells?.shimMaxAgeDays ?? 7;
  report.shims = shimLifecycle(root, { commit: trunkTip(root)?.commit ?? 'HEAD', items });
  for (const shim of report.shims) {
    if (!shim.moveLandedAt || at - Date.parse(shim.moveLandedAt) <= shimMaxAgeDays * 86_400_000) continue;
    report.stuck.push(finding('CELL_SHIM_OVERDUE', null, {
      subject: shim.path, key: `CELL_SHIM_OVERDUE:${shim.path}`, since: shim.moveLandedAt, now: at,
      title: `${shim.cell} compatibility shim exceeds ${shimMaxAgeDays} days`,
      why: `${shim.path} remains after the ${shim.cell} move landed on ${shim.moveLandedAt}`,
      next: shim.removalItem ? `finish shim removal item #${shim.removalItem}` : 'coordinator: file a shim removal item naming this path',
      owner: { role: 'coordinator', who: COORDINATOR }, detail: shim,
    }));
  }
  const byId = new Map(items.map((item) => [item.item_id, item]));
  for (const entry of allItemsNeedingRescope(board)) {
    const item = byId.get(entry.id);
    report.stuck.push(finding('NEEDS_RESCOPE', item, {
      key: `NEEDS_RESCOPE:item:${entry.id}:${entry.lane}:${entry.route}`,
      since: entry.since, now: at, title: 'needs re-scope',
      why: `${entry.lane} at the ${entry.route} route cannot build it as scoped: ${entry.reasons.join('; ')}`.slice(0, 8192),
      next: `edit, refreeze or re-route #${entry.id}, or land its named blockers`,
      owner: { role: 'coordinator', who: COORDINATOR }, detail: entry,
    }));
  }

  const history = itemHistory(db, items.map((item) => item.item_id));
  const trunk = trunkTip(root);
  const releases = roadmap(board);
  const found = (list, finding) => list.push(finding);
  let stacks;
  let presence;
  /** Read local liveness once per scan; the ordered health receipt retains the observation. */
  const seats = () => (presence ??= new Map(listAgents(board).map(seat => [seat.agent_id, seat])));
  /** Load the unverified submitted heads once, only when an accepted item needs them. */
  const stacked = () => (stacks ??= unverifiedSubmissions(board));

  for (const item of items) {
    const id = item.item_id;
    const events = history.get(id) ?? { last: new Map(), lifecycle: null };
    const status = item.item_status;
    if (status === 'withdrawn' || (status === 'verified' && item.item_merged_commit)) continue;
    let holdReported = false;

    if (status === 'claimed' && (item.item_lease_until ?? '') <= asOf) {
      const holder = item.item_owner;
      found(report.stuck, finding('CLAIM_LAPSED', item, {
        since: item.item_lease_until ?? item.item_updated_at, now: at,
        title: 'claim lapsed',
        why: `${holder}'s lease ran out and nobody is building it`,
        next: `renew it with pullboard claim ${id}`, command: `pullboard claim ${id}`,
        owner: { role: 'builder', who: holder }, detail: { holder },
      }));
    }

    const released = events.last.get('release');
    const expiry = released ? JSON.parse(released.event_detail) : null;
    const refusal = status === 'open' && expiry?.expiredClaim ? firstRefusal(board, id) : null;
    if (refusal) found(report.waiting, finding('CLAIM_EXPIRED', item, {
      since: released.event_at, now: at, title: 'lapsed idle claim freed',
      why: `${expiry.expiredClaim.holder}'s lapsed claim returned to open; first refusal lasts until ${refusal.until}`,
      next: `${refusal.builder} resumes with pullboard claim ${id}, or releases its first refusal`,
      command: `pullboard claim ${id}`, owner: { role: 'builder', who: refusal.builder },
      detail: { ...expiry.expiredClaim, firstRefusalUntil: refusal.until },
    }));

    if (status === 'submitted') {
      const fallback = compositionFamilyFallback(board, item);
      if (fallback) found(report.waiting, finding('REVIEW_FAMILY_FALLBACK', item, {
        since: events.last.get('submit')?.event_at ?? item.item_updated_at, now: at,
        title: 'independent family review', why: `Current composition spans the joined families; owner ${fallback.owner} (${fallback.family}) sets the different-family boundary; all material author and session exclusions remain`,
        next: 'an independent seat from another family takes the review', command: `pullboard next --verify ${id}`,
        owner: { role: 'builder', who: fallback.owner }, detail: fallback,
      }));
      const reviewer = item.item_review_by;
      const lapsed = reviewer && (item.item_review_until ?? '') <= asOf;
      const submittedAt = events.last.get('submit')?.event_at ?? item.item_updated_at;
      if (lapsed) {
        found(report.stuck, finding('REVIEW_LAPSED', item, {
          since: item.item_review_until ?? submittedAt, now: at,
          title: 'review lapsed',
          why: `${reviewer} reserved its review and the reservation ran out with no verdict`,
          next: `take the review with pullboard next --verify ${id}`, command: `pullboard next --verify ${id}`,
          owner: { role: 'reviewer', who: null }, detail: { reviewer, commit: item.item_commit },
        }));
      } else if (!reviewer) {
        const blocked = unreviewableStrict(board, item, { policy: config?.verify?.policy, familyPolicy: config?.verify?.family }, { listAgents });
        if (blocked) found(report.stuck, finding('NO_ELIGIBLE_REVIEWER', item, {
          since: submittedAt, now: at,
          title: 'no seat can review',
          why: blocked.message,
          next: blocked.fix, command: `pullboard show ${id}`,
          owner: { role: 'coordinator', who: COORDINATOR }, detail: { builder: item.item_built_by, undeclared: blocked.undeclared, excluding: blocked.excluding },
        }));
      }
      const wait = reviewWait(board, item, { reviewHolder });
      if (wait && wait.ageMs > (config?.review?.starveMinutes ?? 5) * 60_000) {
        const exclusions = [...seats().values()].map(agent => ({ agent: agent.agent_id,
          problem: eligibilityProblem(board, item, agent, { policy: config?.verify?.policy, familyPolicy: config?.verify?.family }) }));
        const eligible = exclusions.filter(entry => !entry.problem).map(entry => entry.agent);
        const excluding = exclusions.filter(entry => entry.problem).map(entry => ({ agent: entry.agent, code: entry.problem.code, rule: entry.problem.message }));
        found(report.stuck, finding('REVIEW_STARVED', item, {
          since: wait.since, now: at, title: 'review starved',
          why: eligible.length ? `submitted ${Math.floor(wait.ageMs / 60_000)} minutes ago without a live reviewer`
            : `no joined agent is eligible: ${excluding.map(entry => `${entry.agent}: ${entry.code}`).join('; ') || 'no joined agents'}`,
          next: eligible.length ? `an eligible idle agent takes pullboard next before new build work` : `inspect the eligibility checks with pullboard show ${id}`,
          command: `pullboard show ${id}`, owner: { role: 'coordinator', who: COORDINATOR },
          detail: { ageMs: wait.ageMs, eligible, excluding },
        }));
      }
      if (!lapsed && !reviewer && age(submittedAt) >= limits.ms.stuck) {
        found(report.stuck, finding('NO_REVIEWER', item, {
          since: submittedAt, now: at,
          title: 'no reviewer',
          why: `${item.item_built_by} submitted ${short(item.item_commit)} and nobody has reserved its review`,
          next: `reserve a reviewer outside ${item.item_built_by}'s controller and session for the review`,
          command: `pullboard shout all "#${id} needs a reviewer outside ${item.item_built_by}'s controller and session"`,
          owner: { role: 'coordinator', who: COORDINATOR }, detail: { builder: item.item_built_by, commit: item.item_commit },
        }));
      }
    }

    if (status === 'verified') {
      const acceptedAt = events.last.get('accept')?.event_at ?? item.item_updated_at;
      if (age(acceptedAt) >= limits.ms.stuck) {
        found(report.stuck, unlanded(item, { since: acceptedAt, now: at, trunk, root, byId, stacked }));
        holdReported = Boolean(item.item_hold_reason);
      }
    }

    if (status === 'open' && !item.item_hold_reason && ['reject', 'reopen'].includes(events.lifecycle?.event_kind)) {
      const move = events.lifecycle;
      const returnedReject = move.event_kind === 'reject';
      const inactive = returnedReject && seats().get(item.item_built_by)?.presence !== 'live';
      const timedOut = returnedReject && age(move.event_at) >= 600_000;
      if (inactive || timedOut) {
        const note = db.prepare("SELECT verdict_note FROM verdict WHERE item_id=? AND verdict_decision='REJECT' ORDER BY verdict_id DESC LIMIT 1").get(id)?.verdict_note ?? '';
        found(report.stuck, finding('REWORK_UNCLAIMED', item, {
          since: move.event_at, now: at, title: 'rejected work needs another builder',
          why: `rejected by ${move.event_by}${rejectReason(move)}: ${note}; ${inactive ? 'its builder is not live' : 'no builder reclaimed it within ten minutes'}`,
          next: 'return it to the builder queue with pullboard sentinel run --health-only', command: 'pullboard sentinel run --health-only',
          owner: { role: 'coordinator', who: COORDINATOR },
          detail: { move: 'reject', by: move.event_by, rejection: move.event_id, builder: item.item_built_by, commit: item.item_commit, reason: inactive ? 'inactive' : 'timeout',
            presence: seats().get(item.item_built_by)?.presence ?? 'gone', heartbeatAt: seats().get(item.item_built_by)?.heartbeatAt ?? null, observedAt: asOf },
        }));
      } else if (!returnedReject && age(move.event_at) >= limits.ms.stuck) {
        const rank = localReleaseRank(releases, id);
        const later = rank > 0 && rank < releases.length;
        const builder = item.item_built_by;
        const owner = builder ? { role: 'builder', who: builder } : { role: 'builder', who: item.item_lane };
        const reason = move.event_kind === 'reject' ? `rejected by ${move.event_by}${rejectReason(move)}` : `reopened by ${move.event_by}`;
        const milestone = later ? releases[currentRelease(releases) + rank]?.name : null;
        found(later ? report.waiting : report.stuck, finding(later ? 'REWORK_LATER' : 'REWORK_UNCLAIMED', item, {
          since: move.event_at, now: at,
          title: later ? 'rework waits for a later release' : 'rework unclaimed',
          why: later ? `${reason}; it is planned for ${milestone}, after the current release` : `${reason} and nobody has claimed it since`,
          next: `claim it with pullboard claim ${id}`, command: `pullboard claim ${id}`,
          owner, detail: { move: move.event_kind, by: move.event_by, ...(later ? { milestone } : {}) },
        }));
      }
    }

    if (['open', 'claimed', 'submitted'].includes(status)) {
      const after = localDependencyIds(item);
      const gone = after.filter((other) => byId.get(other)?.item_status === 'withdrawn');
      if (gone.length) {
        const rest = after.filter((other) => !gone.includes(other));
        const first = byId.get(gone[0]);
        const since = history.get(gone[0])?.last.get('withdraw')?.event_at ?? first.item_updated_at;
        found(report.stuck, finding('AFTER_WITHDRAWN', item, {
          since, now: at,
          title: 'waits on withdrawn work',
          why: `it waits on ${gone.map((other) => `#${other}`).join(', ')}, withdrawn: ${firstLine(first.item_withdrawn_reason)}`,
          next: `drop the wait with pullboard edit ${id} --after ${rest.join(',') || 'none'}`,
          command: `pullboard edit ${id} --after ${rest.join(',') || 'none'}`,
          owner: { role: 'coordinator', who: COORDINATOR }, detail: { withdrawn: gone },
        }));
      }
    }

    if (item.item_hold_reason && !holdReported) {
      const holder = item.item_hold_by ?? COORDINATOR;
      const owner = holder === PERSON ? { role: 'person', who: PERSON } : { role: 'coordinator', who: holder };
      const clears = /conflict/iu.test(item.item_hold_reason) && item.item_commit && trunk
        && conflictFiles(root, trunk.commit, item.item_commit)?.length === 0;
      if (clears || age(item.item_hold_at) >= limits.ms.holds) {
        found(report.stuck, finding(clears ? 'CONFLICT_HOLD_CLEARS' : 'HOLD_STALE', item, {
          since: item.item_hold_at, now: at,
          title: clears ? 'conflict hold now clears' : 'hold left on',
          why: clears
            ? `${holder} held it for a conflict (${firstLine(item.item_hold_reason)}), and ${short(item.item_commit)} now merges cleanly onto ${trunk.name}`
            : `${holder} held it: ${firstLine(item.item_hold_reason)}`,
          next: `lift the hold with pullboard hold ${id} --off`, command: `pullboard hold ${id} --off`,
          owner, detail: { reason: item.item_hold_reason, by: holder },
        }));
      }
    }
  }

  for (const hold of db.prepare('SELECT * FROM hold ORDER BY hold_lane').all()) {
    if (age(hold.hold_at) < limits.ms.holds) continue;
    const owner = hold.hold_by === PERSON ? { role: 'person', who: PERSON } : { role: 'coordinator', who: hold.hold_by };
    found(report.stuck, finding('HOLD_STALE', null, {
      subject: `lane ${hold.hold_lane}`, key: `HOLD_STALE:lane:${hold.hold_lane}`,
      since: hold.hold_at, now: at,
      title: 'hold left on',
      why: `${hold.hold_by} held the ${hold.hold_lane} lane: ${firstLine(hold.hold_reason)}`,
      next: `lift the hold with pullboard hold ${hold.hold_lane} --off`, command: `pullboard hold ${hold.hold_lane} --off`,
      owner, detail: { lane: hold.hold_lane, reason: hold.hold_reason, by: hold.hold_by },
    }));
  }

  for (const ask of unansweredAsks(db)) {
    if (age(ask.shout_at) < limits.ms.stuck) continue;
    const toPerson = ask.shout_to === PERSON;
    const request = Boolean(ask.shout_request);
    const command = request ? `pullboard answer ${ask.shout_id} done <what you did>`
      : toPerson ? `pullboard answer ${ask.shout_id} "..." --as person` : `pullboard answer ${ask.shout_id} "..."`;
    found(report.stuck, finding(request ? 'REQUEST_UNANSWERED' : 'DECISION_UNANSWERED', null, {
      subject: `${request ? 'request' : 'decision'} #${ask.shout_id}`, key: `${request ? 'REQUEST_UNANSWERED' : 'DECISION_UNANSWERED'}:shout:${ask.shout_id}`,
      since: ask.shout_at, now: at,
      title: 'unanswered',
      why: `${ask.shout_from} asked ${toPerson ? 'the person' : 'the coordinator'}: ${clip(firstLine(ask.shout_text))}`,
      next: toPerson ? `answer it in the view, or with ${command}` : `answer it with ${command}`,
      command,
      owner: toPerson ? { role: 'person', who: PERSON } : { role: 'coordinator', who: COORDINATOR },
      detail: { shout: ask.shout_id, from: ask.shout_from, to: ask.shout_to },
    }));
  }

  report.retired = [];
  for (const fault of queueFaults(board, { items, at, retired: report.retired, gone: goneWorktrees(root) })) report.stuck.push(fault);

  const overdue = releaseOverdue(db, root, at, limits.ms.release, history);
  if (overdue) found(report.stuck, overdue);
  return report;
}

/** Report hosts still unavailable after thirty minutes from the read-only machine queue. */
function unavailableRunnerFindings(now) {
  const file = join(machineHome(), 'resources.sqlite');
  if (!existsSync(file)) return [];
  let queue;
  try {
    queue = new DatabaseSync(file, { readOnly: true });
    return queue.prepare('SELECT host,since,detail,failure FROM runner_unavailable').all()
      .filter(row => Number.isFinite(Date.parse(row.since)) && now.getTime() - Date.parse(row.since) >= 1_800_000)
      .map(row => finding('RUNNER_UNAVAILABLE', null, {
        subject: row.host, key: `RUNNER_UNAVAILABLE:${row.host}`, since: row.since, now: now.getTime(),
        title: `runner ${row.host} unavailable over 30 minutes`,
        why: `${row.host} remains unavailable (${row.detail}); ${runnerRecoveryStatus(row.failure).reason}`,
        next: `inspect ${row.host}'s recorded recovery probe and restore it only after no job is running and its root is writable`,
        owner: { role: 'coordinator', who: COORDINATOR },
        detail: { host: row.host, reason: row.detail, recovery: runnerRecoveryStatus(row.failure) },
      }));
  } catch { return []; }
  finally { queue?.close(); }
}

/** An agent with no claim, review or event for this long is idle, not active; its own submitted work awaits review, so it is not idle (N2). */
const QUEUE_ACTIVE_MS = 30 * 60_000;

/**
 * The queue faults the board can see: a route with open current work that no active agent can take,
 * an open item no active agent in its lane can take, an idle agent beside work it could take, and a
 * claim that ranks behind a free item its holder could take (N2, B13). The queue (workQueue) and the
 * board's buildOrder supply the order, so health and pullboard queue cannot disagree. Each finding
 * names the item and the next step; an agent that is idle is named as its own owner.
 *
 * @param {{ db: any, clock: { now: () => Date } }} board
 * @param {{ items: any[], at: number, retired?: any[], gone?: Set<string> }} context - the board's items, the clock in epoch milliseconds,
 *   the list that collects retired seats, and the worktree paths Git reports gone
 * @returns {Finding[]}
 */
function queueFaults(board, { items, at, retired = [], gone = new Set() }) {
  const queue = workQueue(board, { buildOrder, canTake, listItems, milestonePriorities, milestones, roadmap, ROUTES, foreignBlockers, eligibilityProblem }, null, {}, { itemById, laneHold, localDependencyIds, dependencyLabel, itemFileCollisions });
  const current = (queue.releases.find((release) => release.landed < release.total)?.items ?? queue.unreleased)
    .filter((entry) => entry.status === 'open' && !entry.waits.length);
  const waiting = [...queue.releases.flatMap((release) => release.items), ...queue.unreleased]
    .filter((entry) => entry.status === 'open' && !entry.waits.length);
  const rows = board.db.prepare(`SELECT agent_id AS id, agent_lane AS lane, agent_route AS route, agent_path AS path, agent_created_at AS created,
    (SELECT MAX(event_at) FROM event WHERE event_by = agent.agent_id) AS event_at,
    (SELECT MAX(event_at) FROM event WHERE event_by = agent.agent_id AND event_kind IN ('claim', 'renew', 'reserve')) AS pulled_at,
    (SELECT MAX(shout_at) FROM shout WHERE shout_from = agent.agent_id) AS shout_at
    FROM agent ORDER BY agent_id`).all();
  // Only a seat whose agent is around counts (#940): a live lease, or a move or shout in the last 30 minutes, and not
  // a worktree Git reports gone. Every other seat is retired for these checks: listed once, never a finding.
  const localPresence = lineSettings(board)['route.liveOnly']
    ? new Map(withLocalSeatPresence(board, rows.map(row => ({ agent_id: row.id }))).map(seat => [seat.agent_id, seat.presence])) : null;
  const agents = rows.filter((row) => row.lane !== 'coordinator').map((row) => {
    const last = Math.max(...[row.created, row.event_at, row.shout_at].filter(Boolean).map((value) => Date.parse(value)));
    const lease = items.some((item) => (item.item_status === 'claimed' && item.item_owner === row.id && Date.parse(item.item_lease_until ?? '') > at)
      || (item.item_review_by === row.id && Date.parse(item.item_review_until ?? '') > at));
    const awaitsReview = items.some((item) => item.item_status === 'submitted' && item.item_built_by === row.id);
    const recent = !gone.has(row.path) && (localPresence ? localPresence.get(row.id) === 'live' : lease || at - last < QUEUE_ACTIVE_MS);
    const pulled = Math.max(...[row.created, row.pulled_at].filter(Boolean).map((value) => Date.parse(value)));
    const idle = recent && !lease && !awaitsReview && at - pulled >= QUEUE_ACTIVE_MS;
    return { ...row, last, recent, idle, idleSince: idle ? new Date(pulled + QUEUE_ACTIVE_MS).toISOString() : null };
  });
  const active = agents.filter((agent) => agent.recent);
  retired.push(...agents.filter((agent) => !agent.recent).map((agent) => ({ agent: agent.id, lane: agent.lane, since: new Date(agent.last).toISOString() })));
  const raw = new Map(items.map((item) => [item.item_id, item]));
  // An item whose claim lapsed is CLAIM_LAPSED's to report; it never doubles as untakeable work (#940).
  const lapsed = (entry) => raw.get(entry.id)?.item_status === 'claimed';
  const since = (id) => raw.get(id)?.item_updated_at ?? new Date(at).toISOString();
  const now = at;
  const findings = [];

  for (const shortage of routeWorkShortages(board, waiting, agents, { firstRefusal })) {
    const { route, free, idle, since } = shortage;
    findings.push(finding('ROUTE_WORK_SHORTAGE', null, {
      subject: `${route} route`, key: `ROUTE_WORK_SHORTAGE:route:${route}:free:${free}:idle:${idle}`, since, now,
      title: 'needs more free work',
      why: `${free} free items can be taken by ${idle} idle seats at the ${route} route`,
      next: `split more items for the ${route} route so its idle agents have work they can take`,
      owner: { role: 'coordinator', who: COORDINATOR }, detail: { route, free, idle },
    }));
  }

  for (const route of ROUTES) {
    const open = current.filter((entry) => entry.route === route && !lapsed(entry));
    if (!open.length || active.some((agent) => canTake(agent.route, route))) continue;
    const first = open[0];
    findings.push(finding('ROUTE_UNSERVED', null, {
      subject: `${route} route`, key: `ROUTE_UNSERVED:route:${route}`, since: since(first.id), now,
      title: 'route has no active agent',
      why: `${open.length} open ${route} ${open.length === 1 ? 'item waits' : 'items wait'}, starting with #${first.id}, and no active agent can take ${route} work`,
      next: `start an agent on the ${route} route: in a shell with PULLBOARD_MODEL set, run pullboard worktree ${first.lane} --route ${route}`,
      command: `pullboard worktree ${first.lane} --route ${route}`,
      owner: { role: 'coordinator', who: COORDINATOR }, detail: { route, items: open.map((entry) => entry.id) },
    }));
  }

  for (const entry of waiting.filter((candidate) => !lapsed(candidate))) {
    if (active.some((agent) => agent.lane === entry.lane && canTake(agent.route, entry.route))) continue;
    findings.push(finding('ITEM_UNTAKEABLE', raw.get(entry.id) ?? null, {
      subject: `#${entry.id}`, key: `ITEM_UNTAKEABLE:item:${entry.id}`, since: since(entry.id), now,
      title: 'nobody can take it',
      why: `no active agent in the ${entry.lane} lane can take a ${entry.route} item, so #${entry.id} waits: ${entry.title}`,
      next: `start an agent in the ${entry.lane} lane on the ${entry.route} route: in a shell with PULLBOARD_MODEL set, run pullboard worktree ${entry.lane} --route ${entry.route}`,
      command: `pullboard worktree ${entry.lane} --route ${entry.route}`,
      owner: { role: 'coordinator', who: COORDINATOR }, detail: { lane: entry.lane, route: entry.route },
    }));
  }

  for (const agent of agents.filter((candidate) => candidate.idle)) {
    const work = waiting.find((entry) => entry.lane === agent.lane && canTake(agent.route, entry.route));
    if (!work) continue;
    findings.push(finding('IDLE_AGENT', null, {
      subject: agent.id, key: `IDLE_AGENT:agent:${agent.id}`, since: new Date(agent.last).toISOString(), now,
      title: 'idle beside work it could take',
      why: `${agent.id} has held no claim or review and pulled nothing for 30 minutes, while #${work.id} waits in ${agent.lane} and it could take it`,
      next: `run pullboard next in ${agent.path}`, command: 'pullboard next',
      owner: { role: 'builder', who: agent.id }, detail: { lane: agent.lane, route: agent.route, item: work.id },
    }));
  }

  const open = [...queue.releases.flatMap((release) => release.items), ...queue.unreleased].filter((entry) => entry.status === 'open');
  /** A returned repair belongs with its still-active last builder, not a different occupied holder. */
  const reworkBuilder = item => {
    const last = board.db.prepare("SELECT event_kind FROM event WHERE item_id=? AND event_kind IN ('reject','reopen','submit') ORDER BY event_id DESC LIMIT 1").get(item.item_id);
    return last?.event_kind === 'reject' ? active.find(agent => agent.id === item.item_built_by && agent.lane === item.item_lane && canTake(agent.route, item.item_route)) : null;
  };
  const returned = new Set();
  const rankedWhenClaimed = rankInversionHistory(board);

  // A lapsed claim is CLAIM_LAPSED's to report; only a live claim can rank behind free work.
  for (const claim of items.filter((item) => item.item_status === 'claimed' && Date.parse(item.item_lease_until ?? '') > at)) {
    const holder = agents.find((agent) => agent.id === claim.item_owner);
    if (!holder) continue;
    const claimEvent = board.db.prepare("SELECT MAX(event_id) AS id FROM event WHERE item_id=? AND event_by=? AND event_kind='claim'").get(claim.item_id, holder.id)?.id;
    const proved = claimEvent && board.db.prepare(`SELECT 1 FROM event WHERE event_id>? AND event_by=? AND
      ((item_id=? AND event_kind='proof-run') OR (event_kind='gate-run' AND json_extract(event_detail,'$.run.proof.item')=?)) LIMIT 1`)
      .get(claimEvent, holder.id, claim.item_id, claim.item_id);
    if (proved) continue;
    // Model exactly the release printed below: legal child or returned claims remain occupied.
    const releasedClaims = [claim.item_id];
    const compare = buildOrder(board, { releasedClaims, agentId: holder.id, tierFirst: true });
    const offered = nextFor(board, { agentId: holder.id, lane: holder.lane, afterRelease: claim.item_id }).item;
    // Historical hard-collision waits clear only when this one named claim is released (#1114).
    const freeToHolder = (entry) => entry.waits.every((wait) => wait.startsWith(`#${entry.id} waits for #${claim.item_id} (claimed) on `));
    const ahead = open.filter((entry) => freeToHolder(entry) && entry.lane === holder.lane && canTake(holder.route, entry.route))
      .map((entry) => raw.get(entry.id))
      .filter((item) => item && compare(item, claim) < 0 && rankedWhenClaimed(claim, item))
      .filter(item => {
        const builder = reworkBuilder(item);
        if (!builder) return true;
        if (!returned.has(item.item_id)) {
          returned.add(item.item_id);
          findings.push(finding('IDLE_AGENT', item, {
            subject: builder.id, key: `IDLE_AGENT:agent:${builder.id}:rework:${item.item_id}`, since: since(item.item_id), now,
            title: 'returned work waits for its active builder',
            why: `#${item.item_id} was rejected and its last builder ${builder.id} is active in ${builder.lane}`,
            next: `resume #${item.item_id} with pullboard claim ${item.item_id}`, command: `pullboard claim ${item.item_id}`,
            owner: { role: 'builder', who: builder.id }, detail: { lane: builder.lane, route: builder.route, item: item.item_id },
          }));
        }
        return false;
      })
      .filter(item => offered?.item_status === 'open' && item.item_id === offered.item_id)
      .sort(compare);
    if (!ahead.length) continue;
    const first = ahead[0];
    findings.push(finding('RANK_INVERSION', claim, {
      subject: `#${claim.item_id}`, key: `RANK_INVERSION:item:${claim.item_id}`, since: since(claim.item_id), now,
      title: 'a free item ranks ahead',
      why: `${holder.id} claimed #${claim.item_id} while #${first.item_id} ranks ahead in the ${holder.lane} lane and sits free`,
      next: `release #${claim.item_id} with pullboard release ${claim.item_id} --reason ROUTED_ELSEWHERE, then claim #${first.item_id}`,
      command: `pullboard release ${claim.item_id} --reason ROUTED_ELSEWHERE`,
      owner: { role: 'builder', who: holder.id }, detail: { holder: holder.id, ahead: first.item_id },
    }));
  }
  return findings;
}

/**
 * @typedef {{ key: string, cause: string, item: number|null, subject: string, title: string, since: string,
 *   ageMinutes: number, why: string, next: string, command: string|null,
 *   owner: { role: 'builder'|'reviewer'|'coordinator'|'person', who: string|null }, detail: object }} Finding
 */

/**
 * Build one finding in the stable shape docs/api.md documents. Its key names the cause and what is
 * stuck, so a sentinel can post each finding once and notice when it clears.
 *
 * @returns {Finding}
 */
function finding(cause, item, { subject, key, since, now, title, why, next, command = null, owner, detail = {} }) {
  const label = subject ?? `#${item.item_id}`;
  return {
    key: key ?? `${cause}:item:${item.item_id}`, cause, item: item?.item_id ?? null, subject: label, title,
    since, ageMinutes: Math.max(0, Math.floor((now - Date.parse(since)) / 60_000)), why, next, command, owner, detail,
  };
}

/**
 * Say why accepted work has not landed: a hold, a conflict with the trunk (naming its files and its
 * builder), a stacked commit still in review, a dependency not landed yet, or nothing at all.
 */
function unlanded(item, { since, now, trunk, root, byId, stacked }) {
  const id = item.item_id;
  const builder = item.item_built_by;
  if (item.item_hold_reason) {
    const holder = item.item_hold_by ?? COORDINATOR;
    const owner = holder === PERSON ? { role: 'person', who: PERSON } : { role: 'coordinator', who: holder };
    const clears = /conflict/iu.test(item.item_hold_reason) && trunk && conflictFiles(root, trunk.commit, item.item_commit)?.length === 0;
    return finding(clears ? 'CONFLICT_HOLD_CLEARS' : 'UNLANDED_HELD', item, {
      since, now, title: clears ? 'conflict hold now clears' : 'accepted, held',
      why: clears
        ? `accepted and held for a conflict (${firstLine(item.item_hold_reason)}), and ${short(item.item_commit)} now merges cleanly onto ${trunk.name}`
        : `accepted and held by ${holder}: ${firstLine(item.item_hold_reason)}`,
      next: `lift the hold with pullboard hold ${id} --off${clears ? '' : ' once that is settled'}`, command: `pullboard hold ${id} --off`,
      owner, detail: { reason: item.item_hold_reason, by: holder, commit: item.item_commit },
    });
  }
  const files = trunk ? conflictFiles(root, trunk.commit, item.item_commit) : null;
  if (files?.length) {
    return finding('UNLANDED_CONFLICT', item, {
      since, now, title: 'accepted, conflicts with the trunk',
      why: `${short(item.item_commit)} conflicts with ${trunk.name} in ${files.slice(0, 5).join(', ')}${files.length > 5 ? ` and ${files.length - 5} more` : ''}`,
      next: `merge ${trunk.name} into its branch, resolve ${files.length === 1 ? 'that file' : 'those files'}, and shout the coordinator the new head`,
      command: `git merge ${trunk.name}`,
      owner: { role: 'builder', who: builder }, detail: { files, trunk: trunk.name, commit: item.item_commit },
    });
  }
  const parent = trunk && stacked().find((other) => other.item_id !== id
    && tryGit(root, ['merge-base', '--is-ancestor', other.item_commit, item.item_commit]).status === 0
    && tryGit(root, ['merge-base', '--is-ancestor', other.item_commit, trunk.commit]).status !== 0);
  if (parent) {
    const under = byId.get(parent.item_id);
    const inReview = under?.item_status === 'submitted' && under.item_commit === parent.item_commit;
    return finding('UNLANDED_STACKED', item, {
      since, now, title: 'accepted, stacked on unaccepted work',
      why: `it carries #${parent.item_id}'s commit ${short(parent.item_commit)}, which is ${inReview ? 'waiting for its review' : `${under?.item_status ?? 'missing'} and has no accept`}`,
      next: inReview ? `verify #${parent.item_id} with pullboard next --verify ${parent.item_id}`
        : `bring #${parent.item_id} back to review, or rebuild #${id} without it`,
      command: inReview ? `pullboard next --verify ${parent.item_id}` : null,
      owner: inReview ? { role: 'reviewer', who: null } : { role: 'builder', who: under?.item_built_by ?? builder },
      detail: { parent: parent.item_id, commit: parent.item_commit },
    });
  }
  const waits = localDependencyIds(item)
    .filter((other) => byId.get(other) && !byId.get(other).item_merged_commit && byId.get(other).item_status !== 'withdrawn');
  if (waits.length) {
    return finding('UNLANDED_WAITING', item, {
      since, now, title: 'accepted, waits for its dependencies to land',
      why: `it lands after ${waits.map((other) => `#${other}`).join(', ')}, which ${waits.length === 1 ? 'has' : 'have'} not landed`,
      next: `land ${waits.map((other) => `#${other}`).join(', ')} first`, command: null,
      owner: { role: 'coordinator', who: COORDINATOR }, detail: { after: waits },
    });
  }
  return finding('UNLANDED_READY', item, {
    since, now, title: 'accepted, not landed',
    why: trunk ? `${short(item.item_commit)} merges cleanly onto ${trunk.name} and nobody has landed it` : 'nobody has landed it, and the trunk is unknown',
    next: 'land it with pullboard land', command: 'pullboard land',
    owner: { role: 'coordinator', who: COORDINATOR }, detail: { commit: item.item_commit },
  });
}

/**
 * A release past its deadline while landed work waits: the deadline runs from the newest version
 * tag (v1.2.3 or 1.2.3), and the work is every item first recorded merged after that tag.
 */
function releaseOverdue(db, root, now, deadlineMs, history) {
  const tags = tryGit(root, ['for-each-ref', '--sort=-creatordate', '--format=%(refname:short)%09%(creatordate:iso-strict)', 'refs/tags']);
  if (tags.status !== 0 || !tags.stdout) return null;
  const latest = tags.stdout.split('\n').map((line) => line.split('\t')).find(([name]) => /^v?\d+\.\d+\.\d+$/u.test(name ?? ''));
  if (!latest) return null;
  const [tag, dated] = latest;
  const published = Date.parse(dated);
  if (!Number.isFinite(published) || now - published < deadlineMs) return null;
  const landed = [];
  for (const item of db.prepare("SELECT item_id FROM item WHERE item_status = 'verified' AND item_merged_commit IS NOT NULL ORDER BY item_id").all()) {
    const first = history.get(item.item_id)?.firstMerged;
    if (first && Date.parse(first) > published) landed.push(item.item_id);
  }
  if (!landed.length) return null;
  const since = new Date(published).toISOString();
  const listed = landed.slice(0, 5).map((id) => `#${id}`).join(', ') + (landed.length > 5 ? ` and ${landed.length - 5} more` : '');
  return finding('RELEASE_OVERDUE', null, {
    subject: `release ${tag}`, key: `RELEASE_OVERDUE:release:${tag}`, since, now,
    title: 'overdue',
    why: `${landed.length} landed ${landed.length === 1 ? 'item waits' : 'items wait'} for a release since ${tag}: ${listed}`,
    next: `publish the release after ${tag}`, command: null,
    owner: { role: 'coordinator', who: COORDINATOR }, detail: { release: tag, landed },
  });
}

/**
 * Each item's latest event of every kind, its latest lifecycle move and its first merge record.
 *
 * The statement is held for the whole loop and touched after it (#874): Node 22.13's node:sqlite
 * finalizes an unreferenced statement when garbage collection runs mid-iterate, which crashed
 * resume with "statement has been finalized" on a large board. Exported for that regression test.
 */
export function itemHistory(db, itemIds) {
  const history = new Map();
  const statement = db.prepare('SELECT event_id, event_at, event_by, event_kind, item_id, event_detail FROM event WHERE item_id = ? ORDER BY event_id');
  try {
    for (const itemId of itemIds) readItemHistory(statement.iterate(itemId), history);
  }
  finally { keepAlive(statement); }
  return history;
}

/** Keep a value reachable until this call, so no optimizer treats it as dead early. */
function keepAlive(value) {
  if (value === KEEP_ALIVE_SENTINEL) throw new Error('unreachable');
}
const KEEP_ALIVE_SENTINEL = Symbol('keep alive');

/** Fold item events, oldest first, into each item's history entry. */
function readItemHistory(events, history) {
  for (const event of events) {
    let entry = history.get(event.item_id);
    if (!entry) history.set(event.item_id, entry = { last: new Map(), lifecycle: null, firstMerged: null });
    entry.last.set(event.event_kind, event);
    // An escalation after a reject or reopen only re-routes the rework: the rework still waits since the return.
    const reroute = event.event_kind === 'escalate' && ['reject', 'reopen'].includes(entry.lifecycle?.event_kind);
    if (LIFECYCLE.has(event.event_kind) && !reroute) entry.lifecycle = event;
    if (event.event_kind === 'merged' && !entry.firstMerged) entry.firstMerged = event.event_at;
  }
}

/** Decisions to the coordinator or the person, and the person's requests, that nobody has closed. */
function unansweredAsks(db) {
  return db.prepare(`SELECT * FROM shout ask WHERE (
      (ask.shout_decision = 1 AND ask.shout_to IN (?, ?) AND NOT EXISTS (SELECT 1 FROM shout reply WHERE reply.shout_answers = ask.shout_id))
      OR (ask.shout_request = 1 AND NOT EXISTS (SELECT 1 FROM shout reply WHERE reply.shout_answers = ask.shout_id AND reply.shout_request_outcome IN ('done', 'declined'))))
    ORDER BY ask.shout_id`).all(COORDINATOR, PERSON);
}

/** The primary checkout's branch and commit, or the retained trunk's, or null when neither reads. */
function trunkTip(root) {
  let ref;
  try { ref = mainCheckout(root)?.branch ?? trunkRef(root); } catch { return null; /* A repo with no readable trunk skips merge checks. */ }
  if (!ref?.startsWith('refs/heads/')) return null;
  const tip = tryGit(root, ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`]);
  return tip.status === 0 ? { name: ref.replace(/^refs\/heads\//u, ''), commit: tip.stdout } : null;
}

/**
 * The files a commit conflicts in when merged onto the trunk, [] when it merges cleanly, or null
 * when git cannot tell. merge-tree computes the merge in the object store alone.
 */
export function conflictFiles(root, trunk, commit) {
  if (!/^[0-9a-f]{40,64}$/u.test(commit ?? '')) return null;
  return mechanicalConflictFiles(root, trunk, commit);
}

/** The index of the current release, as localReleaseRank counts it: the first with unverified local work. */
function currentRelease(releases) {
  const first = releases.findIndex((release) => release.items.some((entry) => typeof entry.id === 'number' && entry.status !== 'verified'));
  return first < 0 ? 0 : first;
}

/** A reject's reason code in brackets, when it recorded one. */
function rejectReason(event) {
  try {
    const reason = JSON.parse(event.event_detail)?.reason;
    return reason ? ` (${reason})` : '';
  } catch { return ''; /* Legacy details without JSON carry no reason. */ }
}

/** The first line of a text, for one-line output. */
const firstLine = (text) => String(text ?? '').split('\n', 1)[0].trim();

/** A long question cut to one readable line. */
const clip = (text) => (text.length > 120 ? `${text.slice(0, 119).trimEnd()}…` : text);

/** A commit's twelve-character short form. */
const short = (commit) => String(commit ?? '').slice(0, 12);

/** Format a finding's age the way resume does: 45m, 3h, 2d. */
function ageText(minutes) {
  if (minutes < 60) return `${minutes}m`;
  if (minutes < 48 * 60) return `${Math.floor(minutes / 60)}h`;
  return `${Math.floor(minutes / 1440)}d`;
}

/**
 * The report as text: one line per stuck finding with its cause, since when, why, the next step
 * and who takes it; then what waits for a later release. A clear board says nothing is stuck.
 *
 * @param {ReturnType<typeof healthReport>} report
 * @returns {string[]}
 */
export function healthLines(report) {
  const lines = [];
  const line = (entry) => `${entry.subject} ${entry.title}, since ${entry.since.slice(0, 16).replace('T', ' ')} (${ageText(entry.ageMinutes)}): ${sentence(entry.why)} Next, ${ownerText(entry.owner)}: ${entry.next}.`;
  if (!report.stuck.length) lines.push('nothing is stuck');
  else lines.push(`${report.stuck.length} stuck:`, ...report.stuck.map((entry) => `  ${line(entry)}`));
  if (report.waiting.length) lines.push('waiting for a later release:', ...report.waiting.map((entry) => `  ${line(entry)}`));
  for (const row of report.workFreeReleases ?? []) lines.push(`work-free releases ${row.day}: ${row.seat} ${row.reason} ${row.count}`);
  // Seats with nobody behind them get one line, never a finding or a shout (#940).
  if (report.retired?.length) lines.push(`retired seats, not counted as agents (quiet for 30 minutes or more, or their worktree is gone): ${report.retired.map((seat) => seat.agent).join(', ')}`);
  return lines;
}

/**
 * The worktrees of this repository whose folders are gone, as Git reports them (prunable). A path Git never
 * registered here, such as a seat on another computer, is not judged gone by this (#940).
 *
 * @param {string} root
 * @returns {Set<string>}
 */
function goneWorktrees(root) {
  try {
    const listing = execFileSync('git', ['worktree', 'list', '--porcelain'], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    return new Set(listing.split('\n\n').filter((block) => /^prunable\b/mu.test(block)).map((block) => /^worktree (.+)$/mu.exec(block)?.[1]).filter(Boolean));
  } catch { return new Set(); }
}

/** End a reason with one full stop, keeping a clipped reason's ellipsis. */
function sentence(text) {
  const trimmed = text.replace(/[.\s]+$/u, '');
  return trimmed.endsWith('…') ? trimmed : `${trimmed}.`;
}

/** Name who moves a finding next, with their role. */
function ownerText({ role, who }) {
  if (role === 'person') return 'the person';
  if (role === 'coordinator') return who === COORDINATOR ? 'the coordinator' : `${who} (coordinator)`;
  return who ? `${who} (${role})` : `a ${role}`;
}

/**
 * The release flow document for the board: one cause per unlanded item, every idle seat and recent landings, read from board state alone.
 * Why here: the projection in logic/flow.js is pure; this wires it to the real board reads so the command and the view share one reader.
 *
 * @param {any} board - An open board.
 * @param {{ config?: any, release?: string, now?: () => number, refuse?: (code: string, message: string) => Error }} [options]
 * @returns {ReturnType<typeof flowWhy>}
 */
export function releaseFlow(board, { config = {}, release, now = () => board.clock.now().getTime(), refuse } = {}) {
  const policy = config?.verify?.policy ?? 'any';
  const familyPolicy = config?.verify?.family ?? 'off';
  const store = { milestones, lineSettings, listItems, listAgents, landingBatches, laneHold, nextFor };
  const workProgress = (reader) => {
    const at = now();
    const all = listItems(reader, { all: true });
    const byId = new Map(all.map(item => [item.item_id, item]));
    const lastEvent = reader.db.prepare('SELECT MAX(event_at) AS at FROM event WHERE item_id = ?');
    return new Map(all.map(item => {
      const holder = item.item_status === 'claimed' ? item.item_owner : reviewHolder(reader, item);
      const waits = localDependencyIds(item).filter(other => byId.get(other) && !byId.get(other).item_merged_commit && byId.get(other).item_status !== 'withdrawn').map(other => `#${other}`);
      const last = Date.parse(lastEvent.get(item.item_id)?.at ?? '');
      return [item.item_id, { holder: holder ?? null, waits, ...(holder && Number.isFinite(last) ? { idleMinutes: Math.max(0, Math.floor((at - last) / 60_000)), idleBasis: 'event' } : {}) }];
    }));
  };
  const reviewEligibility = (reader, item, options) => {
    const checks = listAgents(reader).map(agent => ({ agent: agent.agent_id, problem: eligibilityProblem(reader, item, agent, options) }));
    return { eligible: checks.filter(row => !row.problem).map(row => row.agent), ineligible: checks.filter(row => row.problem).map(row => ({ agent: row.agent, rule: row.problem.message })) };
  };
  const merged = (reader, sinceIso) => reader.db.prepare("SELECT item_id, event_at FROM event WHERE event_kind = 'merged' AND event_at >= ?").all(sinceIso);
  return flowWhy(board, { store, workProgress, reviewEligibility, now, merged, release, policy, familyPolicy, ...(refuse ? { refuse } : {}) });
}
