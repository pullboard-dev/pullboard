import { mechanicalConflictFiles } from './mechanical-merge.js';
import { localDependencyIds } from './item-dependencies.js';
/**
 * `pullboard health`: every stuck item on the board, why it is stuck, since when, the one next step
 * and who takes it [A6]. Doctor checks a board's integrity; health checks its flow, so nobody has
 * to remember to look for a dead claim, an idle review or accepted work that never landed.
 *
 * It reads the board through a read-only SQLite connection and asks git only questions that leave
 * every checkout alone: merge-tree writes a tree object and never an index or a working tree.
 */
import { execFileSync } from './windows-child-process.js';
import { existsSync } from 'node:fs';
import { missedJobFindings } from './recurring-jobs.js';
import {
  COORDINATOR,
  durationMs,
} from './config.js';
import {
  mainCheckout,
  tryGit,
} from './git.js';
import { gateControlFindings } from './gate-control.js';
import {
  boardBusyError,
  buildOrder,
  canTake,
  listItems,
  openBoardReadOnly,
  PERSON,
  ROUTES,
  roadmap,
  rowDecisions,
  unverifiedSubmissions,
} from './board.js';
import { staleRowDecisions } from './row-decision-state.js';
import { localReleaseRank } from './release-queue.js';
import { workQueue } from './queue.js';
import { trunkRef } from './trusted-policy.js';
import { routeWorkShortages } from './route-capacity.js';
import { readRelayHealth } from './relay-canary-health.js';

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
 * @param {{ root: string, config?: any, now: Date }} options
 * @returns {ReturnType<typeof healthReport>}
 */
export function boardHealth(file, { root, config, now }) {
  if (!existsSync(file)) return healthReport({ db: null, root, config, now });
  const startedAt = Date.now();
  let db;
  try {
    db = openBoardReadOnly(file);
    return healthReport({ db, root, config, now });
  } catch (error) {
    throw boardBusyError(file, startedAt, error);
  } finally {
    db?.close();
  }
}

/**
 * Every stuck finding on an open board connection, and the rework that waits for a later release.
 *
 * @param {{ db: any, root: string, config?: any, now: Date }} options
 * @returns {{ asOf: string, thresholds: { stuck: string, holds: string, release: string }, stuck: Finding[], waiting: Finding[] }}
 */
export function healthReport({ db, root, config, now }) {
  const limits = healthThresholds(config);
  const asOf = now.toISOString();
  const report = { asOf, thresholds: { stuck: limits.stuck, holds: limits.holds, release: limits.release }, stuck: [], waiting: [] };
  // Gate alarms read the git directory, so they report even before a board exists (U41).
  report.stuck.push(...gateControlFindings(root, config ?? {}, now));
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
  if (!db) return report;
  const at = now.getTime();
  const age = (iso) => at - Date.parse(iso);
  const board = { db, clock: { now: () => now } };
  report.stuck.push(...missedJobFindings(board, at));
  for (const stale of staleRowDecisions(rowDecisions(board), root, config)) {
    report.stuck.push(finding('STALE_ROW_DECISION', null, {
      subject: `${stale.kind}:${stale.id}`, key: `STALE_ROW_DECISION:${stale.kind}:${stale.id}`,
      since: stale.at ?? asOf, now: at, title: 'person decision is stale', why: stale.why, next: stale.next,
      owner: { role: 'person', who: PERSON }, detail: { changed: stale.changed },
    }));
  }
  const items = db.prepare('SELECT * FROM item ORDER BY item_id').all();
  const byId = new Map(items.map((item) => [item.item_id, item]));
  const history = itemHistory(db, items.map((item) => item.item_id));
  const trunk = trunkTip(root);
  const releases = roadmap(board);
  const found = (list, finding) => list.push(finding);
  let stacks;
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

    if (status === 'submitted') {
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
      } else if (!reviewer && age(submittedAt) >= limits.ms.stuck) {
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
      if (age(move.event_at) >= limits.ms.stuck) {
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
  const queue = workQueue(board);
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
  const agents = rows.filter((row) => row.lane !== 'coordinator').map((row) => {
    const last = Math.max(...[row.created, row.event_at, row.shout_at].filter(Boolean).map((value) => Date.parse(value)));
    const lease = items.some((item) => (item.item_status === 'claimed' && item.item_owner === row.id && Date.parse(item.item_lease_until ?? '') > at)
      || (item.item_review_by === row.id && Date.parse(item.item_review_until ?? '') > at));
    const awaitsReview = items.some((item) => item.item_status === 'submitted' && item.item_built_by === row.id);
    const recent = !gone.has(row.path) && (lease || at - last < QUEUE_ACTIVE_MS);
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

  for (const shortage of routeWorkShortages(board, waiting, agents)) {
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
  // A lapsed claim is CLAIM_LAPSED's to report; only a live claim can rank behind free work.
  for (const claim of items.filter((item) => item.item_status === 'claimed' && Date.parse(item.item_lease_until ?? '') > at)) {
    const holder = agents.find((agent) => agent.id === claim.item_owner);
    if (!holder) continue;
    // Model exactly the release printed below: legal child or returned claims remain occupied.
    const releasedClaims = [claim.item_id];
    const compare = buildOrder(board, { releasedClaims });
    // Historical hard-collision waits clear only when this one named claim is released (#1114).
    const freeToHolder = (entry) => entry.waits.every((wait) => wait.startsWith(`#${entry.id} waits for #${claim.item_id} (claimed) on `));
    const ahead = open.filter((entry) => freeToHolder(entry) && entry.lane === holder.lane && canTake(holder.route, entry.route))
      .map((entry) => raw.get(entry.id))
      .filter((item) => item && compare(item, claim) < 0)
      .sort(compare);
    if (!ahead.length) continue;
    const first = ahead[0];
    findings.push(finding('RANK_INVERSION', claim, {
      subject: `#${claim.item_id}`, key: `RANK_INVERSION:item:${claim.item_id}`, since: since(claim.item_id), now,
      title: 'a free item ranks ahead',
      why: `${holder.id} claimed #${claim.item_id} while #${first.item_id} ranks ahead in the ${holder.lane} lane and sits free`,
      next: `release #${claim.item_id} with pullboard release ${claim.item_id}, then claim #${first.item_id}`,
      command: `pullboard release ${claim.item_id}`,
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
    if (LIFECYCLE.has(event.event_kind)) entry.lifecycle = event;
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
